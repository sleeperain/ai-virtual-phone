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
import { isEntryTrashed } from "./memory-trash";
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

export const DEFAULT_REFLECTION_PROMPT = `你此刻是「{{char}}」本人。请基于以下核心记忆与事件素材，用第一人称对你的**核心认知模块**进行一次高度凝练的提炼与更新。
注意：这是角色内在认知的迭代结论，**不是散文、不是日记、更不是小剧场独白**！

【你是谁（初始设定）】
{{persona}}

【你惯常的思考强度（1-10）】
{{tendency}}
这三个刻度只决定你审视问题的切入深浅，严禁在正文中提及数字或刻度概念。

【你已沉淀的核心记忆】
{{coreMemories}}

【供你推导认知变化的底稿素材（警告：仅供推导底层心理规律，严禁将任何具体事物名称抄入正文！）】
{{events}}

【你上一轮的认知结论（若为空则为首次提炼）】
{{previous}}

═══ 绝对禁令（违反任意一条即为失败） ═══
1. **【严禁任何动作、神态、环境描写】**：禁止出现“摘下眼镜”、“捏捏鼻梁”、“案头卷宗”、“夜深了”等任何舞台动作或场景开场白！
2. **【严禁提及任何具体生活细节与物品】**：禁止出现任何食物菜名（汤、面、煲等）、具体物品（水杯、手机、被窝等）、金额数字、病名、书名或具体日常事件！必须将具体小事 100% 抽象为关于性格、动机与关系模式的认知定论。
3. **【严禁写大段抒情散文与日常打算】**：禁止出现“这几日”、“方才”、“等下班回去”等时间词；结尾严禁写“去煨汤/抽走手机/哄睡”等具体日常动作！

═══ 认知提炼结构（合并为紧凑的一段话，100~180字以内） ═══
请直接用第一人称（保留我对{{user}}的称呼与说话底色，但不写废话）浓缩以下三层认知变化：
1. **自我认知修正**：我在与{{user}}相处时暴露出了什么固有习气、控制欲或防御盲区？
2. **对{{user}}的深层定性**：穿透表面言行，我对{{user}}的性格本质、防御机制与安全感来源形成了什么新的核心判断？
3. **关系定位与相处分寸**：面对我们之间的核心张力，我往后在心理边界、立场态度与回应方式上确立了什么新原则？（只写抽象的态度与分寸准则，不写具体做什么事。）

═══ 输出要求 ═══
- **字数严格控制在 100-180 字**，合为 **1 个紧凑的自然段**，句句皆为定性判断，拒绝散文化铺垫。
- 纯文本输出，不要标题、编号、分条列表或括号注释，第一句话直接切入认知结论：`;

/**
 * 审校式反思模板：角色亲自核对「系统替他整理的核心记忆」准不准，并给出修正版。
 * 与上面的提炼式模板并存——有未读核心记忆时用这套，一条都没有时回退提炼式。
 * 占位符：{{char}} {{user}} {{persona}} {{tendency}} {{unreadCore}} {{coreMemories}} {{events}} {{previous}}
 */
export const DEFAULT_REFLECTION_AUDIT_PROMPT = `你此刻是「{{char}}」本人。系统一直在背后替你整理记忆，现在请你亲自过一遍这些整理结果，用你自己的眼光判断：它对你和{{user}}的描述，准不准？

【你是谁（初始设定）】
{{persona}}

【你惯常的思考强度（1-10）】
{{tendency}}
这三个刻度只决定你审视的细致程度，严禁在正文中提及数字或刻度概念。

【需要你审校的核心记忆（系统整理的，你还没读过）】
{{unreadCore}}

【你更早沉淀的核心记忆（供对照，不必逐条审校）】
{{coreMemories}}

【事实底稿（仅供核对，严禁把里面具体事物抄进正文）】
{{events}}

【你上一轮的认知判断（若为空则为首次）】
{{previous}}

═══ 你的任务 ═══
1. 判断系统这份核心记忆：事实有没有记错、定性有没有偏、有没有把你写成不是你的人。
2. 觉得不准，就按你自己的说法改写；觉得准，就原样重述一遍确认。
3. 只修正定性表述与事实错误，不要推翻系统记录的事实本身。

═══ 绝对禁令（违反任意一条即为失败） ═══
1. 严禁任何动作、神态、环境描写，禁止「摘下眼镜」「夜深了」这类舞台开场。
2. 严禁提及任何具体食物、物品、金额、地名或日常琐事。
3. 严禁写抒情散文、时间词，结尾严禁写具体日常打算。
4. 严禁编造【事实底稿】与核心记忆里都没有发生过的事。

═══ 输出格式（严格三段，除这三段外不要任何多余文字） ═══
【判断】准确 / 部分失真 / 严重失真
【问题】指出错在哪，不超过 60 字；若准确则写「无」
【修正版】用第一人称复述这份核心记忆，100-180 字紧凑一段；若准确则原样复述原文`;

