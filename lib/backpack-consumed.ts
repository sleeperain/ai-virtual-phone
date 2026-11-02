// lib/backpack-consumed.ts
// 背包 · 订单商品处置台账
//
// 为什么需要这个模块：
//   判断「这单还能不能退款」原本靠 countSentGiftsForOrder()，而它只统计
//   「礼物卡片消息 + 背包里还在角色名下的物品」。这两样都能被用户删掉：
//   删掉卡片、清空聊天、或直接把背包里那条删了——统计就归零，已送出的
//   商品又能申请退货，钱货两空。
//
//   所以「这件商品已经处置过」必须是独立记录，不能从可变数据反推。
//   处置 = 送出给别人，或被用户手动从背包删除（视为丢弃，实物已不在手上）。
//
// 依赖约束：本模块是叶子，只依赖 kv-db（不 import chat-storage /
// shopping-*），这样 backpack-storage、shopping-gift-utils、shopping-pickup
// 都能安全引用它，不会形成循环。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { BackpackShoppingOrigin } from "./backpack-types";

const CONSUMED_KEY = "backpack_consumed_units_v1";
registerKvMigration(CONSUMED_KEY);

/** orderId → 已处置的单位键集合（`itemId::unitIndex`） */
type ConsumedMap = Record<string, string[]>;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

let cache: ConsumedMap | null = null;

function load(): ConsumedMap {
    if (cache) return cache;
    const raw = kvGet(CONSUMED_KEY);
    const map: ConsumedMap = Object.create(null);
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const [orderId, units] of Object.entries(parsed as Record<string, unknown>)) {
                    if (UNSAFE_KEYS.has(orderId)) continue;
                    if (!Array.isArray(units)) continue;
                    map[orderId] = units.map(String).filter(Boolean);
                }
            }
        } catch {
            /* 坏数据当作没有记录 */
        }
    }
    cache = map;
    return map;
}

function save(map: ConsumedMap): void {
    cache = map;
    kvSet(CONSUMED_KEY, JSON.stringify(map));
}

/** 物品的单位键：与 shopping-gift-utils 里 giftId 的后两段一致 */
export function unitKeyOf(origin: Pick<BackpackShoppingOrigin, "itemId" | "unitIndex">): string {
    return `${origin.itemId}::${origin.unitIndex}`;
}

/** 记录一件商品已被处置（送出或删除） */
export function recordConsumedUnit(origin: BackpackShoppingOrigin | undefined | null): void {
    if (!origin?.orderId) return;
    const map = load();
    const list = map[origin.orderId] ?? [];
    const key = unitKeyOf(origin);
    if (list.includes(key)) return;
    save({ ...map, [origin.orderId]: [...list, key] });
}

/** 某订单已处置的单位键集合 */
export function loadConsumedUnits(orderId: string): Set<string> {
    if (!orderId) return new Set();
    return new Set(load()[orderId] ?? []);
}

/** 某订单已处置的件数 */
export function countConsumedUnits(orderId: string): number {
    if (!orderId) return 0;
    return (load()[orderId] ?? []).length;
}

/** 退款成功后清账：订单已经退掉，不再参与「能不能退」的判断 */
export function clearConsumedUnits(orderId: string): void {
    if (!orderId) return;
    const map = load();
    if (!(orderId in map)) return;
    const next = { ...map };
    delete next[orderId];
    save(next);
}
