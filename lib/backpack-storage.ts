// lib/backpack-storage.ts
// 原生背包 · 存储层
//
// 数据落在 kv-db（IndexedDB）的 backpack_items_v1，是全量物品的单一事实来源。
// 聊天消息里的卡片只是展示；卡片被删、聊天记录被清，物品一件不少。
//
// ⚠ 依赖约束：本模块**不允许** import chat-storage / shopping-gift-utils。
// 那两个模块（直接或间接）依赖背包标记，反向 import 会形成循环：
//   chat-storage → backpack-markers → backpack-storage → chat-storage
// 需要读会话/订单的一次性迁移放在 lib/backpack-legacy.ts，由它在启动时注册，
// 本模块只负责调用注册进来的 runner。

import { isKvHydrated, kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadCharacters } from "./character-storage";
import { recordConsumedUnit } from "./backpack-consumed";
import {
    BACKPACK_CHANGED_EVENT,
    type BackpackItem,
    type BackpackRecipient,
    type BackpackShoppingOrigin,
    type BackpackTarget,
    type BackpackTransferTargets,
} from "./backpack-types";

const ITEMS_KEY = "backpack_items_v1";
const TARGETS_KEY = "backpack_transfer_targets_v1";
const MIGRATION_KEY = "backpack_migration_v1";

registerKvMigration(ITEMS_KEY);
registerKvMigration(TARGETS_KEY);
registerKvMigration(MIGRATION_KEY);

/**
 * 当前迁移脚本版本；加新迁移时 +1 并同步 lib/backpack-legacy.ts。
 *
 * v4：修复 v3 的致命时序 bug —— 迁移曾在 kv 水合完成前就跑，读到空数据
 * 却把版本记成 3，导致老插件数据永远搬不过来。升版本号让受影响用户重跑，
 * 各步骤本身都有去重、可重复执行。
 */
export const BACKPACK_MIGRATION_VERSION = 4;

export type BackpackMigrationState = {
    version: number;
    pluginItems: number;
    shoppingItems: number;
    at: string;
};

// ── 基础读写 ───────────────────────────────────────────────

let itemsCache: BackpackItem[] | null = null;

function isValidItem(raw: unknown): raw is Record<string, unknown> {
    if (!raw || typeof raw !== "object") return false;
    const it = raw as { id?: unknown };
    return typeof it.id === "string" && it.id.length > 0;
}

function toStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeItem(raw: Record<string, unknown>): BackpackItem {
    const recipient: BackpackRecipient = raw.recipient === "character" ? "character" : "user";
    return {
        id: String(raw.id),
        title: String(raw.title ?? ""),
        source: String(raw.source ?? ""),
        value: String(raw.value ?? "--"),
        date: String(raw.date ?? ""),
        note: String(raw.note ?? ""),
        customImage: typeof raw.customImage === "string" ? raw.customImage : "",
        previewIcon: typeof raw.previewIcon === "string" ? raw.previewIcon : undefined,
        tone: typeof raw.tone === "string" ? raw.tone as BackpackItem["tone"] : undefined,
        recipient,
        characterId: typeof raw.characterId === "string" ? raw.characterId : "",
        injected: raw.injected === true,
        visibleTo: toStringArray(raw.visibleTo),
        isManual: raw.isManual === true,
        isRoleAdded: raw.isRoleAdded === true,
        userEdited: raw.userEdited === true,
        timestamp: Number.isFinite(raw.timestamp) ? Number(raw.timestamp) : Date.now(),
        shopping: raw.shopping && typeof raw.shopping === "object"
            ? raw.shopping as BackpackShoppingOrigin
            : undefined,
        // 迁移前的老数据把归属记在会话上，保留给 lib/backpack-legacy.ts 读取
        legacySessionId: typeof raw.legacySessionId === "string"
            ? raw.legacySessionId
            : (typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : undefined),
    };
}

