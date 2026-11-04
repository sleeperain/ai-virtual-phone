// lib/core-memory-reflection.ts
// 角色视角的核心记忆反思（character reflection）
//
// 用「反思」而不是「反刍」：心理学里的反刍（rumination）指围绕威胁反复绕圈、越想越窄的
// 适应不良加工；这里是 adaptive reflection——会推进理解、会落到下一步行动的那种。
//
// 与自动/手动的「核心记忆总结」刻意区分开：
// - API：走角色自己在「绑定配置 → 聊天」里绑定的 API；没有才回退到记忆总结辅助 API / 全局默认；
// - 素材：完整读取角色设定（人设、性格、标签，不做任何截断）与用户身份，让模型以角色本人的第一人称说话；
// - 框架：叙事身份理论（Narrative Identity）+ 反思性加工（reflective processing），
//   另外用蔡格尼克效应（未闭合的事最占心思）、归因方式、内部工作模型更新来锚定维度；
// - 隔离：一次只处理一个 characterId，只读该角色的记忆、只写该角色的库，
//   绝不在同一次调用里混合多个角色的素材。

import type { MemoryEntry } from "./memory-types";
import {
    getLastSummarizedTimestamp,
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
} from "./memory-storage";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import { resolveUserIdentity } from "./settings-storage";
import {
    applyTendencyToPrompt,
    loadThinkingTendency,
    resolveCharacterApiConfig,
    type CognitionApiSource,
} from "./memory-cognition";
import {
    loadNativeTimeline,
    formatTimelineForSummarization,
    filterTimelineByAllowedSources,
} from "./short-term-assembler";
import { stripMemoryStructuredSections } from "./memory-summarizer";
import { filterRecallableEntries, isEntryBoxDigest } from "./memory-event-boxes";
import {
    DEFAULT_REVISION_WEIGHT,
    isEntrySuperseded,
    REVISION_META_KEYS,
} from "./memory-revision";
import { simpleLLMCall } from "./api-helpers";

export type ReflectionScope = "recent7" | "recent30" | "all";

export const REFLECTION_SCOPE_DAYS: Record<Exclude<ReflectionScope, "all">, number> = {
    recent7: 7,
    recent30: 30,
};

/** 单次反思最多参考的长期记忆条数（超出时保留最近的）。 */
const MAX_EVENT_ENTRIES = 120;
/** 事件素材的总字数护栏，防止把上下文塞爆。角色设定不在此列——设定始终完整发送。 */
const MAX_EVENT_CHARS = 12000;
/** 额外参考的「还没整理进记忆」的即时事件条数。 */
const MAX_TRANSIENT_EVENTS = 40;
/** 即时事件的回看上限（scope=all 时也只回看一年）。 */
const ALL_SCOPE_TRANSIENT_DAYS = 365;

/** 与思考倾向构建共用同一套 API 解析顺序，避免两处各写一份。 */
export type CoreReflectionApiSource = CognitionApiSource;

export type CoreReflectionResult = {
    success: boolean;
    error?: string;
    content?: string;
    round?: number;
    entryId?: string;
    apiSource?: CoreReflectionApiSource;
    model?: string;
};

