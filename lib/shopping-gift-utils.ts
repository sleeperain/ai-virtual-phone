import { loadChatMessages, loadChatSessions } from "./chat-storage";
import { kvGet } from "./kv-db";
import { loadConsumedUnits } from "./backpack-consumed";
import { loadShoppingState } from "./shopping-storage";
import type { ShoppingOrder } from "./shopping-types";
import type { CheckPhoneShoppingTone } from "./checkphone-config";

export type ShoppingGiftCandidate = {
  id: string;
  orderId: string;
  itemId: string;
  unitIndex: number;
  productName: string;
  merchantLabel: string;
  priceLabel: string;
  quantityLabel: string;
  subtitle: string;
  detail: string;
  previewIcon: string;
  tone: CheckPhoneShoppingTone;
  deliveredAt?: string;
  deliveredTimeLabel?: string;
  orderTimeLabel: string;
};

type LoadShoppingGiftOptions = {
  includeSent?: boolean;
  nowMs?: number;
};

function parseGiftQuantity(label?: string): number {
  const match = String(label ?? "").match(/\d+/);
  const amount = match ? Number(match[0]) : 1;
  if (!Number.isFinite(amount)) return 1;
  return Math.min(50, Math.max(1, Math.round(amount)));
}

function parseTimestamp(value?: string): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function getDeliveredEvent(order: ShoppingOrder) {
  return order.shippingTimeline?.find(event => event.status === "delivered");
}

function isOrderDelivered(order: ShoppingOrder, nowMs: number): boolean {
  const deliveredEvent = getDeliveredEvent(order);
  if (deliveredEvent) {
    const deliveredMs = parseTimestamp(deliveredEvent.timestamp);
    return deliveredMs > 0 && deliveredMs <= nowMs;
  }
  return /已到货|已签收|已完成/.test(order.statusLabel);
}

/**
 * 商品是否已「进入背包」= 出现在可送礼物列表。
 *
 * 新流程（下单时即写入取件码）必须签收后才算到手：待签收阶段还锁在驿站里。
 * 申请售后的订单商品退回，永远不进列表。
 * 旧订单（没有取件码的老数据）保持原有行为：到货即可送，避免升级后凭空少礼物。
 */
function isOrderGiftable(order: ShoppingOrder, nowMs: number): boolean {
  if (order.refundedAt) return false;
  if (order.signedAt) return true;
  if (order.pickupCode) return false;
  return isOrderDelivered(order, nowMs);
}

const BACKPACK_ITEMS_KEY = "backpack_items_v1";

/**
 * 直接从 KV 里挑出背包物品，不走 lib/backpack-storage。
 *
 * 原因：backpack-storage 迁移时要调用本模块的 loadDeliveredShoppingGifts，
 * 如果这里反过来 import backpack-storage 就成了循环依赖——迁移跑在模块
 * 初始化早期，循环会让它取到还没初始化的函数。这里只读一个 key，字段也
 * 只用得到几个，单独解析最稳。
 */
type BackpackSentEntry = {
  recipient: string;
  orderId?: string;
  itemId?: string;
  unitIndex?: number;
};

