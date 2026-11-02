// lib/backpack-prompt.ts
// 原生背包 · 角色侧提示词
//
// 每个角色一份：他自己的背包 + 他知道的用户物品。
// 群聊一次请求里，这个函数会按成员逐份注入（各成员只看到自己那份），
// 所以这里不需要也不应该出现「群礼物堆」这种公共区域。

import {
    getEnabledTargetIdsForSource,
    loadBackpackItems,
    loadCharacterTargets,
} from "./backpack-storage";
import type { BackpackItem } from "./backpack-types";

const CHAR_ITEM_LIMIT = 50;
const USER_ITEM_LIMIT = 30;
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

function truncate(text: string): string {
    if (text.length <= TOTAL_CHAR_LIMIT) return text;
    return text.slice(0, TOTAL_CHAR_LIMIT) + "\n（提示词过长，已截断后续内容）";
}

export type BackpackPromptOptions = {
    /** 群聊里说明「这是谁的那份」，避免模型把多个成员的背包搞混 */
    memberName?: string;
    /** 群聊里禁用「转赠给其他角色」：那会跨出当前场景，容易乱 */
    allowTransferToCharacters?: boolean;
};

/**
 * 生成某个角色的背包提示词片段。
 * 该角色没有任何物品、也不知道用户的任何物品时返回空串（不占提示词）。
 */
export function buildBackpackPromptForCharacter(
    characterId: string,
    options: BackpackPromptOptions = {},
): string {
    if (!characterId) return "";

    const items = loadBackpackItems();
    const ownItems = items.filter(it => it.recipient === "character" && it.characterId === characterId && it.injected);
    const userItems = items.filter(it => it.recipient === "user" && it.visibleTo.includes(characterId));

    if (ownItems.length === 0 && userItems.length === 0) return "";

    const ownLim = limitWithNotice(ownItems, CHAR_ITEM_LIMIT);
    const ownListText = ownLim.items.length === 0
        ? "（目前你的背包是空的）"
        : ownLim.items.map(buildItemLine).join("、") + ownLim.notice;

    const ownerLabel = options.memberName ? `${options.memberName}的随身背包` : "你的随身背包";

    let text =
        `【${ownerLabel}】\n` +
        `${options.memberName ? "这个角色" : "你"}的随身背包里拥有以下物品：${ownListText}。\n` +
        `请根据物品说明与背景，在日常交谈或相关情境中自然提及或使用。\n\n` +
        `【背包操作能力】\n` +
        `你可以主动操作${options.memberName ? "自己" : "你和用户各自"}的背包物品。操作方式是：在回复文本中写入下列特殊标记，` +
        `系统会自动执行并把标记从聊天记录中抹掉，用户看不到标记本身。\n` +
        `1. 把自己背包里的某件物品送给用户 —— 写入：[给予用户:物品名称]\n` +
        `   —— 送出后系统会在聊天里发一张礼物卡片。\n` +
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
            `（这些是用户自己拥有的物品，你可以自然地在对话中提及或使用，也可以使用上面的[拿取:物品名称]把它们放进自己的背包）\n\n`;
    }

    text += commonFormatRules();

    if (options.allowTransferToCharacters !== false) {
        try {
            const enabled = getEnabledTargetIdsForSource(characterId);
            const others = loadCharacterTargets(characterId)
                .filter(t => t.characterId && enabled.has(t.characterId))
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
    }

    return truncate(text);
}


