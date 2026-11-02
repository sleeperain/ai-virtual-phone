// lib/backpack-prompt.ts
// 原生背包 · 角色侧提示词
//
// 把背包物品清单和「可写入的标记」告诉模型，模型在回复文本里写标记，
// 由 lib/backpack-markers.ts 解析执行并从聊天记录里抹掉。

import {
    getEnabledTargetIdsForSource,
    isGroupSessionId,
    loadBackpackItems,
    loadBackpackTargets,
} from "./backpack-storage";
import type { BackpackItem } from "./backpack-types";

const CHAR_ITEM_LIMIT = 50;
const USER_ITEM_LIMIT = 30;
const GROUP_ITEM_LIMIT = 30;
const TRANSFER_TARGET_LIMIT = 20;
const TOTAL_CHAR_LIMIT = 8000;

function sanitizeField(value: unknown, maxLen = 120): string {
    return String(value ?? "")
        .replace(/[\u0000-\u001F\u2028\u2029]/g, "")
        .replace(/[【】\[\]{}<>《》]/g, "")
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLen);
}

function buildItemLine(item: BackpackItem): string {
    const extras: string[] = [];
    if (item.value && item.value !== "--") extras.push(`价值: ${sanitizeField(item.value, 40)}`);
    if (item.source && item.source !== "未标注") extras.push(`来自: ${sanitizeField(item.source, 40)}`);
    const extraStr = extras.length > 0 ? `（${extras.join("，")}）` : "";
    let text = `【${sanitizeField(item.title, 80)}】${extraStr}`;
    if (item.note && String(item.note).trim()) {
        text += `[物品说明/背景备注: ${sanitizeField(item.note, 240)}]`;
    }
    return text;
}

function limitWithNotice(list: BackpackItem[], limit: number): { items: BackpackItem[]; notice: string } {
    if (list.length <= limit) return { items: list, notice: "" };
    return {
        items: list.slice(0, limit),
        notice: `（共${list.length}件，此处仅列出最近${limit}件）`,
    };
}

function commonFormatRules(): string {
    return (
        `【时间字段格式要求（很重要）】\n` +
        `- 时间必须写成具体的"月/日 时:分"格式，例如 09/12 14:30、11/03 08:05，中间有一个空格。\n` +
        `- 严禁使用"今天""昨天""刚才""刚刚""上午""下午""晚上""凌晨"等相对或模糊的时间描述。\n` +
        `- 若只想记录日期，也要写成 09/12 12:00 这样带具体小时分钟的形式；不确定小时分钟就写 12:00。\n\n` +
        `【其它格式要求】\n` +
        `- 各字段之间用英文分号 ; 分隔（不要用竖线 |、顿号、逗号等其它符号）。\n` +
        `- 新增物品示例：[新增物品:草莓味棒棒糖;城南糖果铺;3.50;09/12 14:30;她上次提到喜欢这个口味，我特意买的]\n` +
        `- 新增物品时必须给出全部五项，不能用省略号或用"无"占位，要写出真实、贴合剧情的内容。\n` +
        `- 物品名称必须与背包列表中的名称完全一致，直接写物品名即可，不要额外加【】、书名号或引号。\n` +
        `- 备注标记中的等号必须保留，等号左侧是物品名，右侧是新的备注内容。\n` +
        `- 标记要自然地融入对话，不要解释标记本身，也不要向用户复述标记内容。\n` +
        `- 只有在剧情确实需要时才使用这些标记，不要滥用。`
    );
}

function collectSessionItems(sessionId: string) {
    const items = loadBackpackItems();
    const charItems: BackpackItem[] = [];
    const userItems: BackpackItem[] = [];
    const groupItems: BackpackItem[] = [];

    for (const item of items) {
        if (item.recipient === "character" && item.sessionId === sessionId) {
            if (item.injected) charItems.push(item);
            continue;
        }
        if (item.recipient === "user") {
            if (item.visibleTo.includes(sessionId)) userItems.push(item);
            continue;
        }
        // 群礼物堆是该群自己的公共区域，天然对这个群可见，
        // 不再要求额外配置 visibleTo（老版本要求过，导致礼物堆永远不进提示词）。
        if (item.recipient === "group" && item.sessionId === sessionId) {
            groupItems.push(item);
        }
    }
    return { charItems, userItems, groupItems };
}

