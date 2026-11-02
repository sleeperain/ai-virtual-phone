import { loadChatMessages, loadChatSessions } from "./chat-storage";
import { loadBackpackItems } from "./backpack-storage";
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
  for (const item of loadBackpackItems()) {
    if (item.recipient === "user") continue;
    const origin = item.shopping;
    if (!origin) continue;
    sentIds.add(`${origin.orderId}::${origin.itemId}::${origin.unitIndex}`);
  }
  return sentIds;
}

/** 该订单里已经被送出、且没有被退回的礼物件数（用于判断还能不能售后） */
export function countSentGiftsForOrder(orderId: string): number {
  let count = 0;
  for (const session of loadChatSessions()) {
    for (const message of loadChatMessages(session.id)) {
      if (message.mediaType !== "gift") continue;
      if (message.mediaData?.giftOrderId !== orderId) continue;
      if (message.mediaData?.giftReturnedAt) continue;
      count += 1;
    }
  }
  // 背包里的同一件商品已经转到角色那里，也算送出
  for (const item of loadBackpackItems()) {
    if (item.recipient === "user") continue;
    if (item.shopping?.orderId === orderId) count += 1;
  }
  return count;
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