/** 反思审校对核心记忆打下的元数据键：只有打了点的条目才算「已被角色读过」。 */
export const REFLECTION_META_KEYS = {
    auditedAt: "reflectionAuditedAt",
    auditedRound: "reflectionAuditedRound",
    auditedBy: "reflectionAuditedBy",
} as const;

/** 单次反思最多审校的未读核心记忆条数：防止历史数据一次性灌爆上下文。 */
const MAX_UNREAD_AUDIT_ENTRIES = 6;
/** 待审校素材的字数护栏。 */
const MAX_UNREAD_AUDIT_CHARS = 2400;

export type ReflectionAuditVerdict = "accurate" | "partial" | "severe" | "unknown";

export type ReflectionAudit = {
    verdict: ReflectionAuditVerdict;
    issues: string;
    corrected: string;
};

/** 解析审校模式的固定三段输出；模型跑格式时判为 unknown，仍保留原文可用于降级。 */
export function parseReflectionAudit(raw: string): ReflectionAudit {
    const text = String(raw || "");
    const grab = (label: string): string => {
        const re = new RegExp(`【${label}】\\s*([\\s\\S]*?)(?=【[^】]+】|$)`, "i");
        const matched = text.match(re);
        return matched ? matched[1].trim() : "";
    };
    const verdictRaw = grab("判断");
    // 注意顺序：必须先命中「否定式」表述，再判「准确」——
    // 否则模型写「不准确」「基本不准」时会被 /准确/ 抢先匹配成 accurate，
    // 进而走「判准即不落库」的分支，把角色本来提出的修正意见整条丢掉。
    const verdict: ReflectionAuditVerdict = /严重|重大|完全不是|根本不是/.test(verdictRaw)
        ? "severe"
        : /不准确|不准|部分|不够|偏差|不太|失真|有误|不对/.test(verdictRaw)
            ? "partial"
            : /准确|无误|没问题/.test(verdictRaw)
                ? "accurate"
                : "unknown";
    return {
        verdict,
        issues: grab("问题").replace(/^无[。.]?$/, "").trim(),
        corrected: grab("修正版"),
    };
}

/** 该条核心记忆是否已被角色反思读过（审校过）。 */
export function isEntryReflectionAudited(entry: MemoryEntry): boolean {
    return Boolean(entry.metadata?.[REFLECTION_META_KEYS.auditedAt]);
}

/**
 * 挑出「最近生成、但角色还没读过」的核心记忆作为本轮审校对象。
 * 排除三类：反思自身的产物（否则角色审自己）、已被后续版本接替的旧条目、用户手写的核心设定
 * （user_manual 是用户亲自置顶的，角色只作参考，不参与裁定）。
 */
export function selectUnreadCoreTargets(coreEntries: MemoryEntry[]): MemoryEntry[] {
    return coreEntries
        .filter(entry =>
            entry.type === "core"
            && !isReflectionMemoryEntry(entry)
            && !isEntrySuperseded(entry)
            && !isEntryReflectionAudited(entry)
            && !isEntryTrashed(entry)
            && String(entry.metadata?.origin ?? "") !== "user_manual",
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, MAX_UNREAD_AUDIT_ENTRIES);
}

