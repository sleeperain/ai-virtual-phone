// lib/backpack-legacy.ts
// 原生背包 · 一次性数据迁移
//
// 这里可以放心 import chat-storage / shopping-gift-utils ——
// 因为它不被 chat-storage 依赖（只在启动时被 import 一次做副作用注册），
// 不会形成 chat-storage → backpack-markers → backpack-storage → chat-storage 的环。
//
// 迁移三件事：
//   v1 从老插件（gift-backpack）的私有数据桶搬物品与转送白名单，只读不删
//   v2 购物订单里已到货的商品全量进「我的背包」，来源/时间/详情由订单锁定
//   v3 把「按会话归属」的老数据换算成「按角色归属」

import { hydrateChatStorage, loadChatSessions } from "./chat-storage";
import { loadDeliveredShoppingGifts } from "./shopping-gift-utils";
import { loadShoppingState } from "./shopping-storage";
import { loadConsumedUnits } from "./backpack-consumed";
import { hydrateKvDb, kvGet } from "./kv-db";
import {
    ensureBackpackMigrated,
    formatBackpackTime,
    loadTransferTargets,
    readBackpackItemsForMigration,
    registerBackpackMigrationRunner,
    resolveCharacterIdByName,
    resolveCharacterName,
    saveTransferTargets,
    writeBackpackItemsFromMigration,
} from "./backpack-storage";
import type { BackpackItem, BackpackShoppingOrigin, BackpackTransferTargets } from "./backpack-types";

/** 老插件的数据桶 */
const LEGACY_PLUGIN_BUCKET = "chat_plugin_data_v1:gift-backpack";
const LEGACY_PLUGIN_ITEMS = "backpack_gifts_v1";
const LEGACY_PLUGIN_TARGETS = "backpack_transfer_targets_v2";

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 私聊会话 id → 角色 id */
function resolveCharacterIdBySessionId(sessionId: string): string {
    if (!sessionId) return "";
    try {
        const session = loadChatSessions().find(s => s.id === sessionId);
        if (!session || session.isGroup === true) return "";
        return String(session.contactId ?? "");
    } catch {
        return "";
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

// ── v1：老插件数据桶 ───────────────────────────────────────

function importLegacyPluginData(items: BackpackItem[]): number {
    const raw = kvGet(LEGACY_PLUGIN_BUCKET);
    if (!raw) return 0;

    let bucket: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!isPlainObject(parsed)) return 0;
        bucket = parsed;
    } catch {
        return 0;
    }

    const legacyItems = bucket[LEGACY_PLUGIN_ITEMS];
    if (!Array.isArray(legacyItems)) return 0;

    const existing = new Set(items.map(it => it.id));
    let imported = 0;
    for (const rawItem of legacyItems) {
        if (!isPlainObject(rawItem)) continue;
        const id = typeof rawItem.id === "string" ? rawItem.id : "";
        if (!id || existing.has(id)) continue;
        existing.add(id);
        items.push(toBackpackItem(rawItem));
        imported += 1;
    }

    // 转送白名单一并接管，否则用户的转送配置会退回默认
    const legacyTargets = bucket[LEGACY_PLUGIN_TARGETS];
    if (isPlainObject(legacyTargets) && Object.keys(loadTransferTargets()).length === 0) {
        const next: BackpackTransferTargets = Object.create(null);
        for (const [key, value] of Object.entries(legacyTargets)) {
            if (UNSAFE_KEYS.has(key)) continue;
            if (Array.isArray(value)) next[key] = value.map(String);
        }
        if (Object.keys(next).length > 0) saveTransferTargets(next);
    }

    return imported;
}

/** 把老插件的裸对象转成 BackpackItem（字段口径尽量宽松，别丢数据） */
function toBackpackItem(raw: Record<string, unknown>): BackpackItem {
    const recipient = raw.recipient === "character" ? "character" : "user";
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
        visibleTo: Array.isArray(raw.visibleTo) ? raw.visibleTo.map(String).filter(Boolean) : [],
        isManual: raw.isManual === true,
        isRoleAdded: raw.isRoleAdded === true,
        userEdited: raw.userEdited === true,
        timestamp: Number.isFinite(raw.timestamp) ? Number(raw.timestamp) : Date.now(),
        shopping: isPlainObject(raw.shopping) ? raw.shopping as BackpackShoppingOrigin : undefined,
        legacySessionId: typeof raw.sessionId === "string" && raw.sessionId
            ? raw.sessionId
            : undefined,
    };
}

// ── v2：购物订单 → 我的背包 ────────────────────────────────