function buildPrivatePrompt(sessionId: string, charItems: BackpackItem[], userItems: BackpackItem[]): string {
    const charLim = limitWithNotice(charItems, CHAR_ITEM_LIMIT);
    const itemListText = charLim.items.length === 0
        ? "（目前你的背包是空的）"
        : charLim.items.map(buildItemLine).join("、") + charLim.notice;

    let text =
        `【随身背包物品】\n` +
        `你的随身背包里拥有以下物品：${itemListText}。\n` +
        `请根据物品说明与背景，在日常交谈或相关情境中自然提及或使用。\n\n` +
        `【背包操作能力】\n` +
        `你可以主动操作你和用户各自的背包物品。操作方式是：在回复文本中写入下列特殊标记，` +
        `系统会自动执行并把标记从聊天记录中抹掉，用户看不到标记本身。\n` +
        `1. 把自己背包里的某件物品送给用户 —— 写入：[给予用户:物品名称]\n` +
        `2. 从用户背包中拿走某件物品放进自己背包 —— 写入：[拿取:物品名称]\n` +
        `3. 修改自己背包中某件物品的备注 —— 写入：[背包备注:物品名称=新的备注内容]\n` +
        `4. 往自己的背包里新增一件物品 —— 写入：[新增物品:名称;来源;价值;时间;备注]\n` +
        `5. 修改自己背包里物品的信息（来源、价值、时间、备注）—— 写入：[修改物品:名称;来源;价值;时间;备注]\n` +
        `   —— 只填要修改的字段，不想改的字段留空即可（分号要保留）。例如只改时间：[修改物品:草莓棒棒糖;;;09/12 14:30;]\n` +
        `6. 丢弃自己背包里的某件物品 —— 写入：[丢弃:物品名称]\n` +
        `   —— 该物品会从你的背包中彻底移除。只有剧情确实需要（如物品损坏、用尽、丢失、送还他人等）才使用。\n\n`;

    if (userItems.length > 0) {
        const lim = limitWithNotice(userItems, USER_ITEM_LIMIT);
        text +=
            `【用户背包物品】\n` +
            `你留意到用户的背包里有以下物品：${lim.items.map(buildItemLine).join("、")}${lim.notice}。\n` +
            `（这些是用户自己拥有的物品，你可以自然地在对话中提及或使用，也可以使用上面的[拿取:物品名称]把它们放进你的背包）\n\n`;
    }

    text += commonFormatRules();

    try {
        const enabled = getEnabledTargetIdsForSource(sessionId);
        const others = loadBackpackTargets()
            .filter(t => !t.isUser && !t.isGroup && t.id !== sessionId && enabled.has(t.id))
            .slice(0, TRANSFER_TARGET_LIMIT);

        if (others.length > 0) {
            text +=
                `\n\n【转赠物品给其他角色的能力】\n` +
                `你可以把自己背包里的物品转赠给以下角色（物品会从你的背包转移到对方那里，你就不再拥有它）：\n` +
                others.map(t => `- ${sanitizeField(t.rawName, 40)}`).join("\n") +
                `\n写入：[赠送给角色:角色名;物品名称]\n` +
                `- 角色名必须与上方列表中的名称完全一致；物品名称必须与你背包中的物品名称一致。\n` +
                `- 转赠是真实发生的交接，只有剧情确实需要时才使用，不要滥用。`;
        }
    } catch {
        /* 目标列表读不出来就不提供转赠能力 */
    }

    return truncate(text);
}