function readItemsRaw(): BackpackItem[] {
    if (itemsCache) return itemsCache;
    const raw = kvGet(ITEMS_KEY);
    if (!raw) {
        // kv 还没水合完时读到的是「空」，此时不能把空数组固化成缓存——
        // 否则水合完成后仍会一直读到空列表。未水合就返回临时空数组，不写缓存。
        if (!isKvHydrated()) return [];
        itemsCache = [];
        return itemsCache;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        itemsCache = Array.isArray(parsed)
            ? parsed.filter(isValidItem).map(item => normalizeItem(item as Record<string, unknown>))
            : [];
    } catch {
        itemsCache = [];
    }
    return itemsCache;
}

function dedupeById(items: BackpackItem[]): BackpackItem[] {
    const map = new Map<string, BackpackItem>();
    for (const it of items) {
        const prev = map.get(it.id);
        map.set(it.id, prev ? { ...prev, ...it } : it);
    }
    return [...map.values()];
}

/**
 * 变更广播合并：一次用户操作可能连着改几处（删物品 + 存白名单），
 * 多个事件合成一个微任务再发，避免界面被重复刷新。
 */
let emitScheduled = false;

function emitChanged() {
    if (emitScheduled) return;
    emitScheduled = true;
    const fire = () => {
        emitScheduled = false;
        if (typeof window === "undefined") return;
        window.dispatchEvent(new CustomEvent(BACKPACK_CHANGED_EVENT));
    };
    if (typeof queueMicrotask === "function") queueMicrotask(fire);
    else setTimeout(fire, 0);
}

/**
 * 持久化合并。
 * 物品里可能带自定义图标的 data URL（单张上限 250KB，总量 3MB），
 * 每次改动都全量 JSON.stringify + 写 IndexedDB 会明显卡顿——
 * 批量删除/注入时尤其明显。这里合并成一次写，内存缓存始终是最新的，
 * 读路径不受影响；页面隐藏/卸载时立即落盘。
 */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersist = false;

function flushPersist(): void {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    if (!pendingPersist || !itemsCache) return;
    pendingPersist = false;
    kvSet(ITEMS_KEY, JSON.stringify(itemsCache));
}

function schedulePersist(): void {
    pendingPersist = true;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        flushPersist();
    }, 250);
}

function writeItems(items: BackpackItem[]) {
    const deduped = dedupeById(items).sort((a, b) => b.timestamp - a.timestamp);
    itemsCache = deduped;
    schedulePersist();
    emitChanged();
}

if (typeof window !== "undefined") {
    // 离开页面/切后台时把待写的数据落盘，避免防抖窗口内丢改动
    window.addEventListener("pagehide", flushPersist);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushPersist();
    });
}

/** 读取全部物品（首次调用会尝试跑一遍迁移） */
export function loadBackpackItems(): BackpackItem[] {
    ensureBackpackMigrated();
    return readItemsRaw().slice();
}

/** 原地修改物品列表。回调返回新数组或直接改传进来的数组都行 */
export function mutateBackpackItems(fn: (items: BackpackItem[]) => BackpackItem[] | void): BackpackItem[] {
    ensureBackpackMigrated();
    const current = readItemsRaw().slice();
    const next = fn(current);
    const result = next ?? current;
    writeItems(result);
    return result;
}

export function getBackpackItem(id: string): BackpackItem | null {
    ensureBackpackMigrated();
    return readItemsRaw().find(it => it.id === id) ?? null;
}

export function updateBackpackItem(id: string, patch: Partial<BackpackItem>): void {
    mutateBackpackItems(items => {
        const idx = items.findIndex(it => it.id === id);
        if (idx < 0) return;
        items[idx] = { ...items[idx], ...patch, id };
    });
}

/**
 * 删除背包物品。
 *
 * 购物来源的物品被删掉时要记进处置台账：东西已经不在手上了，
 * 那笔订单就不该再允许申请售后。没有这条记录的话，用户「送出→删掉」
 * 之后还能原价退款，等于钱货两空。
 */
export function removeBackpackItems(ids: string[]): void {
    const set = new Set(ids);
    if (set.size === 0) return;
    let removed: BackpackItem[] = [];
    mutateBackpackItems(items => {
        removed = items.filter(it => set.has(it.id));
        return items.filter(it => !set.has(it.id));
    });
    for (const item of removed) recordConsumedUnit(item.shopping);
}

