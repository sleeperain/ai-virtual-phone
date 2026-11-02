// lib/backpack-delivery.ts
// 原生背包 · 送出物品时发一张礼物卡片
//
// 送出 = 物品归属转到目标角色的背包（数据在 lib/backpack-storage.ts）
//      + 当前聊天里留一张可见的卡片。
// 卡片被删掉不影响物品归属——这正是老礼物功能那个 bug 的根因所在。
//
// 只有「送出」才发卡片；「放入到…」（角色背包之间转移）不发卡片。

import { pushChatMessage } from "./chat-storage";
import { formatBackpackTime, moveBackpackItem, resolveCharacterName } from "./backpack-storage";
import type { BackpackItem } from "./backpack-types";

export type DeliverBackpackItemInput = {
    item: BackpackItem;
    /** 收礼角色 id */
    targetCharacterId: string;
    /** 收礼角色名，写进卡片 */
    targetName?: string;
    /** 卡片落在哪个会话（用户当前打开的聊天） */
    sessionId: string;
};

export type DeliverBackpackItemResult = {
    ok: boolean;
    messageId?: string;
    error?: string;
};

/**
 * 把一件「我的背包」物品送给角色：
 *   1. 物品归属转到该角色的背包
 *   2. 在当前会话里推一张 gift 卡片
 */
export function deliverBackpackItemToCharacter(input: DeliverBackpackItemInput): DeliverBackpackItemResult {
    const { item, targetCharacterId, sessionId } = input;
    if (!item?.id) return { ok: false, error: "物品不存在" };
    if (!targetCharacterId) return { ok: false, error: "没有选择收礼角色" };
    if (!sessionId) return { ok: false, error: "当前不在聊天中" };

    const targetName = input.targetName || resolveCharacterName(targetCharacterId) || "对方";
    const now = Date.now();
    const sentLabel = formatBackpackTime(now);

    // 先转归属：即使后面发卡片失败，物品也已经到对方手里，不会凭空消失
    const moved = moveBackpackItem(item.id, targetCharacterId);
    if (!moved) return { ok: false, error: "转移物品失败" };

    try {
        const message = pushChatMessage({
            sessionId,
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
            },
        });
        return { ok: true, messageId: message.id };
    } catch (e) {
        console.warn("[backpack] 送出礼物卡片失败", e);
        // 物品已经转过去了，卡片失败不回收——否则会变成「既没送出去也没留下」
        return { ok: true, error: "礼物已送到，但卡片没能发出来" };
    }
}