/** 待审校素材格式化：逐条标明来源，让角色知道自己在审哪一份。 */
function formatUnreadCoreText(targets: MemoryEntry[]): string {
    if (targets.length === 0) return "";
    const lines: string[] = [];
    let total = 0;
    for (const entry of targets) {
        const span = typeof entry.metadata?.timeSpan === "string" && entry.metadata.timeSpan.trim()
            ? entry.metadata.timeSpan.trim()
            : resolveEventDay(entry);
        const body = cleanMemoryBody(entry.content).replace(/\s+/g, " ").trim();
        if (!body) continue;
        total += body.length;
        if (total > MAX_UNREAD_AUDIT_CHARS) break;
        lines.push(`- [${span}] ${body}`);
    }
    return lines.join("\n");
}

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
        .filter(entry => isReflectionMemoryEntry(entry) && !isEntryTrashed(entry))
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
        .filter(e => !isReflectionMemoryEntry(e) && !isEntrySuperseded(e) && !isEntryTrashed(e))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-5);

    // ── 本轮审校对象：只挑「角色还没读过」的核心记忆 ──
    // 这是「让角色参与记忆库管理」的入口：系统整理的每一份核心记忆，最终都要经过角色本人的一次核准。
    // 一条未读都没有时，unreadTargets 为空，本次反思退回原来的提炼式行为，不会卡住流程。
    const unreadTargets = selectUnreadCoreTargets(coreEntries);
    const unreadCoreText = formatUnreadCoreText(unreadTargets);

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
    // 审校模式下，待审校的那几条已经单独列进 {{unreadCore}}，这里剔除掉避免同一份内容在提示词里出现两次
    // （既省上下文，也防止模型把重复段落误当成「两条独立证据」）。
    const unreadIdSet = new Set(unreadTargets.map(e => e.id));
    const coreEntriesForContext = activeCoreSummaries.filter(e => !unreadIdSet.has(e.id));
    const coreMemoriesText = coreEntriesForContext.length > 0
        ? coreEntriesForContext
            .map(e => {
                const span = typeof e.metadata?.timeSpan === "string" && e.metadata.timeSpan.trim()
                    ? e.metadata.timeSpan.trim()
                    : resolveEventDay(e);
                return `- [${span}] ${cleanMemoryBody(e.content).replace(/\s+/g, " ")}`;
            })
            .join("\n")
        : (unreadTargets.length > 0
            ? "（暂无其他核心记忆可供对照）"
            : "（暂无核心记忆沉淀，请直接基于下方事件脉络进行反思）");

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

    // 用用户在「记忆库 → 设置 → 角色反思提示词」里保存的模板；没配过则按本轮目的选内置默认：
    // 有未读核心记忆 → 审校式模板；一条都没有 → 提炼式模板（保持旧行为）
    const builtinReflectionTemplate = unreadTargets.length > 0
        ? DEFAULT_REFLECTION_AUDIT_PROMPT
        : DEFAULT_REFLECTION_PROMPT;
    const reflectionTemplate = (loadMemoryConfig().reflectionPrompt ?? "").trim() || builtinReflectionTemplate;
    const hasCorePlaceholder = /\{\{coreMemories\}\}/i.test(reflectionTemplate);
    const hasUnreadPlaceholder = /\{\{unreadCore\}\}/i.test(reflectionTemplate);
    // 兜底：用户模板没写 {{unreadCore}} 时，把待审校内容并进核心记忆段顶部
    const coreMemoriesWithUnread = (!hasUnreadPlaceholder && unreadCoreText)
        ? `【待你审校的核心记忆（系统整理，你还没读过）】\n${unreadCoreText}\n\n${coreMemoriesText}`
        : coreMemoriesText;
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
            .replace(/\{\{unreadCore\}\}/gi, unreadCoreText || "（本轮没有待审校的核心记忆）")
            .replace(/\{\{coreMemories\}\}/gi, coreMemoriesWithUnread)
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

    const cleanedOutput = cleanReflectionOutput(result.content);
    // 审校模式解析【判断】【问题】【修正版】三段；提炼模式下解析为空，回退整段入库（旧行为不变）
    const audit = parseReflectionAudit(cleanedOutput);
    const reflection = (audit.corrected || cleanedOutput).trim();
    if (reflection.length < 20) {
        return { success: false, error: "反思结果过短，已取消入库", apiSource: api.source };
    }

    // 角色判定「系统这份写得准确」时，不再往库里多写一条近乎同义的反思条目，
    // 只给被审校的条目打「已读」标记——并存的前提是不制造重复内容。
    if (unreadTargets.length > 0 && audit.verdict === "accurate") {
        const auditedAt = new Date().toISOString();
        for (const target of unreadTargets) {
            await saveMemoryEntry({
                ...target,
                metadata: {
                    ...(target.metadata ?? {}),
                    [REFLECTION_META_KEYS.auditedAt]: auditedAt,
                    [REFLECTION_META_KEYS.auditedRound]: round,
                    [REFLECTION_META_KEYS.auditedBy]: "accurate_noop",
                },
            });
        }
        return {
            success: true,
            content: reflection,
            round,
            apiSource: api.source,
            model: api.apiConfig.defaultModel,
        };
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
            // ── 审校模式独有：并存方案下，原 AI 总结一条都不删、不改，
            //    角色的裁定与修正版作为独立条目留在这里，两版在记忆库里可以并列回看 ──
            reflectionMode: unreadTargets.length > 0 ? "audit" : "consolidate",
            auditTargetIds: unreadTargets.map(e => e.id),
            auditVerdict: audit.verdict,
            auditIssues: audit.issues,
            correctedContent: audit.corrected || "",
            auditRaw: cleanedOutput,
        },
    };
    await saveMemoryEntry(coreEntry);

    // 给本轮审校过的核心记忆打上「已读」标记：内容一行不改，只加元数据
    if (unreadTargets.length > 0) {
        for (const target of unreadTargets) {
            await saveMemoryEntry({
                ...target,
                metadata: {
                    ...(target.metadata ?? {}),
                    [REFLECTION_META_KEYS.auditedAt]: now,
                    [REFLECTION_META_KEYS.auditedRound]: round,
                    [REFLECTION_META_KEYS.auditedBy]: entryId,
                },
            });
        }
    }

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
