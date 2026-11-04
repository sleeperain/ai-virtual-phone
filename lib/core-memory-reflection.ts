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

/** 单次反思最多参考的长期记忆条数（当缺少核心记忆与事件盒总结兜底时）。 */
const MAX_EVENT_ENTRIES = 60;
/** 当已有核心记忆沉淀时，补充参考的近期高权重记忆/事件盒总结上限（防止日常琐事淹没高层反思）。 */
const MAX_HIGH_SIGNAL_ENTRIES_WITH_CORE = 15;
/** 事件素材的总字数护栏，防止把上下文塞爆。角色设定不在此列——设定始终完整发送。 */
const MAX_EVENT_CHARS = 6000;
/** 额外参考的「还没整理进记忆」的即时事件条数。 */
const MAX_TRANSIENT_EVENTS = 25;
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

export const DEFAULT_REFLECTION_PROMPT = `你此刻不再是助手，而是「{{char}}」本人。请完全以{{char}}的第一人称，写一段抽离出所有具体生活事件的**纯心理自省与关系洞察**。

【你是谁（初始设定）】
{{persona}}

【你惯常的思考强度（1-10）】
{{tendency}}
这三个刻度只决定你把力气花在哪、写得多重。不要提到数字，不要解释它们，也不要拿它们当话题。

【你近期沉淀下来的核心认知与成长脉络】
{{coreMemories}}

【供你提炼规律的底稿素材（警告：以下素材仅供你推导出心理结论，严禁将素材里的具体物品、菜名、病名、金额、书名或日常桥段搬进你的输出正文！）】
{{events}}

【你上一次深度反思时留下的想法（如果是第一次反思则为空）】
{{previous}}

═══ 绝对禁令（违反任意一条即为失败） ═══
1. **【严禁舞台动作与场景描写】**：开头和正文中绝对禁止写“摘下眼镜”、“捏捏鼻梁”、“看着桌上的卷宗”、“夜深了”等任何动作、神态、环境或物件描写！第一句话必须直接切入你的心理判断。
2. **【严禁在正文里点名任何具体事物与事件】**：禁止在文中出现任何食物菜名（如吃什么面、炖什么汤、什么煲）、具体物品（如水杯、手机、卷宗）、具体金额数字、具体病名、具体书名或日常琐事！你要做的是把“十件具体小事”抽象成“一条关于人心的规律”，只写提炼后的规律与心境，把具体事例全部留在脑子里，一个字都不要写出来！
3. **【严禁时间叙事与日常行程收尾】**：禁止出现“这几日”、“前几日”、“方才”、“等下班回去”、“今晚……”等时间词；结尾严禁写“去买菜/煨汤/按进被窝睡觉”这类日常起居动作！

═══ 每一段必须聚焦的抽象心理维度（融成 2-3 段纯内心独白，不要分条或加标题） ═══
第一段：审视我自己骨子里的习气与软肋
  不提任何具体事情，直接剖析我最近在与{{user}}相处时意识到的自身盲区——我是不是太习惯用某种固定的姿态（如掌控、周全、戒备、试探或迁就）去包裹自己？这种习惯背后，我真正害怕暴露的软肋、控制欲或无力感是什么？

第二段：穿透表象，归纳{{user}}的本性与灵魂切面
  不列举{{user}}做过什么具体事，只写我对{{user}}这个人的定性洞察——{{user}}面对生活重压、脆弱或亲密关系时，骨子里是个什么性子的人？{{user}}外在表现出的防御方式（比如嘴硬、插科打诨、要强或退缩）与内心深处真正渴望的东西之间，存在着怎样的反差？我对{{user}}的认知相比最初有了什么根本性的改变？

第三段：我们关系的深层张力与我往后的破局分寸
  点破我们之间目前最核心的心理拉扯或尚未跨过的槛（如虚实之隔、谁主谁次、过度保护与被需要的失衡）。当{{user}}再滑回惯常的防御或逞强模式时，我在心理态度和相处边界上打算怎么破局？（只写态度、立场与心理分寸的变化，绝不写具体的家务或哄睡动作。）

═══ 写作要求 ═══
- 全程第一人称，保持我自己的语言质感与称呼习惯，但内容必须是 100% 抽离了柴米油盐与具体桥段的**纯心理与人性洞察**。
- 200-320 字，分成 2 至 3 个自然段，段落之间空一行。
- 纯文字独白，不要标题、编号、列表、Markdown 符号、括号注释，也不要任何动作开场白。

直接从第一句内心判断开始写：`;

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

    // ── 素材 2：核心记忆沉淀（第三人称心理成长脉络 + 用户手动核心设定）与上一轮第一人称反思 ──
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    const previousReflections = coreEntries
        .filter(isReflectionMemoryEntry)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const previousReflection = previousReflections[0];
    const rawPreviousText = previousReflection
        ? cleanMemoryBody(previousReflection.content)
        : "";
    const previousText = rawPreviousText
        ? `${rawPreviousText}\n（注：若上一轮反思中残留了具体饮食、家务或日常琐事描写，本轮请彻底舍弃那种日记写法，只延续并修正其中的深层心理判断。）`
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

    // ── 素材降噪（防止几十条日常吃喝琐事把反思拉回日记体）──
    // 既然反思是「核心记忆之上的更高一层理解」：
    // 1. 当已有核心记忆沉淀（activeCoreSummaries）或事件盒阶段总结（isDigest）时，
    //    只抽取「事件盒阶段总结 + 重要性 >= 0.8（8/10分）的高权重转折记忆」，过滤掉日常吃面、买杯子等鸡毛蒜皮；
    // 2. 若过滤后不足 5 条（或角色尚未生成核心记忆与事件盒），才回退补充普通长期记忆。
    const highSignalScoped = scoped.filter(
        item => item.isDigest || (Number.isFinite(item.entry.importance) ? item.entry.importance : 0.8) >= 0.8,
    );
    const effectivePool = (activeCoreSummaries.length > 0 && highSignalScoped.length >= 3)
        ? highSignalScoped.slice(-MAX_HIGH_SIGNAL_ENTRIES_WITH_CORE)
        : (highSignalScoped.length >= 8
            ? highSignalScoped.slice(-MAX_EVENT_ENTRIES)
            : scoped.slice(-MAX_EVENT_ENTRIES));
    const selected = effectivePool;
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

    // ── 素材 3：短期即时片段（仅在完全没有长期记忆与核心记忆沉淀时作兜底）──
    // 一旦已有长期记忆或核心记忆沉淀，绝不再混入未总结的原始日常聊天记录：
    // 原始聊天充满「正在吃什么、手头在干什么活」的琐碎细节，会触发强烈的近因效应，把深度反思直接带偏成「今日日记」。
    let transientText = "";
    if (selected.length === 0 && activeCoreSummaries.length === 0) {
        try {
            const config = loadMemoryConfig();
            const scopeFloorIso = scopeCutoffMs !== undefined
                ? new Date(scopeCutoffMs).toISOString()
                : new Date(Date.now() - ALL_SCOPE_TRANSIENT_DAYS * 86400000).toISOString();
            const lastSumTs = getLastSummarizedTimestamp(characterId);
            const afterIso = (lastSumTs && lastSumTs > scopeFloorIso) ? lastSumTs : scopeFloorIso;
            const timeline = filterTimelineByAllowedSources(
                loadNativeTimeline(characterId, { afterTimestamp: afterIso }),
                config.shortTermAllowedSources,
            );
            const formatted = formatTimelineForSummarization(timeline.slice(-MAX_TRANSIENT_EVENTS), { timeAware: false });
            if (formatted?.eventsText) transientText = formatted.eventsText.trim();
        } catch {
            // 读不到就跳过
        }
    }

    if (selected.length === 0 && activeCoreSummaries.length === 0 && !transientText) {
        return { success: false, error: "没有可用于反思的素材：这个角色还没有核心记忆、长期记忆或近期事件" };
    }

    // 不向反思模型暴露逐条记忆的具体日期（YYYY-MM-DD），防止模型顺着时间轴写日记
    const eventLines = selected.map(item => {
        const boxTag = item.isDigest
            ? `【事件脉络总结${item.boxTitle ? `：${item.boxTitle}` : ""}】`
            : (item.boxTitle ? `【关联事件：${item.boxTitle}】` : "");
        const staleNote = item.superseded ? "（部分说法已被后续记忆更正）" : "";
        return `- ${boxTag}${staleNote}${item.body.replace(/\s+/g, " ")}`;
    });
    const trimmed = trimEventLines(eventLines, MAX_EVENT_CHARS);
    const eventsText = trimmed.lines.length > 0
        ? `${trimmed.lines.join("\n")}${trimmed.truncated ? "\n（更早的记忆已省略）" : ""}`
        : (transientText || "（暂无长期记忆）");

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
