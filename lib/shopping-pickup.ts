// lib/shopping-pickup.ts
// 购物取件 / 签收 / 售后 / 角色代取 的纯逻辑层。
//
// 状态机（在原有物流时间线之后追加两个阶段）：
//   已下单 → 已发货 → 配送中 → 已到货 → 待签收 → 已签收
//
// 约定：
// - 取件码由订单 ID 稳定哈希生成（x-x-xxxx），同一订单永远一致；
// - 「进入背包」= 进入聊天赠礼的候选列表，签收后才出现，退款后退回；
// - 代取卡片与「代取成功」卡片都不携带商品信息，角色在拆件前不知道买了什么；
// - 拆件是隐性行为（动作标记不渲染），由系统把商品信息作为提示词补给角色。

import { loadShoppingState, saveShoppingState } from "./shopping-storage";
import { createOrGetSession, pushChatMessage } from "./chat-storage";
import { adjustWalletCardAccount, creditWalletBalance } from "./wallet-storage";
import type { ShoppingOrder, ShoppingShippingEvent } from "./shopping-types";

// ── 取件码 ──────────────────────────────────────────────

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 生成稳定取件码：货架-层-流水号，例如 1-5-0928 */
export function generatePickupCode(orderId: string): string {
  const hash = stableHash(`pickup:${orderId}`);
  const shelf = (hash % 12) + 1;
  const layer = ((hash >>> 8) % 6) + 1;
  const serial = ((hash >>> 16) % 10000).toString().padStart(4, "0");
  return `${shelf}-${layer}-${serial}`;
}

export function getOrderPickupCode(order: Pick<ShoppingOrder, "id" | "pickupCode">): string {
  return order.pickupCode || generatePickupCode(order.id);
}

// ── 阶段解析 ──────────────────────────────────────────────

export type ShoppingPickupStage = "preparing" | "shipped" | "delivering" | "arrived" | "waiting" | "signed";

export type ShoppingPickupState = {
  stage: ShoppingPickupStage;
  /** 订单卡片 / Order Status 位置显示的文案（到货未签收时就是取件码） */
  statusLabel: string;
  pickupCode: string;
  /** 已到货、未签收、未退款 —— 可以取件/代取 */
  canPickup: boolean;
  /** 已签收 —— 可以确认收货 */
  canConfirm: boolean;
  /** 到货之后（含已签收）且未退款 —— 可以申请售后 */
  canAfterSale: boolean;
  signed: boolean;
  refunded: boolean;
  unboxed: boolean;
  signedBy?: "user" | "character";
  signedByCharacterName?: string;
  /**
   * 存量订单（没有取件码的历史数据）：不参与取件流程，
   * 到货即视为已签收，物流节点显示「已签收」且不展示取件码，商品正常进包裹。
   */
  legacy: boolean;
};

/** 是否是需要走取件流程的订单（下单时分配过取件码，或有签收记录） */
export function isPickupFlowOrder(order: ShoppingOrder): boolean {
  return Boolean(order.pickupCode || order.signedAt || order.signedBy || order.refundedAt);
}

function parseMs(value?: string): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function reachedEvents(order: ShoppingOrder, nowMs: number): ShoppingShippingEvent[] {
  const timeline = Array.isArray(order.shippingTimeline) ? order.shippingTimeline : [];
  return timeline.filter(event => {
    const at = parseMs(event.timestamp);
    return at > 0 && at <= nowMs;
  });
}

/** 是否已经到货（含签收之后） */
export function hasOrderArrived(order: ShoppingOrder, nowMs: number): boolean {
  if (order.signedAt || order.refundedAt) return true;
  return reachedEvents(order, nowMs).some(event => event.status === "delivered"
    || event.status === "pickup_waiting"
    || event.status === "signed");
}

