// lib/backpack-delivery.ts
// 原生背包 · 送出物品时发一张礼物卡片
//
// 送出后物品本体转移到角色背包（数据在 lib/backpack-storage.ts），
// 这里只负责在聊天里留一张可见的卡片。卡片被删掉不影响物品归属——
// 这正是老礼物功能那个 bug 的根因所在。

import { pushChatMessage } from "./chat-storage";
import { formatBackpackTime, updateBackpackItem } from "./backpack-storage";
import type { BackpackItem } from "./backpack-types";

export type DeliverBackpackItemInput = {
    item: BackpackItem;
    /** 收礼角色的会话 id */
    targetSessionId: string;
    /** 收礼角色名，写进卡片 */
    targetName: string;
    /** 发送者名字，群聊里作为送礼人展示 */
    senderName?: string;
};

/**
 * 把一件「我的背包」物品送给角色：
 *   1. 物品归属改为该角色的背包（sessionId 指向对方会话）
 *   2. 在目标会话里推一张 gift 卡片
 * 返回推出的消息 id，失败返回 null。
 */
export function deliverBackpackItemToCharacter(input: DeliverBackpackItemInput): string | null {
    const { item, targetSessionId, targetName } = input;
    if (!item?.id || !targetSessionId) return null;

    const now = Date.now();
    const sentLabel = formatBackpackTime(now);

    // 先转归属：即使后面发卡片失败，物品也已经到对方手里，不会凭空消失
    updateBackpackItem(item.id, {
        recipient: "character",
        sessionId: targetSessionId,
        injected: true,
        visibleTo: [],
        timestamp: now,
    });

    try {
        const message = pushChatMessage({
            sessionId: targetSessionId,
            role: "user",
            content: "",
            mediaType: "gift",
            mediaData: {
                giftOrderId: item.shopping?.orderId,
                giftItemId: item.shopping?.itemId,
                giftName: item.title,
                giftMerchantLabel: item.source,
                giftPriceLabel: item.value === "--" ? "" : item.value,
                giftPreviewIcon: item.previewIcon,
                giftTone: item.tone,
                giftDeliveredAt: item.shopping?.deliveredAt,
                giftSentAt: sentLabel,
                giftReceiverName: targetName,
                senderName: input.senderName,
            },
        });
        return message.id;
    } catch (e) {
        console.warn("[backpack] 送出礼物卡片失败", e);
        return null;
    }
}