export function createManualBackpackItem(input: {
    title: string;
    source?: string;
    value?: string;
    date?: string;
    note?: string;
    customImage?: string;
    recipient: BackpackRecipient;
    characterId?: string;
}): BackpackItem {
    const now = Date.now();
    const item: BackpackItem = {
        id: `bp_${now}_${Math.random().toString(36).slice(2, 8)}`,
        title: input.title,
        source: input.source?.trim() || "未标注",
        value: input.value?.trim() || "--",
        date: input.date?.trim() || formatBackpackTime(now),
        note: input.note ?? "",
        customImage: input.customImage ?? "",
        recipient: input.recipient,
        characterId: input.recipient === "character" ? (input.characterId ?? "") : "",
        injected: input.recipient === "character",
        visibleTo: [],
        isManual: true,
        isRoleAdded: false,
        userEdited: true,
        timestamp: now,
    };
    mutateBackpackItems(items => {
        items.unshift(item);
    });
    return item;
}

// ── 时间格式 ───────────────────────────────────────────────

export function formatBackpackTime(input: number | Date): string {
    const d = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(d.getTime())) return "近期";
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${mm}/${dd} ${hh}:${min}`;
}

/** 把 "09/12 14:30" 解析回时间戳，跨年做保护；解析不出来返回 0 */
export function parseBackpackTime(text: string): number {
    const m = String(text ?? "").trim()
        .match(/^(\d{1,2})[/\-月](\d{1,2})日?\s*(\d{1,2})[:：](\d{1,2})/);
    if (!m) return 0;
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    const hh = Number(m[3]);
    const min = Number(m[4]);
    if (month < 0 || month > 11 || day < 1 || day > 31 || hh > 23 || min > 59) return 0;
    const now = new Date();
    let year = now.getFullYear();
    if (month - now.getMonth() > 6) year -= 1;
    const t = new Date(year, month, day, hh, min).getTime();
    if (Number.isNaN(t)) return 0;
    if (t > now.getTime() + 365 * 86400 * 1000) {
        return new Date(year - 1, month, day, hh, min).getTime();
    }
    return t;
}

// ── 角色解析 ───────────────────────────────────────────────

export function resolveCharacterName(characterId?: string): string {
    if (!characterId) return "";
    try {
        const char = loadCharacters().find(c => c.id === characterId);
        return char?.name ? String(char.name) : "";
    } catch {
        return "";
    }
}

function normalizeName(value: string): string {
    return String(value || "")
        .trim()
        .replace(/[【】\[\]「」『』（）()《》\s]/g, "")
        .replace(/的背包$/, "")
        .toLowerCase();
}

/** 按名字找角色 id：先精确，再忽略括号空格的近似匹配 */
export function resolveCharacterIdByName(name: string): string | null {
    const raw = String(name || "").trim();
    if (!raw) return null;
    let characters;
    try {
        characters = loadCharacters();
    } catch {
        return null;
    }
    const exact = characters.find(c => c.name === raw);
    if (exact) return exact.id;
    const norm = normalizeName(raw);
    if (!norm) return null;
    const loose = characters.find(c => normalizeName(String(c.name ?? "")) === norm);
    if (loose) return loose.id;
    const partial = characters.find(c => {
        const n = normalizeName(String(c.name ?? ""));
        return n.length >= 2 && (n.includes(norm) || norm.includes(n));
    });
    return partial ? partial.id : null;
}

// ── 背包目标（我的背包 + 每个角色一个，不含群聊） ──────────

/**
 * 目标列表缓存。
 * loadBackpackTargets() 每次都要遍历角色并构造对象数组，而界面（弹窗刷新、
 * 每次背包变化）会频繁调用它。角色表本身由 loadCharacters() 维护内存缓存，
 * saveCharacters 时会生成新数组引用——同时核对 targetsSourceChars 引用，
 * 角色增删改名后即使未手动清缓存也会自动重建。
 */
let targetsListCache: BackpackTarget[] | null = null;
let targetsSourceChars: unknown = null;

/** 角色表变动后由 UI / 存储层调用（角色增删时） */
export function invalidateBackpackTargetsCache(): void {
    targetsListCache = null;
    targetsSourceChars = null;
}

export function loadBackpackTargets(): BackpackTarget[] {
    let chars: ReturnType<typeof loadCharacters> = [];
    try {
        chars = loadCharacters();
    } catch {
        /* 角色读不出来就只留我的背包 */
    }
    if (targetsListCache && targetsSourceChars === chars) return targetsListCache;
    const targets: BackpackTarget[] = [{
        id: "user",
        name: "我的背包",
        rawName: "我的背包",
        isUser: true,
    }];
    for (const char of chars) {
        if (!char?.id) continue;
        const name = String(char.name ?? "").trim() || "角色";
        targets.push({
            id: char.id,
            name: `【${name}】的背包`,
            rawName: name,
            isUser: false,
            characterId: char.id,
        });
    }
    targetsListCache = targets;
    targetsSourceChars = chars;
    return targets;
}

/** 只要角色目标（用于「送给…」与标题选择弹窗） */
export function loadCharacterTargets(excludeCharacterId?: string): BackpackTarget[] {
    return loadBackpackTargets().filter(t =>
        !t.isUser && (!excludeCharacterId || t.characterId !== excludeCharacterId));
}

export function findBackpackTarget(targetId: string): BackpackTarget | null {
    return loadBackpackTargets().find(t => t.id === targetId) ?? null;
}

/** 按归属筛选：targetId 为 "user" 或角色 id */
export function filterBackpackItems(items: BackpackItem[], targetId: string): BackpackItem[] {
    if (targetId === "user") return items.filter(it => it.recipient === "user");
    return items.filter(it => it.recipient === "character" && it.characterId === targetId);
}

// ── 转送白名单 ─────────────────────────────────────────────

let targetsConfigCache: BackpackTransferTargets | null = null;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function loadTransferTargets(): BackpackTransferTargets {
    if (targetsConfigCache) return targetsConfigCache;
    const raw = kvGet(TARGETS_KEY);
    const result: BackpackTransferTargets = Object.create(null);
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                    if (UNSAFE_KEYS.has(key)) continue;
                    if (Array.isArray(value)) result[key] = value.map(String);
                }
            }
        } catch {
            /* 坏数据当作没有配置 */
        }
    }
    targetsConfigCache = result;
    return result;
}

export function saveTransferTargets(config: BackpackTransferTargets): void {
    targetsConfigCache = config;
    kvSet(TARGETS_KEY, JSON.stringify(config));
    emitChanged();
}

/** 某来源允许放入的角色 id 集合；没有显式配置时默认全部角色 */
export function getEnabledTargetIdsForSource(sourceId: string): Set<string> {
    const config = loadTransferTargets();
    const key = String(sourceId || "");
    if (!UNSAFE_KEYS.has(key) && Array.isArray(config[key])) {
        return new Set(config[key].map(String));
    }
    const set = new Set<string>();
    for (const t of loadCharacterTargets(key)) {
        if (t.characterId) set.add(t.characterId);
    }
    return set;
}

// ── 移动 ───────────────────────────────────────────────────

/**
 * 按订单清掉背包里属于该订单的物品（退款时用）。
 * 只清「我的背包」里的：角色手上那部分退款本来就会被拦下，
 * 真清到角色背包反而会凭空少东西。
 * 返回清掉的件数。
 */
export function removeBackpackItemsByOrder(orderId: string): number {
    if (!orderId) return 0;
    let removedCount = 0;
    mutateBackpackItems(items => {
        const remain: BackpackItem[] = [];
        for (const item of items) {
            const belongsToOrder = item.shopping?.orderId === orderId;
            if (belongsToOrder && item.recipient === "user") {
                removedCount += 1;
                continue;
            }
            remain.push(item);
        }
        return removedCount > 0 ? remain : undefined;
    });
    return removedCount;
}

/**
 * 把物品放到另一个目标：targetId 为 "user" 或角色 id。
 * 返回更新后的物品；目标不存在返回 null。
 */
export function moveBackpackItem(itemId: string, targetId: string): BackpackItem | null {
    const target = findBackpackTarget(targetId);
    if (!target) return null;

    let updated: BackpackItem | null = null;
    mutateBackpackItems(items => {
        const idx = items.findIndex(it => it.id === itemId);
        if (idx < 0) return;
        const prev = items[idx];
        const isUserTarget = target.isUser;
        const next: BackpackItem = {
            ...prev,
            recipient: isUserTarget ? "user" : "character",
            characterId: isUserTarget ? "" : (target.characterId ?? ""),
            visibleTo: [],
            injected: !isUserTarget,
            timestamp: Date.now(),
        };
        items[idx] = next;
        updated = next;
        // 从「我的背包」转给角色 = 这件商品已经送出去了，记账
        if (prev.recipient === "user" && !isUserTarget) {
            recordConsumedUnit(prev.shopping);
        }
    });
    return updated;
}

// ── 迁移调度 ───────────────────────────────────────────────

/**
 * 一次性迁移的 runner，由 lib/backpack-legacy.ts 在启动时注册。
 * 放在这里是为了让本模块不依赖 chat-storage / shopping-gift-utils（见文件头说明）。
 */
type MigrationRunner = (fromVersion: number) => { pluginItems: number; shoppingItems: number } | void;

let migrationRunner: MigrationRunner | null = null;
let migrated = false;

export function registerBackpackMigrationRunner(runner: MigrationRunner): void {
    migrationRunner = runner;
}

export function readBackpackMigrationState(): BackpackMigrationState {
    const raw = kvGet(MIGRATION_KEY);
    if (!raw) return { version: 0, pluginItems: 0, shoppingItems: 0, at: "" };
    try {
        const parsed = JSON.parse(raw) as Partial<BackpackMigrationState>;
        return {
            version: Number(parsed.version) || 0,
            pluginItems: Number(parsed.pluginItems) || 0,
            shoppingItems: Number(parsed.shoppingItems) || 0,
            at: String(parsed.at ?? ""),
        };
    } catch {
        return { version: 0, pluginItems: 0, shoppingItems: 0, at: "" };
    }
}

export function writeBackpackMigrationState(state: BackpackMigrationState): void {
    kvSet(MIGRATION_KEY, JSON.stringify(state));
}

/**
 * 首次读背包时尝试跑迁移。runner 还没注册就跳过（下次读会再来一次），
 * 不会把「没迁移」误记成「已迁移」。
 */
export function ensureBackpackMigrated(): void {
    if (migrated) return;

    // 关键：kv 还没从 IndexedDB 水合完时，所有 kvGet 都返回 null。
    // 这时跑迁移会「读到空数据 → 什么都没搬 → 却把版本写成最新」，
    // 等于把迁移永久标记成已完成，老数据再也进不来。
    // 所以未水合时直接返回，且绝不写版本标记。
    if (!isKvHydrated()) return;

    const state = readBackpackMigrationState();
    if (state.version >= BACKPACK_MIGRATION_VERSION) {
        migrated = true;
        return;
    }
    if (!migrationRunner) return;

    try {
        const result = migrationRunner(state.version);
        writeBackpackMigrationState({
            version: BACKPACK_MIGRATION_VERSION,
            pluginItems: result?.pluginItems ?? state.pluginItems,
            shoppingItems: result?.shoppingItems ?? state.shoppingItems,
            at: new Date().toISOString(),
        });
        migrated = true;
    } catch (e) {
        // 留在未迁移状态，下次读背包再试；已写入的部分物品不会重复（有去重）
        console.warn("[backpack] 迁移失败，保留原数据下次重试", e);
    }
}

/** 测试 / 「重新扫描」：重置标记让迁移（及其去重逻辑）再跑一次 */
export function resetBackpackMigrationFlag(): void {
    migrated = false;
}

/** 迁移脚本内部用：直接拿到物品并写回，不触发迁移递归 */
export function readBackpackItemsForMigration(): BackpackItem[] {
    return readItemsRaw().slice();
}

export function writeBackpackItemsFromMigration(items: BackpackItem[]): void {
    writeItems(items);
}