function buildGroupPrompt(
    sessionId: string,
    charItems: BackpackItem[],
    userItems: BackpackItem[],
    groupItems: BackpackItem[],
): string {
    const charLim = limitWithNotice(charItems, CHAR_ITEM_LIMIT);
    const itemListText = charLim.items.length === 0
        ? "（目前你的随身背包是空的）"
        : charLim.items.map(buildItemLine).join("、") + charLim.notice;

    let text =
        `【随身背包物品】\n` +
        `你的随身背包里拥有以下物品：${itemListText}。\n` +
        `请根据物品说明与背景，在日常交谈或相关情境中自然提及或使用。\n\n`;

    if (groupItems.length > 0) {
        const lim = limitWithNotice(groupItems, GROUP_ITEM_LIMIT);
        const lines = lim.items.map(item => {
            const giver = sanitizeField(item.giver || "群友", 30);
            return `${buildItemLine(item)}（由 ${giver} 放入）`;
        });
        text +=
            `【群礼物堆（公共区域）】\n` +
            `这个群里累积了一些公共礼物，属于所有群成员共有的区域，明细如下：\n` +
            lines.map(l => `- ${l}`).join("\n") +
            (lim.notice ? `\n${lim.notice}` : "") +
            `\n（这些物品属于群公共区域，不是某个人的私人物品。你可以在对话中自然提及它们；` +
            `若剧情确实需要，也可以使用下面的标记取走，或往群里放入新的公共物品）\n\n`;
    } else {
        text +=
            `【群礼物堆（公共区域）】\n` +
            `这个群目前还没有人放入公共礼物。你可以在剧情需要时往群里放入一件公共物品。\n\n`;
    }

    if (userItems.length > 0) {
        const lim = limitWithNotice(userItems, USER_ITEM_LIMIT);
        text +=
            `【用户背包物品】\n` +
            `你留意到用户的背包里有以下物品：${lim.items.map(buildItemLine).join("、")}${lim.notice}。\n\n`;
    }

    text +=
        `【群聊内的物品操作能力】\n` +
        `在群聊里，除了可以操作自己背包里的物品，你还可以操作群礼物堆这个公共区域。` +
        `操作方式是：在回复文本中写入下列特殊标记，系统会自动执行并把标记从聊天记录中抹掉，用户看不到标记本身。\n` +
        `1. 从群礼物堆里取走某件物品放进自己的背包 —— 写入：[拿取:物品名称]\n` +
        `   —— 物品名称必须与群礼物堆明细中的名称完全一致。取走后这件物品就归你所有，不再留在群里。\n` +
        `2. 往群礼物堆里放入一件新的公共物品 —— 写入：[新增物品:名称;来源;价值;时间;备注]\n` +
        `   —— 表示你往群里添置了一件对所有群成员公开的物品。只有当剧情里确实发生了"往群里放东西"这件事时才使用。\n` +
        `3. 从自己背包中拿一件物品送给用户 —— 写入：[给予用户:物品名称]\n` +
        `4. 从用户背包中拿走某件物品放进自己背包 —— 写入：[拿取:物品名称]\n` +
        `5. 修改自己背包中某件物品的备注 —— 写入：[背包备注:物品名称=新的备注内容]\n` +
        `6. 修改自己背包里物品的信息（来源、价值、时间、备注）—— 写入：[修改物品:名称;来源;价值;时间;备注]\n` +
        `   —— 只填要修改的字段，不想改的字段留空即可（分号要保留）。例如只改时间：[修改物品:草莓棒棒糖;;;09/12 14:30;]\n` +
        `7. 丢弃自己背包里的某件物品 —— 写入：[丢弃:物品名称]\n\n` +
        `（注意：群聊里不要把私人背包物品直接"转赠"给其他会话的角色，也不要把群礼物堆当成你自己可以随意处置的私产。）\n\n`;

    text += commonFormatRules();
    return truncate(text);
}

function truncate(text: string): string {
    if (text.length <= TOTAL_CHAR_LIMIT) return text;
    return text.slice(0, TOTAL_CHAR_LIMIT) + "\n（提示词过长，已截断后续内容）";
}

/** 生成某个会话的背包提示词片段；无内容返回空串 */
export function buildBackpackPromptForSession(sessionId: string): string {
    if (!sessionId) return "";
    const { charItems, userItems, groupItems } = collectSessionItems(sessionId);
    const hasAnything = charItems.length > 0 || userItems.length > 0 || groupItems.length > 0;
    if (!hasAnything) return "";
    return isGroupSessionId(sessionId)
        ? buildGroupPrompt(sessionId, charItems, userItems, groupItems)
        : buildPrivatePrompt(sessionId, charItems, userItems);
}
