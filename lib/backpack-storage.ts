// lib/backpack-storage.ts
// 原生背包 · 存储层与迁移
//
// 数据落在 kv-db（IndexedDB）的 backpack_items_v1，是全量物品的单一事实来源。
// 聊天消息里的卡片只是展示；卡片被删、聊天记录被清，物品一件不少。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadChatSessions, type ChatSession } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { loadDeliveredShoppingGifts } from "./shopping-gift-utils";
import {
    BACKPACK_CHANGED_EVENT,
    type BackpackItem,
    type BackpackRecipient,
    type BackpackShoppingOrigin,
    type BackpackTransferTarget,
    type BackpackTransferTargets,
} from "./backpack-types";

const ITEMS_KEY = "backpack_items_v1";
const TARGETS_KEY = "backpack_transfer_targets_v1";
const MIGRATION_KEY = "backpack_migration_v1";

/** 老插件的数据桶。迁移只读不写，卸载插件前用户可以自行确认 */
const LEGACY_PLUGIN_BUCKET = "chat_plugin_data_v1:gift-backpack";
const LEGACY_PLUGIN_ITEMS = "backpack_gifts_v1";
const LEGACY_PLUGIN_TARGETS = "backpack_transfer_targets_v2";

registerKvMigration(ITEMS_KEY);
registerKvMigration(TARGETS_KEY);
registerKvMigration(MIGRATION_KEY);

/** 当前迁移脚本版本；加新迁移时 +1 并在 runMigrations 里追加分支 */
const MIGRATION_VERSION = 2;

type MigrationState = {
    version: number;
    pluginItems: number;
    shoppingItems: number;
    at: string;
};

function emitChanged() {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(BACKPACK_CHANGED_EVENT));
}

// ── 基础读写 ───────────────────────────────────────────────

let itemsCache: BackpackItem[] | null = null;

function isValidItem(raw: unknown): raw is BackpackItem {
    if (!raw || typeof raw !== "object") return false;
    const it = raw as Partial<BackpackItem>;
    return typeof it.id === "string" && it.id.length > 0;
}

function normalizeItem(raw: BackpackItem): BackpackItem {
    const recipient: BackpackRecipient =
        raw.recipient === "character" || raw.recipient === "group" ? raw.recipient : "user";
    return {
        id: String(raw.id),
        title: String(raw.title ?? ""),
        source: String(raw.source ?? ""),
        value: String(raw.value ?? "--"),
        date: String(raw.date ?? ""),
        note: String(raw.note ?? ""),
        customImage: typeof raw.customImage === "string" ? raw.customImage : "",
        previewIcon: typeof raw.previewIcon === "string" ? raw.previewIcon : undefined,
        tone: raw.tone,
        recipient,
        sessionId: recipient === "user" ? String(raw.sessionId ?? "") : String(raw.sessionId ?? ""),
        injected: raw.injected === true,
        visibleTo: Array.isArray(raw.visibleTo) ? raw.visibleTo.map(String).filter(Boolean) : [],
        isManual: raw.isManual === true,
        isRoleAdded: raw.isRoleAdded === true,
        userEdited: raw.userEdited === true,
        timestamp: Number.isFinite(raw.timestamp) ? Number(raw.timestamp) : Date.now(),
        giver: typeof raw.giver === "string" ? raw.giver : undefined,
        giverRole: raw.giverRole === "user" || raw.giverRole === "assistant" ? raw.giverRole : undefined,
        shopping: raw.shopping && typeof raw.shopping === "object" ? raw.shopping : undefined,
    };
}

function readItemsRaw(): BackpackItem[] {
    if (itemsCache) return itemsCache;
    const raw = kvGet(ITEMS_KEY);
    if (!raw) {
        itemsCache = [];
        return itemsCache;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        itemsCache = Array.isArray(parsed) ? parsed.filter(isValidItem).map(normalizeItem) : [];
    } catch {
        itemsCache = [];
    }
    return itemsCache;
}

function writeItems(items: BackpackItem[]) {
    const deduped = dedupeById(items).sort((a, b) => b.timestamp - a.timestamp);
    itemsCache = deduped;
    kvSet(ITEMS_KEY, JSON.stringify(deduped));
    emitChanged();
}

