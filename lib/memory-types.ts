// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    accessCount?: number;       // 记忆被检索访问的次数
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: Record<string, unknown>;
};

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    vectorRecallTopK?: number;              // max number of relevant long-term memories recalled per query
    vectorMinScore?: number;                // minimum hybrid score threshold (0.1 - 0.85) for vector recall
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    /** 分应用覆盖上面那个截断量：键是发起请求的 appId（custom_app:xxx 归并成 custom_app），
     *  缺键或值 ≤ 0 时跟随 shortTermTokenBudget。 */
    shortTermTokenBudgetByApp?: Record<string, number>;
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
    };
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。请将以下同一天内发生的事件记录，按「独立话题/事件」拆分为 1 至多条高价值的长期记忆（支持 Markdown 格式）。

角色：{{char}}

事件记录：
{{events}}

严格要求：
1. **按话题拆条（严禁混杂）**：如果当天聊了多个互不相关的独立话题或做了不同的事（例如：聊某本书、讨论电影、日常关心、自习批注、群聊互动等），必须拆分成多条独立记忆，每条记忆之间用单独一行的 \`---\` 分隔。不要把不同话题混在同一条记忆里！
2. **正文中严禁写入任何日期或具体时间**（如“10月23日”、“上午”、“18:03”、“傍晚”等一律不要写，系统会自动记录该记忆发生的日期）。
3. **精炼高价值内容**：使用第三人称描述{{char}}和用户之间的互动，保留关键事实、承诺、情感与关系变化、用户个人偏好/经历与核心观点结论；跳过无意义的寒暄流水账。单条记忆正文控制在 40-120 字左右。
4. **每条记忆末尾必须各自附上「重要性」和「检索关键词」**：
   - **重要性**：1-10 的整数（日常闲聊/小事 4-6，重要偏好/约定/情绪互动 7-8，关系转折/核心设定/重大事件 9-10）
   - **检索关键词**：3-8 个核心词（涵盖该条记忆涉及的人名、作品名、地点、核心事件、物品或主题词，用顿号分隔）

请严格按以下格式输出（不要输出思考过程，多条记忆之间用 \`---\` 分隔）：
（第1条记忆正文，聚焦单一话题或事件，不含任何时间字样）
**重要性**：8
**检索关键词**：关键词1、关键词2、关键词3
---
（第2条记忆正文，聚焦另一个独立话题或事件，不含任何时间字样）
**重要性**：6
**检索关键词**：关键词A、关键词B、关键词C`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

/**
 * Prompt template for cleaning and splitting user-entered manual long text into atomic topic entries.
 * Placeholders: {{char}}, {{eventDate}}, {{content}}
 */
export const DEFAULT_MANUAL_TEXT_CLEAN_PROMPT = `你是一个专业的记忆录入清洗与拆分助手。用户手动录入了一段文本（可能是跨天日志、聊天记录摘录、事件笔记或多段长文），请将其清洗、整理并拆分为 1 至多条「单一独立话题/事件」的长期记忆。

角色：{{char}}
默认参考日期：{{eventDate}}

用户录入原文：
{{content}}

请严格遵守以下规则：
1. **忠于原文事实（严禁编造）**：只能基于用户录入文本中已有的事实、互动、约定、偏好与关系进展进行清洗与精炼，绝不虚构原文没有的细节。
2. **按独立话题或不同日期拆条**：如果原文包含了多件不同的事、多个不同话题或跨越了不同日期的事件，必须拆分成多条独立记忆，每条记忆之间用单独一行的 \`---\` 分隔。如果原文只讲了同一件事，则只整理为 1 条即可。
3. **自动提取事件日期与清除正文时间字样**：
   - 仔细识别原文中出现的日期线索（如“2025年10月24日”、“10.24”、“10月24日”等），将其换算为 \`YYYY-MM-DD\`（若只写了月日，年份默认与参考日期 \`{{eventDate}}\` 一致）写在末尾的 \`**事件日期**\` 字段；若未提到具体日期，则使用参考日期 \`{{eventDate}}\`。
   - **记忆正文中严禁保留任何日期或具体时间字样**（如“10月23日”、“上午”、“18:03”、“傍晚”等一律从正文剔除）。
4. **第三人称精炼表述**：使用第三人称描述{{char}}和用户的互动，保留关键事实、承诺、情感变化与个人偏好，单条正文控制在 40-150 字左右。
5. **每条记忆末尾必须各自附上「事件日期」、「重要性」和「检索关键词」**：
   - **事件日期**：YYYY-MM-DD（从文本提取的日期，若无则填 {{eventDate}}）
   - **重要性**：1-10 的整数（日常闲聊/小事 4-6，重要偏好/约定/情绪互动 7-8，关系转折/核心设定/重大事件 9-10）
   - **检索关键词**：3-8 个核心词（涵盖人名、作品名、地点、核心事件、物品或主题词，用顿号分隔）

请严格按以下格式输出（不要输出任何思考过程或多余开场白，多条记忆之间用 \`---\` 分隔）：
（第1条记忆正文，聚焦单一话题或事件，不含任何时间字样）
**事件日期**：{{eventDate}}
**重要性**：8
**检索关键词**：关键词1、关键词2、关键词3
---
（第2条记忆正文，聚焦另一个独立话题或事件，不含任何时间字样）
**事件日期**：{{eventDate}}
**重要性**：6
**检索关键词**：关键词A、关键词B、关键词C`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    vectorRecallTopK: 15,
    vectorMinScore: 0.38,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    shortTermTokenBudgetByApp: {},
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 4000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
    },
};

/** 分应用截断量的键：所有自定义应用共用一个键，其余按 appId 原样。 */
export function shortTermBudgetKey(appId: string): string {
    return appId === "custom_app" || appId.startsWith("custom_app:") ? "custom_app" : appId;
}

/** 某个应用实际生效的短期记忆截断量。没单独配过就用全局值。 */
export function resolveShortTermTokenBudget(config: MemoryConfig, appId: string): number {
    const override = config.shortTermTokenBudgetByApp?.[shortTermBudgetKey(appId)];
    return typeof override === "number" && Number.isFinite(override) && override > 0
        ? Math.round(override)
        : config.shortTermTokenBudget;
}

/** 各自会取一次短期记忆的应用，分应用截断量按这个列表展示。 */
export const SHORT_TERM_BUDGET_APP_KEYS: string[] = [
    "chat", "group_chat", "story", "vn", "adventure", "game", "reading",
    "moments", "diary", "xiaohongshu", "checkphone", "interview_magazine",
    "cocreate", "calendar", "dwelling", "custom_app",
];
