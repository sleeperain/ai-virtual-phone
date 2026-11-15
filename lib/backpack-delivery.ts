// lib/backpack-delivery.ts
// 原生背包 · 送出物品时发一张礼物卡片
//
// 送出 = 物品归属转到目标角色的背包（数据在 lib/backpack-storage.ts）
//      + 在**收礼人自己的私聊会话**里留一张可见的卡片。
//
// 卡片落点很关键：不是「发起送出时正打开的那个会话」。
// 在群里把东西送给某个成员时，卡片应该出现在你和他的私聊里，
// 留一张到群里等于把私聊礼物挂在群聊记录上。
// 收礼人还没有聊天室时顺带建一个（同时补上联系人，否则会话不会出现在消息列表里）。
//
// 卡片被删掉不影响物品归属——这正是老礼物功能那个 bug 的根因所在。
// 只有「送出」才发卡片；「放入到…」（角色背包之间转移）不发卡片。

import { addChatContact, createOrGetSession, loadChatSessions, pushChatMessage } from "./chat-storage";
import { formatBackpackTime, moveBackpackItem, resolveCharacterName } from "./backpack-storage";
import type { BackpackItem } from "./backpack-types";

export type DeliverBackpackItemInput = {
    item: BackpackItem;
    /** 收礼角色 id */
    targetCharacterId: string;
    /** 收礼角色名，写进卡片 */
    targetName?: string;
    /**
     * @deprecated 卡片固定发到收礼角色自己的私聊会话，这个字段不再参与定位。
     * 保留只为兼容旧调用方，传了也会被忽略。
     */
    sessionId?: string;
};

export type DeliverBackpackItemResult = {
    ok: boolean;
    messageId?: string;
    /** 卡片落在哪个私聊会话 */
    sessionId?: string;
    /** 该角色原本没有聊天室，这次顺带建了一个 */
    sessionCreated?: boolean;
    error?: string;
};

/**
 * 找角色的私聊会话；没有就建一个。
 * 必须连联系人一起补：消息列表按联系人过滤私聊会话，
 * 只建会话不建联系人，卡片会落在一个列表里看不见的会话里。
 */
function resolveCharacterSession(characterId: string): { sessionId: string; created: boolean } {
    const existing = loadChatSessions().find(s => s.isGroup !== true && s.contactId === characterId);
    if (existing) return { sessionId: existing.id, created: false };
    addChatContact(characterId);
    return { sessionId: createOrGetSession(characterId).id, created: true };
}

/**
 * 把一件「我的背包」物品送给角色：
 *   1. 物品归属转到该角色的背包
 *   2. 在该角色的私聊会话里推一张 gift 卡片
 */
export function deliverBackpackItemToCharacter(input: DeliverBackpackItemInput): DeliverBackpackItemResult {
    const { item, targetCharacterId } = input;
    if (!item?.id) return { ok: false, error: "物品不存在" };
    if (!targetCharacterId) return { ok: false, error: "没有选择收礼角色" };

    const targetName = input.targetName || resolveCharacterName(targetCharacterId) || "对方";
    const now = Date.now();
    const sentLabel = formatBackpackTime(now);

    // 先转归属：即使后面发卡片失败，物品也已经到对方手里，不会凭空消失
    const moved = moveBackpackItem(item.id, targetCharacterId);
    if (!moved) return { ok: false, error: "转移物品失败" };

    let sessionId = "";
    let sessionCreated = false;
    try {
        const target = resolveCharacterSession(targetCharacterId);
        sessionId = target.sessionId;
        sessionCreated = target.created;
    } catch (e) {
        console.warn("[backpack] 找不到收礼角色的聊天室", e);
        return { ok: true, error: "礼物已送到，但没能找到他的聊天室，卡片没有发出" };
    }

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
        return { ok: true, messageId: message.id, sessionId, sessionCreated };
    } catch (e) {
        console.warn("[backpack] 送出礼物卡片失败", e);
        // 物品已经转过去了，卡片失败不回收——否则会变成「既没送出去也没留下」
        return { ok: true, sessionId, sessionCreated, error: "礼物已送到，但卡片没能发出来" };
    }
}