function dedupeById(items: BackpackItem[]): BackpackItem[] {
    const map = new Map<string, BackpackItem>();
    for (const it of items) {
        const prev = map.get(it.id);
        map.set(it.id, prev ? { ...prev, ...it } : it);
    }
    return [...map.values()];
}

/** 读取全部物品（首次调用会跑一遍迁移） */
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

export function removeBackpackItems(ids: string[]): void {
    const set = new Set(ids);
    if (set.size === 0) return;
    mutateBackpackItems(items => items.filter(it => !set.has(it.id)));
}

export function createManualBackpackItem(input: {
    title: string;
    source?: string;
    value?: string;
    date?: string;
    note?: string;
    customImage?: string;
    recipient: BackpackRecipient;
    sessionId?: string;
    giver?: string;
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
        sessionId: input.recipient === "user" ? "" : (input.sessionId ?? ""),
        injected: input.recipient === "character",
        visibleTo: [],
        isManual: true,
        isRoleAdded: false,
        userEdited: true,
        timestamp: now,
    };
    if (input.recipient === "group") {
        item.giver = input.giver || "用户";
        item.giverRole = "user";
    }
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

// ── 会话 / 角色名称解析 ────────────────────────────────────

function resolveCharacterNameById(characterId?: string): string {
    if (!characterId) return "";
    try {
        const char = loadCharacters().find(c => c.id === characterId);
        return char?.name ? String(char.name) : "";
    } catch {
        return "";
    }
}

export function resolveGroupName(session: ChatSession): string {
    if (!session) return "群聊";
    const direct = (session as unknown as { groupName?: string }).groupName;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const alias = session.alias;
    if (typeof alias === "string" && alias.trim()) return alias.trim();
    const ids = Array.isArray(session.participantIds) ? session.participantIds : [];
    const names = ids.map(resolveCharacterNameById).filter(Boolean);
    if (names.length > 0) return names.slice(0, 3).join("、");
    return "群聊";
}

/** 会话 id → 角色名 / 群名 */
export function resolveSessionDisplayName(sessionId: string): string {
    if (!sessionId) return "";
    try {
        const session = loadChatSessions().find(s => s.id === sessionId);
        if (!session) return "";
        if (session.isGroup) return resolveGroupName(session);
        return resolveCharacterNameById(session.contactId) || "角色";
    } catch {
        return "";
    }
}

export function isGroupSessionId(sessionId: string): boolean {
    if (!sessionId) return false;
    try {
        return loadChatSessions().find(s => s.id === sessionId)?.isGroup === true;
    } catch {
        return false;
    }
}

// ── 背包目标（我的背包 + 每个会话一个） ─────────────────────

export function loadBackpackTargets(): BackpackTransferTarget[] {
    const targets: BackpackTransferTarget[] = [{
        id: "user",
        name: "我的背包",
        rawName: "我的背包",
        isUser: true,
        isGroup: false,
    }];
    try {
        for (const session of loadChatSessions()) {
            if (!session?.id) continue;
            const isGroup = session.isGroup === true;
            const rawName = isGroup
                ? resolveGroupName(session)
                : (resolveCharacterNameById(session.contactId) || "角色");
            targets.push({
                id: session.id,
                name: isGroup ? `【${rawName}】的礼物堆` : `【${rawName}】的背包`,
                rawName,
                isUser: false,
                isGroup,
                sessionId: session.id,
            });
        }
    } catch {
        /* 会话读不出来就只留我的背包 */
    }
    return targets;
}

/** 排除用户与群之后的角色目标，用于「送给…」弹窗 */
export function loadCharacterBackpackTargets(excludeSessionId?: string): BackpackTransferTarget[] {
    return loadBackpackTargets().filter(t =>
        !t.isUser && !t.isGroup && (!excludeSessionId || t.id !== excludeSessionId));
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

/** 某来源允许放入的目标 id 集合；没有显式配置时默认全部角色（不含群） */
export function getEnabledTargetIdsForSource(sourceId: string): Set<string> {
    const config = loadTransferTargets();
    const key = String(sourceId || "");
    if (!UNSAFE_KEYS.has(key) && Array.isArray(config[key])) {
        return new Set(config[key].map(String));
    }
    const all = loadBackpackTargets();
    const set = new Set<string>();
    for (const t of all) {
        if (t.isUser || t.isGroup) continue;
        if (t.id === key) continue;
        set.add(t.id);
    }
    return set;
}

// ── 转送 ───────────────────────────────────────────────────

/**
 * 把物品放进另一个目标。
 * targetId 为 "user" 放进我的背包；为群会话放进群礼物堆；否则放进该角色背包。
 */
export function transferBackpackItem(itemId: string, targetId: string, actorName = "用户"): BackpackItem | null {
    const target = loadBackpackTargets().find(t => t.id === targetId);
    if (!target) return null;

    let updated: BackpackItem | null = null;
    mutateBackpackItems(items => {
        const idx = items.findIndex(it => it.id === itemId);
        if (idx < 0) return;
        const prev = items[idx];
        const next: BackpackItem = {
            ...prev,
            recipient: target.isUser ? "user" : (target.isGroup ? "group" : "character"),
            sessionId: target.isUser ? "" : targetId,
            visibleTo: [],
            timestamp: Date.now(),
        };
        if (target.isGroup) {
            next.giver = actorName;
            next.giverRole = "user";
        } else {
            delete next.giver;
            delete next.giverRole;
        }
        if (next.recipient === "user") {
            next.injected = false;
        } else if (next.recipient === "group") {
            next.injected = false;
        }
        items[idx] = next;
        updated = next;
    });
    return updated;
}

/** 按 id 前缀 / 归属筛选 */
export function filterBackpackItems(items: BackpackItem[], targetId: string): BackpackItem[] {
    if (targetId === "user") {
        return items.filter(it => it.recipient === "user");
    }
    if (isGroupSessionId(targetId)) {
        return items.filter(it => it.recipient === "group" && it.sessionId === targetId);
    }
    return items.filter(it => it.recipient === "character" && it.sessionId === targetId);
}

// ── 迁移 ───────────────────────────────────────────────────

let migrated = false;

function readMigrationState(): MigrationState {
    const raw = kvGet(MIGRATION_KEY);
    if (!raw) return { version: 0, pluginItems: 0, shoppingItems: 0, at: "" };
    try {
        const parsed = JSON.parse(raw) as Partial<MigrationState>;
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

function writeMigrationState(state: MigrationState): void {
    kvSet(MIGRATION_KEY, JSON.stringify(state));
}

/**
 * 从老插件的数据桶里把物品搬过来。
 * 桶结构：{ backpack_gifts_v1: BackpackItem[], backpack_transfer_targets_v2: {...} }
 * 只读，不删除，万一迁移逻辑有问题还能回退。
 */
function importLegacyPluginData(): number {
    const raw = kvGet(LEGACY_PLUGIN_BUCKET);
    if (!raw) return 0;

    let bucket: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
        bucket = parsed as Record<string, unknown>;
    } catch {
        return 0;
    }

    const legacyItems = bucket[LEGACY_PLUGIN_ITEMS];
    if (!Array.isArray(legacyItems)) return 0;

    const existing = new Set(readItemsRaw().map(it => it.id));
    const incoming: BackpackItem[] = [];
    for (const rawItem of legacyItems) {
        if (!isValidItem(rawItem)) continue;
        const item = normalizeItem(rawItem as BackpackItem);
        if (existing.has(item.id)) continue;
        // 老物品没有订单来源信息，标记为可自由编辑
        existing.add(item.id);
        incoming.push(item);
    }

    if (incoming.length > 0) {
        mutateBackpackItems(items => {
            items.push(...incoming);
        });
    }

    // 转送白名单同样接管，否则用户的转送配置会退回默认
    const legacyTargets = bucket[LEGACY_PLUGIN_TARGETS];
    if (legacyTargets && typeof legacyTargets === "object" && !Array.isArray(legacyTargets)) {
        const current = loadTransferTargets();
        if (Object.keys(current).length === 0) {
            const next: BackpackTransferTargets = Object.create(null);
            for (const [key, value] of Object.entries(legacyTargets as Record<string, unknown>)) {
                if (UNSAFE_KEYS.has(key)) continue;
                if (Array.isArray(value)) next[key] = value.map(String);
            }
            if (Object.keys(next).length > 0) saveTransferTargets(next);
        }
    }

    return incoming.length;
}

/**
 * 把购物订单里已到货的商品全量搬进「我的背包」。
 * 来源（店铺名）、购买时间、详情由订单锁定，界面上不可改。
 */
function importShoppingOrders(): number {
    let candidates;
    try {
        candidates = loadDeliveredShoppingGifts({ includeSent: true });
    } catch {
        return 0;
    }
    if (!Array.isArray(candidates) || candidates.length === 0) return 0;

    const existing = readItemsRaw();
    const bySignature = new Set(
        existing
            .filter(it => it.recipient === "user")
            .map(it => `${it.title}::${it.source}`),
    );
    const byOrigin = new Set(
        existing
            .map(it => it.shopping)
            .filter((s): s is BackpackShoppingOrigin => !!s)
            .map(s => `${s.orderId}::${s.itemId}::${s.unitIndex}`),
    );

    // 已经在别处的同一件商品（老插件从礼物卡片扫到的、已经送出去的那件）：
    // 它属于角色，不该再进「我的背包」变成重复的一份
    const ownedElsewhere = new Set(
        existing
            .filter(it => it.recipient !== "user")
            .map(it => `${it.title}::${it.source}`),
    );

    const incoming: BackpackItem[] = [];
    for (const candidate of candidates) {
        const originKey = `${candidate.orderId}::${candidate.itemId}::${candidate.unitIndex}`;
        if (byOrigin.has(originKey)) continue;
        // 插件可能已经从卡片里扫到过同一件商品，避免重复入包
        if (bySignature.has(`${candidate.productName}::${candidate.merchantLabel}`)) continue;
        if (ownedElsewhere.has(`${candidate.productName}::${candidate.merchantLabel}`)) continue;

        const deliveredMs = candidate.deliveredAt ? new Date(candidate.deliveredAt).getTime() : 0;
        const timestamp = Number.isFinite(deliveredMs) && deliveredMs > 0 ? deliveredMs : Date.now();

        byOrigin.add(originKey);
        incoming.push({
            id: `shop_${originKey.replace(/::/g, "_")}`,
            title: candidate.productName,
            source: candidate.merchantLabel,
            value: candidate.priceLabel || "--",
            date: formatBackpackTime(timestamp),
            note: "",
            customImage: "",
            previewIcon: candidate.previewIcon,
            tone: candidate.tone,
            recipient: "user",
            sessionId: "",
            injected: false,
            visibleTo: [],
            isManual: false,
            isRoleAdded: false,
            userEdited: false,
            timestamp,
            shopping: {
                orderId: candidate.orderId,
                itemId: candidate.itemId,
                unitIndex: candidate.unitIndex,
                merchantLabel: candidate.merchantLabel,
                priceLabel: candidate.priceLabel,
                detail: candidate.detail,
                previewIcon: candidate.previewIcon,
                tone: candidate.tone,
                deliveredAt: candidate.deliveredAt,
            },
        });
    }

    if (incoming.length > 0) {
        mutateBackpackItems(items => {
            items.push(...incoming);
        });
    }
    return incoming.length;
}

/** 首次读背包时跑一次迁移；标记写入后不再重复 */
export function ensureBackpackMigrated(): void {
    if (migrated) return;
    migrated = true;
    const state = readMigrationState();
    if (state.version >= MIGRATION_VERSION) return;

    let pluginItems = state.pluginItems;
    let shoppingItems = state.shoppingItems;
    try {
        if (state.version < 1) {
            pluginItems = importLegacyPluginData();
        }
        if (state.version < 2) {
            shoppingItems = importShoppingOrders();
        }
    } catch (e) {
        console.warn("[backpack] 迁移失败，保留原数据下次重试", e);
        migrated = false;
        return;
    }

    writeMigrationState({
        version: MIGRATION_VERSION,
        pluginItems,
        shoppingItems,
        at: new Date().toISOString(),
    });
}

/** 测试/重装场景：强制重跑迁移 */
export function resetBackpackMigrationFlag(): void {
    migrated = false;
}

/** 供设置页展示：这次迁移搬了多少东西 */
export function readBackpackMigrationSummary(): MigrationState {
    return readMigrationState();
}