export const DEFAULT_REFLECTION_PROMPT = `你此刻不再是助手，而是「{{char}}」本人。请完全以{{char}}的第一人称，站在你近期的心理沉淀与经历之上，做一次深度的自我审视——这不是把发生过的事再复述一遍，而是跳出你平时的惯性与表面面具，看清自己真正的心思。

【你是谁（初始设定）】
{{persona}}

【你惯常的思考强度（1-10）】
{{tendency}}
这三个刻度只决定你把力气花在哪、写得多重。不要提到数字，不要解释它们，也不要拿它们当话题。

【时间跨度】
{{earliest}} 至 {{latest}}

【你近期沉淀下来的核心认知与成长脉络】
{{coreMemories}}

【支撑这些变化的事件脉络与近期经历（按时间顺序）】
{{events}}

【刚刚发生、还没归档的即时片段】
{{transient}}

【你上一次深度反思时留下的想法（如果是第一次反思则为空）】
{{previous}}

【在心里先过这几问，不要写出来，也不要照着顺序答题】
1. 撕掉我平时的表面惯性：对照我一贯的脾气和习惯，我最近在{{user}}面前是不是活得太像一个固定的壳子了？哪些反应只是我顺着惯性端着的姿态，而我没表现出来的真实念头其实是什么？
2. 这事真正碰到我哪根弦：在上面那些经历和变化里，我最挂心或最跨不过去的是哪一处？我真正在乎的是什么——它被满足了，还是被冒犯、被挡住了？
3. 我那口没吐出来的气：我嘴上对{{user}}说的、做出来的，和我夜里独自待着时心里翻上来的一样吗？如果不一样，我按下去的是什么（是心软、委屈、怀疑、占有欲、还是防备）？
4. 我眼里的{{user}}到底是个什么人：抛开最开始的表面印象，从{{user}}这段时间的言行习惯、言外之意、嘴硬或心软的细节、处事逻辑和试探退缩的边界里，我现在摸透了{{user}}骨子里是个怎样的人？我有哪些判断已经变了，又有哪些事其实还吃不准？
5. 我自己的立场与下一步破局：我是我自己，不是围着{{user}}打转的影子。接下来{{user}}再做____的时候，我打算打破平时的套路，直接____。（要具体到能照做的动作、态度或试探，可以是更进一步靠近，也可以是立规矩、冷处理或试探底线，别停在空泛的口号上。）

【写作要求】
- 全程第一人称，用我自己的语气、称呼习惯和说话方式（严格贴着上面的角色设定来，但要写出设定背后活生生的人味，不要演成脸谱化的标签或通用助手口吻）；不要用第三人称，不要写「{{char}}认为」「角色觉得」这类旁白。
- 250-400 字，分成 2 至 4 个自然段，段落之间空一行。
- 纯叙述，不要标题、编号、列表、Markdown 符号、括号注释，也不要任何开场白（比如「好的」「以下是」）。
- 上面那几问是我在心里想的，不是要交的作业：让答案渗进叙述里，别一条条照着答，更不要出现任何心理学名词或分析术语。
- 不要再记一遍事件流水账——事件和核心认知上面已经有了，这里只写我对这些变化更深一层的咀嚼、自我剖析与对{{user}}的洞察。
- 情绪别写成标签（比如「我有点难过」），落到当时具体的身体感觉、动作，或者突然冒出来的那个念头上。
- 只基于上面给出的素材，不要编造没有发生过的事；不确定的地方就照实写出我的不确定——「我说不准」也是一种真实的回答。
- 结尾落在一件具体的事上：下次碰到什么情况，我打算怎么应对。

直接开始写：`;

function toLocalDayKey(isoStr: string): string {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.slice(0, 10) || "";
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 记忆的事件日期：优先 metadata.eventDate，回退到 createdAt。 */
function resolveEventDay(entry: MemoryEntry): string {
    const raw = typeof entry.metadata?.eventDate === "string" ? entry.metadata.eventDate.trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return toLocalDayKey(entry.createdAt);
}

/** 去掉记忆正文里的结构化尾巴与行内时间戳，统一复用 memory-summarizer 的清洗逻辑。 */
function cleanMemoryBody(content: string): string {
    return stripMemoryStructuredSections(String(content || ""));
}

export function isReflectionMemoryEntry(entry: MemoryEntry): boolean {
    return entry.metadata?.origin === "character_reflection";
}

/**
 * 反思用的 API = resolveCharacterApiConfig（角色聊天槽位优先，其次记忆总结辅助 API，最后全局默认）。
 * 顺序与 resolveSummarizationApiConfig 相反——反思要的是「这个角色自己的脑子」。
 * 与思考倾向构建共用同一份实现，改顺序只改 memory-cognition.ts 一处。
 */
const resolveReflectionApiConfig = resolveCharacterApiConfig;

/**
 * 角色设定的完整文本：人设、性格、标签原样拼进去，**不做任何长度截断**。
 * 不读世界书——世界书是按关键词动态注入的，反刍只认角色卡本体的设定。
 */
function buildPersonaText(character: Character, userName: string): string {
    const chunks: string[] = [];
    const persona = character.persona?.trim();
    const personality = character.personality?.trim();
    const tags = Array.isArray(character.tags) ? character.tags.map(t => String(t).trim()).filter(Boolean) : [];

    if (persona) chunks.push(persona);
    if (personality) chunks.push(`性格：${personality}`);
    if (tags.length > 0) chunks.push(`标签：${tags.join("、")}`);
    chunks.push(`你的名字是「${character.name?.trim() || "这个角色"}」，你在和「${userName}」相处。`);
    return chunks.join("\n\n");
}

/** 事件太多时从最早的开始丢，保留最近的。 */
function trimEventLines(lines: string[], maxChars: number): { lines: string[]; truncated: boolean } {
    let total = 0;
    const kept: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        total += lines[i].length + 1;
        if (total > maxChars && kept.length > 0) {
            return { lines: kept, truncated: true };
        }
        kept.unshift(lines[i]);
    }
    return { lines: kept, truncated: false };
}