export function resolveOrderPickup(order: ShoppingOrder, nowMs: number): ShoppingPickupState {
  const pickupCode = getOrderPickupCode(order);
  const signed = Boolean(order.signedAt);
  const refunded = Boolean(order.refundedAt);
  const legacy = !isPickupFlowOrder(order);
  const reached = reachedEvents(order, nowMs);
  const lastReached = reached[reached.length - 1];
  const arrived = reached.some(event => event.status === "delivered" || event.status === "pickup_waiting");

  if (signed || refunded) {
    return {
      stage: "signed",
      statusLabel: "已签收",
      pickupCode,
      canPickup: false,
      canConfirm: !refunded && !order.confirmedAt,
      canAfterSale: !refunded,
      signed: true,
      refunded,
      unboxed: Boolean(order.unboxedAt),
      signedBy: order.signedBy,
      signedByCharacterName: order.signedByCharacterName,
      legacy,
    };
  }

  // 存量订单：到货即已签收，不出取件码、不需要取件，商品直接进包裹
  if (legacy && arrived) {
    return {
      stage: "signed",
      statusLabel: "已签收",
      pickupCode,
      canPickup: false,
      canConfirm: !order.confirmedAt,
      canAfterSale: true,
      signed: true,
      refunded: false,
      unboxed: Boolean(order.unboxedAt),
      legacy: true,
    };
  }

  if (arrived) {
    return {
      stage: "waiting",
      statusLabel: pickupCode,
      pickupCode,
      canPickup: true,
      canConfirm: false,
      canAfterSale: true,
      signed: false,
      refunded: false,
      unboxed: false,
      legacy: false,
    };
  }

  const stage: ShoppingPickupStage = lastReached?.status === "delivering"
    ? "delivering"
    : lastReached?.status === "shipped"
      ? "shipped"
      : "preparing";
  // 没有物流时间线的订单（代付未结清等）沿用订单自身的状态文案
  const hasTimeline = Array.isArray(order.shippingTimeline) && order.shippingTimeline.length > 0;
  const statusLabel = !hasTimeline
    ? order.statusLabel
    : lastReached?.status === "ordered" || !lastReached
      ? "待发货"
      : lastReached.label;
  return {
    stage,
    statusLabel,
    pickupCode,
    canPickup: false,
    canConfirm: false,
    canAfterSale: false,
    signed: false,
    refunded: false,
    unboxed: false,
    legacy,
  };
}

// ── 订单写入 ──────────────────────────────────────────────

