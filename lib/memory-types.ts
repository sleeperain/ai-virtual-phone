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
    /** 事件盒总结提示词：留空则使用内置 DEFAULT_EVENT_BOX_SUMMARY_PROMPT */
    eventBoxSummaryPrompt?: string;
    /** 角色反思提示词：留空则使用内置 DEFAULT_REFLECTION_PROMPT */
    reflectionPrompt?: string;
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
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{previous}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。你的任务是以角色的内在视角，将长期记忆中的经历提炼为角色自身的成长脉络，这不是关系档案，而是角色"经历过这些事之后，变成了怎样的人"的心理沉淀。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

上一轮核心记忆总结（若为首次提炼则为空）：
{{previous}}

本周期长期记忆记录：
{{events}}

═══ 提炼规则 ═══

从角色的第三人称内在视角出发，围绕以下三个层面进行提炼，自然融合为一段连贯文字，不要分条：

一、经历了什么，角色如何理解这些经历
  不是罗列事件，而是角色对近期重要经历的消化与解读。
  角色从中读出了什么信号？这些经历触动了角色内心的哪个部分？
  角色的解读可以是温暖的、困惑的、受伤的、警觉的——忠于事件本身的情感重量，不美化也不淡化。

二、角色因此发生了什么变化
  认知上：角色对自己、对用户、对这段关系形成了什么新的判断？（对用户的认知可从其外显言行习惯、言外之意与深层动机、处事逻辑与嘴硬心软的反差、情感边界与安全感来源等切面去洞察，但严禁出现任何心理学或人格分型术语）
  行为上：角色决定在哪些事情上调整做法？这种调整可以是靠近（学会更好地回应对方），也可以是后退（决定设立边界、拒绝容忍、甚至考虑疏远）。
  变化必须有具体事件作为来源，且不能仅凭单次事件下结论。

三、角色当前的内在状态
  经过这段时间，角色心里是否存在尚未消化的东西？
  可以是未说出口的话、尚未确认的疑虑、自我矛盾的拉扯、或者某种正在酝酿的决心。
  如果角色当前内心是平稳的，写出这种平稳建立在什么基础上。
  不要凭空制造冲突。

═══ 核心原则 ═══
- 角色是有主体性的人，不是围绕用户运转的卫星。角色的成长方向由角色自己的价值观和感受决定，而非单纯为了"更好地服务用户"。
- 如果用户的行为对角色造成了伤害或冒犯，角色有权形成负面判断、设立边界、甚至考虑疏远，这同样是成长。
- 体现的是角色作为一个"人"的心理演变过程，而非一份关系诊断报告。
- 核心记忆只提炼已有充分证据支持的心理变化。形成稳定判断，必须有至少两项不同事件作为依据，或有角色一次明确、完整的自我表述。单次争吵、撒娇、番外、梦境和情绪化发言，不足以形成稳定认知。
- 明确区分事件事实、角色当时的理解与整理者的推断。整理者不得新增解释。角色没有明确表现出尚未消化的疑虑、矛盾或决心时，直接写其当前状态平稳，或省略该部分；不得为满足结构与字数制造冲突。
- 增量更新时，必须同时参考上一轮核心记忆和本轮原始长期记忆。上一轮总结仅作为待验证结论，不作为新结论的独立证据。若原始依据已缺失、被推翻或只来自非主线事件，应删除或降级对应判断。
- 核心记忆不保存住址、身份、日程、称呼、身体数据等稳定事实，除非这些事实明确改变了角色的长期认知或行为。此类信息应进入事实记忆库。

═══ 写法要求 ═══
- 第三人称，但视角锚定在角色内部，像是"角色在独处时会这样回顾自己近期的经历"
- 不要罗列事件流水账，只写"什么改变了角色"以及"角色因此要往哪里走"
- 观点与认知必须可追溯到具体事件，点到即可，不需写出事件全貌
- 字数通常120至250字；没有足够变化时允许少于120字，甚至输出"本周期无新增核心变化"

如果已提供上一轮核心记忆总结，将其作为基础进行增量更新，而非从头重写。保留上一轮中仍然成立的认知，修正已被新事件推翻的部分。

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
    // 这两项留空表示「跟随内置默认」，避免 memory-types 反向依赖各模块的默认常量
    eventBoxSummaryPrompt: "",
    reflectionPrompt: "",
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