function readBackpackItemsForSentCheck(): BackpackSentEntry[] {
  const raw = kvGet(BACKPACK_ITEMS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: BackpackSentEntry[] = [];
    for (const rawItem of parsed) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const it = rawItem as Record<string, unknown>;
      const shopping = it.shopping && typeof it.shopping === "object"
        ? it.shopping as Record<string, unknown>
        : null;
      entries.push({
        recipient: typeof it.recipient === "string" ? it.recipient : "user",
        orderId: shopping && typeof shopping.orderId === "string" ? shopping.orderId : undefined,
        itemId: shopping && typeof shopping.itemId === "string" ? shopping.itemId : undefined,
        unitIndex: shopping && typeof shopping.unitIndex === "number" ? shopping.unitIndex : undefined,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * 已送出的礼物 id 集合。
 *
 * 两个来源：老礼物卡片（消息上的 shoppingGiftId）与背包（物品已经不在「我的背包」里）。
 * 背包这一路是关键：物品归属是独立数据，清空聊天记录删掉卡片之后，
 * 这件东西依然算「已送出」，不会再回到可送列表。
 */
export function loadSentShoppingGiftIds(): Set<string> {
  const sentIds = new Set<string>();
  for (const session of loadChatSessions()) {
    for (const message of loadChatMessages(session.id)) {
      if (message.mediaType !== "gift") continue;
      // 角色把礼物退回来的那几条不算「已送出」：礼物重新回到赠礼列表
      if (message.mediaData?.giftReturnedAt) continue;
      const giftId = message.mediaData?.shoppingGiftId;
      if (giftId) sentIds.add(giftId);
    }
  }
  for (const entry of readBackpackItemsForSentCheck()) {
    if (entry.recipient === "user") continue;
    if (!entry.orderId) continue;
    sentIds.add(`${entry.orderId}::${entry.itemId ?? ""}::${entry.unitIndex ?? 1}`);
  }
  // 已处置（送出后又被删掉）的商品同样不该再出现在可送列表
  for (const state of loadShoppingState().orders) {
    for (const unitKey of loadConsumedUnits(state.id)) {
      sentIds.add(`${state.id}::${unitKey}`);
    }
  }
  return sentIds;
}

/**
 * 该订单里已经被处置的件数（用于判断还能不能售后）。
 *
 * 「处置」= 送出给角色，或被用户从背包里删掉——两种情况下实物都不在自己手上。
 * 必须把处置台账算进来：只看礼物卡片和背包现状的话，用户「送出→删掉」之后
 * 统计会归零，那笔订单就还能原价退款，等于钱货两空。
 */
export function countSentGiftsForOrder(orderId: string): number {
  let legacyCount = 0;
  for (const session of loadChatSessions()) {
    for (const message of loadChatMessages(session.id)) {
      if (message.mediaType !== "gift") continue;
      if (message.mediaData?.giftOrderId !== orderId) continue;
      if (message.mediaData?.giftReturnedAt) continue;
      legacyCount += 1;
    }
  }

  // 背包现状与台账都按「商品单位」记账，合并去重避免同一件被数两次
  const unitKeys = new Set<string>();
  for (const entry of readBackpackItemsForSentCheck()) {
    if (entry.recipient === "user") continue;
    if (entry.orderId !== orderId) continue;
    unitKeys.add(`${entry.itemId ?? ""}::${entry.unitIndex ?? 1}`);
  }
  for (const unitKey of loadConsumedUnits(orderId)) unitKeys.add(unitKey);

  return legacyCount + unitKeys.size;
}

export function loadDeliveredShoppingGifts(options: LoadShoppingGiftOptions = {}): ShoppingGiftCandidate[] {
  const nowMs = options.nowMs ?? Date.now();
  const sentIds = options.includeSent ? new Set<string>() : loadSentShoppingGiftIds();
  const state = loadShoppingState();
  const gifts: ShoppingGiftCandidate[] = [];

  for (const order of state.orders) {
    if (!isOrderGiftable(order, nowMs)) continue;
    const deliveredEvent = getDeliveredEvent(order);

    order.items.forEach((item, itemIndex) => {
      const quantity = parseGiftQuantity(item.quantityLabel);
      for (let unitIndex = 1; unitIndex <= quantity; unitIndex += 1) {
        const giftId = `${order.id}::${item.id || itemIndex}::${unitIndex}`;
        if (sentIds.has(giftId)) continue;
        gifts.push({
          id: giftId,
          orderId: order.id,
          itemId: item.id || `${itemIndex}`,
          unitIndex,
          productName: item.title,
          merchantLabel: item.merchantLabel || order.merchantLabel,
          priceLabel: item.priceLabel,
          quantityLabel: quantity > 1 ? `第 ${unitIndex}/${quantity} 件` : item.quantityLabel || "x 1",
          subtitle: item.subtitle,
          detail: item.detail,
          previewIcon: item.previewIcon,
          tone: item.tone,
          deliveredAt: deliveredEvent?.timestamp,
          deliveredTimeLabel: deliveredEvent?.timeLabel,
          orderTimeLabel: order.timeLabel,
        });
      }
    });
  }

  return gifts.sort((a, b) => {
    const timeDiff = parseTimestamp(b.deliveredAt) - parseTimestamp(a.deliveredAt);
    if (timeDiff !== 0) return timeDiff;
    return b.orderId.localeCompare(a.orderId);
  });
}