function formatTimeLabel(date: Date): string {
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseAmount(label?: string): number {
  const match = String(label ?? "").replace(/[¥￥元,\s]/g, "").match(/-?\d+(?:\.\d+)?/);
  const amount = match ? Number(match[0]) : 0;
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * 把签收相关节点补进物流时间线（时间同到货，不改写存档）：
 * - 取件流程订单 → 补「待签收」（之后签收时由 signShoppingOrder 落「已签收」）；
 * - 存量订单 → 直接补「已签收」，不展示取件码。
 */
export function withPickupTimeline(order: ShoppingOrder): ShoppingOrder {
  const timeline = Array.isArray(order.shippingTimeline) ? [...order.shippingTimeline] : [];
  if (timeline.length === 0) return order;
  if (timeline.some(event => event.status === "pickup_waiting" || event.status === "signed")) return order;

  const deliveredEvent = timeline.find(event => event.status === "delivered");
  if (!deliveredEvent) return order;

  const legacy = !isPickupFlowOrder(order);
  const closingEvent: ShoppingShippingEvent = {
    status: legacy ? "signed" : "pickup_waiting",
    label: legacy ? "已签收" : "待签收",
    timeLabel: deliveredEvent.timeLabel,
    timestamp: deliveredEvent.timestamp,
  };
  const nextTimeline = [...timeline, closingEvent].sort((a, b) => parseMs(a.timestamp) - parseMs(b.timestamp));
  return { ...order, shippingTimeline: nextTimeline };
}

function updateOrder(orderId: string, patcher: (order: ShoppingOrder) => ShoppingOrder): ShoppingOrder | null {
  const state = loadShoppingState();
  let updated: ShoppingOrder | null = null;
  const orders = state.orders.map(order => {
    if (order.id !== orderId) return order;
    updated = patcher(order);
    return updated;
  });
  if (!updated) return null;
  saveShoppingState({ ...state, orders });
  return updated;
}

function appendSignedEvent(order: ShoppingOrder, at: Date): ShoppingShippingEvent[] {
  const timeline = Array.isArray(order.shippingTimeline) ? [...order.shippingTimeline] : [];
  if (timeline.some(event => event.status === "signed")) return timeline;
  return [
    ...timeline,
    {
      status: "signed" as const,
      label: "已签收",
      timeLabel: formatTimeLabel(at),
      timestamp: at.toISOString(),
    },
  ];
}

type SignOrderOptions = {
  by: "user" | "character";
  characterId?: string;
  characterName?: string;
};

/** 签收：自己取件成 或 角色代取成功时调用，签收后商品才进入赠礼列表 */
export function signShoppingOrder(orderId: string, options: SignOrderOptions): ShoppingOrder | null {
  const now = new Date();
  return updateOrder(orderId, order => ({
    ...order,
    pickupCode: getOrderPickupCode(order),
    pickupCodeAt: order.pickupCodeAt || now.toISOString(),
    signedAt: now.toISOString(),
    signedBy: options.by,
    signedByCharacterId: options.by === "character" ? options.characterId : undefined,
    signedByCharacterName: options.by === "character" ? options.characterName : undefined,
    proxySessionId: options.by === "user" ? undefined : order.proxySessionId,
    shippingTimeline: appendSignedEvent(order, now),
  }));
}

/** 确认收货：签收之后可点，点完按钮变「再买一单」 */
export function confirmShoppingOrder(orderId: string): ShoppingOrder | null {
  return updateOrder(orderId, order => ({ ...order, confirmedAt: new Date().toISOString() }));
}

export type RefundOrderResult = {
  ok: boolean;
  order?: ShoppingOrder;
  amount: number;
  error?: string;
};

/**
 * 申请售后：原路退款 + 商品退回（不进赠礼列表 / 从列表移除），物流落成已签收。
 * 代付单没有支付账户，按余额退回。
 */
export function refundShoppingOrder(orderId: string): RefundOrderResult {
  const state = loadShoppingState();
  const order = state.orders.find(item => item.id === orderId);
  if (!order) return { ok: false, amount: 0, error: "未找到该订单。" };
  if (order.refundedAt) return { ok: false, amount: 0, error: "该订单已申请过售后。" };

  const amount = parseAmount(order.totalLabel);
  const now = new Date();
  let refundTransactionId: string | undefined;
  const detail = `售后退款：${order.summary || order.id}`;

  if (amount > 0) {
    const cardId = order.paymentCardId;
    if (cardId && cardId !== "wallet_balance_account") {
      const result = adjustWalletCardAccount(cardId, amount, "in");
      if (!result.ok) return { ok: false, amount, error: result.error ?? "退款失败。" };
      refundTransactionId = result.transaction?.id;
    } else {
      const result = creditWalletBalance(amount, "购物退款", detail, "退款");
      if (!result.ok) return { ok: false, amount, error: result.error ?? "退款失败。" };
      refundTransactionId = result.transaction?.id;
    }
  }

  const updated = updateOrder(orderId, current => ({
    ...current,
    refundedAt: now.toISOString(),
    refundTransactionId,
    signedAt: current.signedAt || now.toISOString(),
    signedBy: current.signedBy || "user",
    shippingTimeline: appendSignedEvent(current, now),
  }));

  return { ok: true, order: updated ?? undefined, amount };
}

// ── 代取卡片 ──────────────────────────────────────────────

export type DeliveryCardKind = "pickup" | "picked";

export type DeliveryCardPayload = {
  readonly kind: DeliveryCardKind;
  /** 卡片首行的主文案：取件码，或「代取成功」 */
  codeLabel: string;
  /** 取件码下方的小字装饰文案 */
  caption: string;
  orderId: string;
};

function pickupCaption(order: ShoppingOrder, code: string): string {
  return `${order.merchantLabel || "驿站"} · 凭码到柜自取`;
}

/** 生成「去取件前的」代取卡片内容（不含商品信息） */
export function buildPickupCard(order: ShoppingOrder): DeliveryCardPayload {
  const code = getOrderPickupCode(order);
  return {
    kind: "pickup",
    codeLabel: code,
    caption: pickupCaption(order, code),
    orderId: order.id,
  };
}

export function buildPickedCard(order: ShoppingOrder): DeliveryCardPayload {
  const code = getOrderPickupCode(order);
  return {
    kind: "picked",
    codeLabel: "代取成功",
    caption: `${order.signedByCharacterName || "对方"} 已替你取到包裹 · ${code}`,
    orderId: order.id,
  };
}

/** 把取件卡片发到指定角色的私聊（用户点「找人代取」时调用） */
export function sendPickupProxyCard(orderId: string, character: { id: string; name: string }): {
  ok: boolean;
  sessionId?: string;
  order?: ShoppingOrder;
  error?: string;
} {
  const state = loadShoppingState();
  const order = state.orders.find(item => item.id === orderId);
  if (!order) return { ok: false, error: "未找到该订单。" };
  const pickup = resolveOrderPickup(order, Date.now());
  if (!pickup.canPickup) return { ok: false, error: "该订单当前不可取件。" };

  const card = buildPickupCard(order);
  const session = createOrGetSession(character.id);
  pushChatMessage({
    sessionId: session.id,
    role: "user",
    content: "",
    mediaType: "delivery_card",
    mediaData: {
      deliveryCardKind: card.kind,
      deliveryCardOrderId: card.orderId,
      deliveryCardCodeLabel: card.codeLabel,
      deliveryCardCaption: card.caption,
      label: card.codeLabel,
    },
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
  }

  const updated = updateOrder(orderId, current => ({
    ...current,
    pickupCode: getOrderPickupCode(current),
    pickupCodeAt: current.pickupCodeAt || new Date().toISOString(),
    proxySessionId: session.id,
    proxyCharacterId: character.id,
    proxyCharacterName: character.name,
  }));

  return { ok: true, sessionId: session.id, order: updated ?? undefined };
}

/** 角色代取成功：签收订单并在该角色的会话里落一张「代取成功」卡片（不含商品信息） */
export function settlePickupProxySuccess(sessionId: string): ShoppingOrder | null {
  const state = loadShoppingState();
  const order = state.orders.find(item => item.proxySessionId === sessionId
    && !item.signedAt
    && !item.refundedAt);
  if (!order) return null;

  const signed = signShoppingOrder(order.id, {
    by: "character",
    characterId: order.proxyCharacterId,
    characterName: order.proxyCharacterName,
  });
  if (!signed) return null;

  const card = buildPickedCard(signed);
  pushChatMessage({
    sessionId,
    role: "assistant",
    content: "",
    mediaType: "delivery_card",
    mediaData: {
      deliveryCardKind: card.kind,
      deliveryCardOrderId: card.orderId,
      deliveryCardCodeLabel: card.codeLabel,
      deliveryCardCaption: card.caption,
      label: card.codeLabel,
    },
    senderCharacterId: order.proxyCharacterId,
    senderName: order.proxyCharacterName,
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
  }
  return signed;
}

// ── 拆件（隐性动作） ──────────────────────────────────────────

/**
 * 角色发出拆件动作时调用：标记订单已拆，并返回要补给角色的商品信息文本。
 * 拆件前角色只知道「有个包裹」，拆开后才知道里面是什么。
 */
export function settleDeliveryUnbox(input: {
  sessionId: string;
  characterId?: string;
  characterName?: string;
}): { order: ShoppingOrder; revealText: string } | null {
  const { sessionId, characterId, characterName } = input;
  const state = loadShoppingState();
  const unboxable = (item: ShoppingOrder) => Boolean(item.signedAt) && !item.refundedAt && !item.unboxedAt;
  const target = state.orders.find(item => item.proxySessionId === sessionId && unboxable(item))
    ?? (characterId
      ? state.orders.find(item => item.proxyCharacterId === characterId && unboxable(item))
        ?? state.orders.find(item => item.signedByCharacterId === characterId && unboxable(item))
      : undefined);
  if (!target) return null;

  const updated = updateOrder(target.id, current => ({
    ...current,
    unboxedAt: new Date().toISOString(),
    unboxedBy: characterName,
  }));
  if (!updated) return null;

  const itemLines = updated.items.map(item => {
    const quantity = item.quantityLabel ? `（${item.quantityLabel}）` : "";
    return `- ${item.title}${quantity}：${item.detail || item.subtitle || item.title}`;
  });
  const revealText = [
    `你刚拆开了这个包裹，里面是：`,
    ...itemLines,
    `共 ${updated.items.length} 件，订单金额 ${updated.totalLabel}。`,
  ].join("\n");

  return { order: updated, revealText };
}

/** 该会话里是否有「已签收但角色还没拆」的快递（用于给角色提示） */
export function loadPendingUnboxOrder(sessionId: string): ShoppingOrder | null {
  const state = loadShoppingState();
  return state.orders.find(item => item.proxySessionId === sessionId
    && item.signedAt
    && !item.refundedAt
    && !item.unboxedAt) ?? null;
}

// ── 聊天标记（隐性） ──────────────────────────────────────────

/** 角色动作标记：代取成功 */
export const PICKUP_PROXY_SUCCESS_RE = /\[(?:代取成功|已代取)\]/;
/** 角色动作标记：拆快递（不渲染，只用于追加提示） */
export const PICKUP_UNBOX_RE = /\[拆(?:开)?(?:快递|包裹|箱子|件)\]/;

export type DeliveryMarkerResult = {
  /** 剥离标记后的正文 */
  text: string;
  /** 本次回复里是否声明了代取成功 */
  pickedProxy: boolean;
  /** 本次回复里是否拆开了快递 */
  unboxed: boolean;
};

/** 提炼并剥离快递相关的隐性动作标记（显示层不呈现任何标记） */
export function stripDeliveryMarkers(text: string): DeliveryMarkerResult {
  if (!text) return { text: "", pickedProxy: false, unboxed: false };
  const pickedProxy = PICKUP_PROXY_SUCCESS_RE.test(text);
  const unboxed = PICKUP_UNBOX_RE.test(text);
  if (!pickedProxy && !unboxed) return { text, pickedProxy, unboxed };
  const cleaned = text
    .replace(new RegExp(PICKUP_PROXY_SUCCESS_RE.source, "g"), "")
    .replace(new RegExp(PICKUP_UNBOX_RE.source, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: cleaned, pickedProxy, unboxed };
}

/**
 * 处理一条助手回复里的快递标记：
 * 1. 代取成功 → 签收订单 + 落「代取成功」卡片；
 * 2. 拆快递 → 标记已拆，返回补给角色的商品信息（由调用方作为提示词落库）。
 * 返回剥离标记后的正文。
 */
export function applyDeliveryMarkers(
  rawText: string,
  sessionId: string,
  options?: { characterId?: string; characterName?: string },
): { text: string; revealText?: string } {
  const marker = stripDeliveryMarkers(rawText);
  if (!marker.pickedProxy && !marker.unboxed) return { text: rawText };

  if (marker.pickedProxy) {
    settlePickupProxySuccess(sessionId);
  }
  if (marker.unboxed) {
    const result = settleDeliveryUnbox({
      sessionId,
      characterId: options?.characterId,
      characterName: options?.characterName,
    });
    return { text: marker.text, revealText: result?.revealText };
  }
  return { text: marker.text };
}