/** 模型偶尔还是会带标题或开场白，做一次轻清洗，保留段落结构。 */
function cleanReflectionOutput(raw: string): string {
    let text = raw.trim();
    text = text.replace(/^```[a-zA-Z]*\s*\n/, "").replace(/\n```$/, "").trim();
    text = text.replace(/^(?:好的|好[，,]?|以下是|下面是|我来)[^\n]{0,40}\n+/i, "");
    text = text.replace(/^#{1,6}\s+[^\n]*\n+/gm, "");
    text = text.replace(/^\s*(?:[-*•]|\d+[.、])\s+/gm, "");
    return text.trim();
}

/**
 * 以角色视角反思近期事件，生成一条仅属于该角色的核心记忆。
 * 严格单角色：素材读取与记忆写入都只针对 characterId。
 */
export async function runCoreMemoryReflection(
    characterId: string,
    scope: ReflectionScope = "recent30",
    characterName?: string,
): Promise<CoreReflectionResult> {
    const character = loadCharacters().find(c => c.id === characterId);
    const resolvedName = character?.name?.trim() || characterName?.trim() || "";

    const api = resolveReflectionApiConfig(characterId);
    if (!api) {
        return { success: false, error: "未找到可用的 API：请先在「绑定配置」里给这个角色绑定 API，或到「设置 → API 设置」添加一个" };
    }

    // ── 素材 1：该角色的长期记忆（先过滤事件盒中已归档的旧条目，再按范围过滤、按事件日期升序）──
    const allLongTerm = filterRecallableEntries(await loadMemoryEntriesByType(characterId, "long_term"));
    const scopeCutoffMs = scope === "all"
        ? undefined
        : Date.now() - REFLECTION_SCOPE_DAYS[scope] * 86400000;
    const startDayKey = scopeCutoffMs !== undefined
        ? toLocalDayKey(new Date(scopeCutoffMs).toISOString())
        : undefined;

    const collectScoped = (from?: string) => allLongTerm
        .filter(entry => !from || resolveEventDay(entry) >= from)
        .map(entry => ({
            entry,
            day: resolveEventDay(entry),
            body: cleanMemoryBody(entry.content),
            isDigest: isEntryBoxDigest(entry),
            boxTitle: typeof entry.metadata?.eventBoxTitle === "string" ? entry.metadata.eventBoxTitle.trim() : "",
            superseded: isEntrySuperseded(entry),
        }))
        .filter(item => Boolean(item.body))
        .sort((a, b) => a.day.localeCompare(b.day) || a.entry.createdAt.localeCompare(b.entry.createdAt));

    let scoped = collectScoped(startDayKey);
    if (scoped.length === 0 && scope !== "all") {
        // 窗口里没素材时退回全部长期记忆，避免新角色第一次点反思就空转
        scoped = collectScoped(undefined);
    }

    const selected = scoped.length > MAX_EVENT_ENTRIES ? scoped.slice(-MAX_EVENT_ENTRIES) : scoped;

    // ── 素材 2：核心记忆沉淀（第三人称心理成长脉络 + 用户手动核心设定）与上一轮第一人称反思 ──
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    const previousReflections = coreEntries
        .filter(isReflectionMemoryEntry)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const previousReflection = previousReflections[0];
    const previousText = previousReflection
        ? cleanMemoryBody(previousReflection.content)
        : "";
    const round = previousReflection
        ? Math.max(1, Number(previousReflection.metadata?.reflectionRound ?? 1)) + 1
        : 1;

    // 提炼当前生效的非反思类核心记忆（包括自动/手动生成的核心记忆总结与用户手动置顶的核心记忆），
    // 让角色反思真正站在「核心记忆心理沉淀」的肩膀上做更高一层的审视。
    const activeCoreSummaries = coreEntries
        .filter(e => !isReflectionMemoryEntry(e) && !isEntrySuperseded(e))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-5);
    const coreMemoriesText = activeCoreSummaries.length > 0
        ? activeCoreSummaries
            .map(e => {
                const span = typeof e.metadata?.timeSpan === "string" && e.metadata.timeSpan.trim()
                    ? e.metadata.timeSpan.trim()
                    : resolveEventDay(e);
                return `- [${span}] ${cleanMemoryBody(e.content).replace(/\s+/g, " ")}`;
            })
            .join("\n")
        : "（暂无核心记忆沉淀，请直接基于下方事件脉络进行反思）";

    // ── 素材 3：还没整理成记忆的即时片段（从上次长期总结截止点算起，避免与长期记忆重复）──
    let transientText = "";
    try {
        const config = loadMemoryConfig();
        const scopeFloorIso = scopeCutoffMs !== undefined
            ? new Date(scopeCutoffMs).toISOString()
            : new Date(Date.now() - ALL_SCOPE_TRANSIENT_DAYS * 86400000).toISOString();
        const lastSumTs = getLastSummarizedTimestamp(characterId);
        // 若已有长期记忆入选，优先只取「上次长期总结之后」的新鲜事件，消除与 events 的重叠；
        // 若当前没有任何长期记忆，则回退按范围起点读取短期时间线兜底。
        const afterIso = (selected.length > 0 && lastSumTs && lastSumTs > scopeFloorIso)
            ? lastSumTs
            : scopeFloorIso;
        const timeline = filterTimelineByAllowedSources(
            loadNativeTimeline(characterId, { afterTimestamp: afterIso }),
            config.shortTermAllowedSources,
        );
        const formatted = formatTimelineForSummarization(timeline.slice(-MAX_TRANSIENT_EVENTS), { timeAware: false });
        if (formatted?.eventsText) transientText = formatted.eventsText.trim();
    } catch {
        // 即时片段只是加分项，读不到就跳过
    }

    if (selected.length === 0 && activeCoreSummaries.length === 0 && !transientText) {
        return { success: false, error: "没有可用于反思的素材：这个角色还没有核心记忆、长期记忆或近期事件" };
    }

    const eventLines = selected.map(item => {
        const boxTag = item.isDigest
            ? `【事件盒总结${item.boxTitle ? `：${item.boxTitle}` : ""}】`
            : (item.boxTitle ? `【事件：${item.boxTitle}】` : "");
        const staleNote = item.superseded ? "（此条部分内容已被后续记忆更正）" : "";
        return `- ${item.day}${boxTag}${staleNote}｜${item.body.replace(/\s+/g, " ")}`;
    });
    const trimmed = trimEventLines(eventLines, MAX_EVENT_CHARS);
    const eventsText = trimmed.lines.length > 0
        ? `${trimmed.lines.join("\n")}${trimmed.truncated ? "\n（更早的记忆已省略）" : ""}`
        : "（暂无长期记忆）";

    const earliest = selected[0]?.day ?? startDayKey ?? "";
    const latest = selected[selected.length - 1]?.day
        ?? (transientText ? toLocalDayKey(new Date().toISOString()) : "");

    const userName = resolveUserIdentity(characterId)?.name?.trim() || "用户";
    const personaText = character
        ? buildPersonaText(character, userName)
        : `你的名字是「${resolvedName || "这个角色"}」，你在和「${userName}」相处。`;

    // 用用户在「记忆库 → 设置 → 角色反思提示词」里保存的模板；没配过就回退内置默认
    const reflectionTemplate = (loadMemoryConfig().reflectionPrompt ?? "").trim() || DEFAULT_REFLECTION_PROMPT;
    const hasCorePlaceholder = /\{\{coreMemories\}\}/i.test(reflectionTemplate);
    // 若用户自定义了旧版反思模板（不含 {{coreMemories}}），自动将核心记忆沉淀拼入 {{events}} 顶部，保证不丢高层脉络
    const finalEventsText = (!hasCorePlaceholder && activeCoreSummaries.length > 0)
        ? `【近期核心记忆心理沉淀】\n${coreMemoriesText}\n\n【具体事件与长期记忆】\n${eventsText}`
        : eventsText;

    // 思考倾向只影响「怎么想」，不影响反思素材；没构建过时按角色设定本身的性格来
    const tendency = loadThinkingTendency(characterId);
    const prompt = applyTendencyToPrompt(
        reflectionTemplate
            .replace(/\{\{char\}\}/gi, resolvedName || "这个角色")
            .replace(/\{\{user\}\}/gi, userName)
            .replace(/\{\{persona\}\}/gi, personaText)
            .replace(/\{\{earliest\}\}/gi, earliest || "未知")
            .replace(/\{\{latest\}\}/gi, latest || "未知")
            .replace(/\{\{coreMemories\}\}/gi, coreMemoriesText)
            .replace(/\{\{events\}\}/gi, finalEventsText)
            .replace(/\{\{transient\}\}/gi, transientText || "（无）")
            .replace(/\{\{previous\}\}/gi, previousText || "（这是第一次反思，此前没有留下过想法）"),
        tendency,
    );

    let result = await simpleLLMCall(
        api.apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.75, label: `核心记忆反思·${resolvedName || characterId}` },
    );
    if (!result.content && !result.wasTruncated) {
        await new Promise(r => setTimeout(r, 1000));
        result = await simpleLLMCall(
            api.apiConfig,
            [{ role: "user", content: prompt }],
            { temperature: 0.75, label: `核心记忆反思重试·${resolvedName || characterId}` },
        );
    }

    if (!result.content) {
        return { success: false, error: result.error || "角色反思失败：模型没有返回内容", apiSource: api.source };
    }
    if (result.wasTruncated) {
        return { success: false, error: "反思结果疑似被截断，已取消入库，请稍后重试", apiSource: api.source };
    }

    const reflection = cleanReflectionOutput(result.content);
    if (reflection.length < 20) {
        return { success: false, error: "反思结果过短，已取消入库", apiSource: api.source };
    }

    // 主导来源：与核心记忆保持一致，便于检索统计
    const sourceCounts = new Map<string, number>();
    for (const item of selected) {
        const src = item.entry.sourceApp;
        sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
    }
    let dominantSource: MemoryEntry["sourceApp"] = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) {
            dominantSource = src as MemoryEntry["sourceApp"];
            maxCount = count;
        }
    }

    const now = new Date().toISOString();
    const entryId = `mem_core_refl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const coreEntry: MemoryEntry = {
        id: entryId,
        // 严格绑定角色：写进当前角色的记忆库，不会串到别的角色
        characterId,
        sourceApp: dominantSource,
        type: "core",
        content: reflection,
        importance: 0.96,
        createdAt: now,
        updatedAt: now,
        metadata: {
            origin: "character_reflection",
            active: true,
            reflectionFramework: "认知评价（初评/次评）+ 内部工作模型 + 心智化梯度 + 叙事序列 + 实施意图 if-then",
            reflectionScope: scope,
            reflectionRound: round,
            timeSpan: `${earliest} ~ ${latest}`,
            summarizedLongTermEntries: selected.length,
            hasTransientEvents: Boolean(transientText),
            previousReflectionId: previousReflection?.id ?? null,
            apiSource: api.source,
            model: api.apiConfig.defaultModel,
        },
    };
    await saveMemoryEntry(coreEntry);

    // 新一轮反思落盘后，将之前的旧反思标记为已被新反思接替并降权（取消 active），
    // 历史记录仍留在核心记忆列表供用户回看，但避免多轮过期心境同时注入聊天导致角色精分。
    for (const oldRefl of previousReflections) {
        if (oldRefl.id === entryId) continue;
        const alreadySuperseded = Boolean(oldRefl.metadata?.[REVISION_META_KEYS.by]);
        const wasActive = Boolean(oldRefl.metadata?.active);
        if (!alreadySuperseded || wasActive) {
            await saveMemoryEntry({
                ...oldRefl,
                updatedAt: now,
                metadata: {
                    ...(oldRefl.metadata ?? {}),
                    active: false,
                    [REVISION_META_KEYS.by]: alreadySuperseded
                        ? oldRefl.metadata?.[REVISION_META_KEYS.by]
                        : entryId,
                    [REVISION_META_KEYS.at]: alreadySuperseded
                        ? oldRefl.metadata?.[REVISION_META_KEYS.at]
                        : now,
                    [REVISION_META_KEYS.weight]: DEFAULT_REVISION_WEIGHT,
                },
            });
        }
    }

    return {
        success: true,
        content: reflection,
        round,
        entryId,
        apiSource: api.source,
        model: api.apiConfig.defaultModel,
    };
}