function importShoppingOrders(items: BackpackItem[]): number {
    let candidates;
    try {
        candidates = loadDeliveredShoppingGifts({ includeSent: true });
    } catch {
        return 0;
    }
    if (!Array.isArray(candidates) || candidates.length === 0) return 0;

    // 只对「没有订单来源」的物品做名称去重：那些是从老插件的礼物卡片里扫出来的，
    // 没有 orderId 可用，只能靠名称+店铺认。带 shopping 的物品一律按
    // 订单+商品+件号判断，否则再买一次同款商品会被当成重复而进不了背包。
    const userSignatures = new Set(
        items
            .filter(it => it.recipient === "user" && !it.shopping)
            .map(it => `${it.title}::${it.source}`),
    );
    const originKeys = new Set(
        items
            .map(it => it.shopping)
            .filter((s): s is BackpackShoppingOrigin => !!s)
            .map(s => `${s.orderId}::${s.itemId}::${s.unitIndex}`),
    );
    // 老插件扫出来的、已经在角色手里且没有订单来源的同一件商品，
    // 不该再进「我的背包」变成重复的一份
    const ownedByCharacter = new Set(
        items
            .filter(it => it.recipient === "character" && !it.shopping)
            .map(it => `${it.title}::${it.source}`),
    );
    // 已处置的（送出后被删掉的）不能因为「重新扫描」又被当成新到货导回来
    const consumedByOrder = new Map<string, Set<string>>();
    for (const order of loadShoppingState().orders) {
        const units = loadConsumedUnits(order.id);
        if (units.size > 0) consumedByOrder.set(order.id, units);
    }

    let imported = 0;
    for (const candidate of candidates) {
        const originKey = `${candidate.orderId}::${candidate.itemId}::${candidate.unitIndex}`;
        if (originKeys.has(originKey)) continue;
        if (consumedByOrder.get(candidate.orderId)?.has(`${candidate.itemId}::${candidate.unitIndex}`)) continue;
        const signature = `${candidate.productName}::${candidate.merchantLabel}`;
        if (userSignatures.has(signature) || ownedByCharacter.has(signature)) continue;

        const deliveredMs = candidate.deliveredAt ? new Date(candidate.deliveredAt).getTime() : 0;
        const timestamp = Number.isFinite(deliveredMs) && deliveredMs > 0 ? deliveredMs : Date.now();

        originKeys.add(originKey);
        items.push({
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
            characterId: "",
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
        imported += 1;
    }
    return imported;
}

// ── v3：会话归属 → 角色归属 ────────────────────────────────

function migrateToCharacterOwnership(items: BackpackItem[]): void {
    for (const item of items) {
        const legacySid = item.legacySessionId ?? "";
        const sessionCharacterId = legacySid ? resolveCharacterIdBySessionId(legacySid) : "";
        // 会话存在但不是私聊（旧的群礼物堆）：归到投放者
        const legacyGroupLike = !!legacySid && !sessionCharacterId;

        if (item.recipient === "character" && !item.characterId) {
            const resolved = sessionCharacterId
                || resolveCharacterIdByName(item.source)
                || resolveCharacterIdByName(item.title);
            if (resolved) {
                item.characterId = resolved;
            } else {
                // 认不出是谁的就放回我的背包，宁可多一件也不要悬空丢数据
                item.recipient = "user";
                item.characterId = "";
                item.injected = false;
            }
        } else if (legacyGroupLike && !item.characterId) {
            const owner = resolveCharacterIdByName(item.source);
            if (owner) {
                item.recipient = "character";
                item.characterId = owner;
                item.injected = false;
            } else {
                item.recipient = "user";
                item.characterId = "";
                item.injected = false;
            }
        }

        if (item.recipient === "user") {
            const mapped: string[] = [];
            for (const vis of item.visibleTo) {
                const cid = resolveCharacterIdBySessionId(vis);
                const target = cid || (resolveCharacterName(vis) ? vis : "");
                if (target && !mapped.includes(target)) mapped.push(target);
            }
            item.visibleTo = mapped;
        } else {
            item.visibleTo = [];
        }

        delete item.legacySessionId;
    }
}

// ── 注册 ───────────────────────────────────────────────────

/**
 * 注册到 backpack-storage。此后任何一次 loadBackpackItems()
 * 都会先确保迁移跑过（每个会话只真正跑一次，有版本标记）。
 */
registerBackpackMigrationRunner(fromVersion => {
    const items = readBackpackItemsForMigration();
    let pluginItems = 0;
    let shoppingItems = 0;

    // v4 修复了 v3 的时序 bug，受影响用户的版本标记被误写成 3 但一件都没搬。
    // 三步本身都有去重、可重复执行，所以 fromVersion < 4 时全部重跑一遍。
    const rerunAll = fromVersion < 4;

    if (rerunAll || fromVersion < 1) pluginItems = importLegacyPluginData(items);
    if (rerunAll || fromVersion < 2) shoppingItems = importShoppingOrders(items);
    if (rerunAll || fromVersion < 3) migrateToCharacterOwnership(items);

    writeBackpackItemsFromMigration(items);
    return { pluginItems, shoppingItems };
});

/**
 * 启动引导：等 kv 和聊天数据都水合完，再跑迁移。
 *
 * 必须等：迁移要读插件数据桶（kv）、购物订单（kv）、会话（chat-db）。
 * 这些存储都是异步水合的，「立刻跑」只会读到空数据。
 */
export async function initBackpackMigration(): Promise<void> {
    if (typeof window === "undefined") return;
    try {
        await Promise.allSettled([hydrateKvDb(), hydrateChatStorage()]);
    } catch (e) {
        console.warn("[backpack] 水合等待失败，稍后再试", e);
    }
    // 水合是走的，ensureBackpackMigrated 内部还会再确认一次状态
    ensureBackpackMigrated();
}

/**
 * 「重新扫描」：只补购物订单里新到货的商品。
 * 不重放插件导入（用户可能已经主动删掉了插件里的某些物品），
 * 也不重算归属（会把用户手动放入角色的东西又搬回去）。
 */
export function rescanShoppingOrders(): number {
    const items = readBackpackItemsForMigration();
    const added = importShoppingOrders(items);
    if (added > 0) writeBackpackItemsFromMigration(items);
    return added;
}
