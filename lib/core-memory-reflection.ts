// lib/core-memory-reflection.ts
// 角色视角的核心记忆反思与审校（character reflection & core-memory calibration）
//
// 设计原则：
// - API：走角色自己在「绑定配置 → 聊天」里绑定的 API；没有才回退到记忆总结辅助 API / 全局默认；
// - 素材：完整读取角色设定（人设、性格、标签，不做任何截断）与用户身份，让模型以角色本人的第一人称说话；
// - 角色参与核心记忆维护：同时将【系统整理的核心记忆总结】与【高权重长期记忆/事件盒脉络】交给角色本人审视。
//   若系统总结中对角色性格、动机或与用户的关系定性存在偏差，角色直接在本次第一人称认知结论中按自己的真实想法纠正，
//   并沉淀为最新一轮角色认知（下一轮系统总结时会自动读取该结论作为定性校准参考）。
// - 单一透明模板：不再暗中切换隐藏模板、不再强制三段考卷格式报错或静默吞掉结果，设置页提示词所见即所得。
// - 隔离：一次只处理一个 characterId，绝不混合多个角色的素材。

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

export const DEFAULT_REFLECTION_PROMPT = `你此刻是「{{char}}」本人。系统在后台替你整理了核心记忆总结，现在请你结合自己的真实性格、事实底稿与上一轮想法，用第一人称对你的**核心认知与核心记忆**进行一次审视、纠偏与更新。
注意：这是角色内在认知的迭代结论，**不是散文、不是日记、更不是小剧场独白**！

【你是谁（初始设定）】
{{persona}}

【你惯常的思考强度（1-10）】
{{tendency}}
这三个刻度只决定你审视问题的切入深浅，严禁在正文中提及数字或刻度概念。

【系统整理的核心记忆沉淀（请用你自己的眼光审视：若有把你的动机、性格或对{{user}}的态度写偏的地方，请在本次结论中直接按你的本心纠正；但不得否认事实底稿中确实发生过的事）】
{{coreMemories}}

【供你核对与推导认知变化的事实底稿（警告：仅供核对事实与推导底层心理规律，严禁将具体吃喝、日常小物件抄入正文！）】
{{events}}

【你上一轮的认知结论（若为空则为首次提炼）】
{{previous}}

═══ 绝对禁令（违反任意一条即为失败） ═══
1. **【严禁任何动作、神态、环境描写】**：禁止出现“摘下眼镜”、“捏捏鼻梁”、“案头卷宗”、“夜深了”等任何舞台动作或场景开场白！
2. **【严禁提及任何具体生活琐碎物品】**：禁止出现任何食物菜名（汤、面、煲等）、具体小物件（水杯、手机、被窝等）、金额数字或日常琐事流水账！必须将具体经历抽象为关于性格、动机与关系模式的认知定论。
3. **【严禁写大段抒情散文与日常打算】**：禁止出现“这几日”、“方才”、“等下班回去”等时间词；结尾严禁写“去煨汤/抽走手机/哄睡”等具体日常动作！
4. **【严禁编造未发生过的事实】**：你可以修正系统总结里偏颇的心理揣测，但绝不能凭空捏造事实底稿中没有发生过的事件。

═══ 认知审视与提炼结构（合并为紧凑的一段话，100~180字以内） ═══
请直接用第一人称（保留我对{{user}}的称呼与说话底色，但不写废话）浓缩以下三层认知变化：
1. **自我认知与纠偏**：在与{{user}}相处中我暴露出了什么固有习气或盲区？（若系统核心记忆把我的动机或心境理解歪了，直接按我的真实想法定性纠正。）
2. **对{{user}}的深层定性**：穿透表面言行，我对{{user}}的性格本质、防御机制与安全感来源形成了什么新的核心判断？
3. **关系定位与相处分寸**：面对我们之间的核心张力，我往后在心理边界、立场态度与回应方式上确立了什么新原则？（只写抽象的态度与分寸准则，不写具体做什么事。）

═══ 输出要求 ═══
- **字数严格控制在 100-180 字**，合为 **1 个紧凑的自然段**，句句皆为定性判断，拒绝散文化铺垫。
- 纯文本输出，不要标题、编号、分条列表或括号注释，第一句话直接切入认知结论：`;

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
 */
const resolveReflectionApiConfig = resolveCharacterApiConfig;

/**
 * 角色设定的完整文本：人设、性格、标签原样拼进去，**不做任何长度截断**。
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

/** 模型偶尔还是会带标题或开场白，或旧自定义提示词输出了【修正版】标签，做统一轻清洗。 */
function cleanReflectionOutput(raw: string): string {
    let text = raw.trim();
    text = text.replace(/^```[a-zA-Z]*\s*\n/, "").replace(/\n```$/, "").trim();
    const correctedMatch = text.match(/【修正版】\s*([\s\S]+)$/i);
    if (correctedMatch?.[1]?.trim()) {
        text = correctedMatch[1].trim();
    }
    text = text.replace(/^(?:好的|好[，,]?|以下是|下面是|我来)[^\n]{0,40}\n+/i, "");
    text = text.replace(/^#{1,6}\s+[^\n]*\n+/gm, "");
    text = text.replace(/^\s*(?:[-*•]|\d+[.、])\s+/gm, "");
    return text.trim();
}

/**
 * 以角色视角审视核心记忆沉淀与近期事件，生成一条仅属于该角色的核心认知记忆。
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

    // ── 素材 1：该角色的长期记忆（先过滤已删除与事件盒已归档旧条目，再按范围过滤、按事件日期升序）──
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

    const activeCoreSummaries = coreEntries
        .filter(e => !isReflectionMemoryEntry(e) && !isEntrySuperseded(e) && !isEntryTrashed(e))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-5);

    // ── 素材降噪（防止几十条日常琐事把反思拉回日记体）──
    const highSignalScoped = scoped.filter(
        item => item.isDigest || (Number.isFinite(item.entry.importance) ? item.entry.importance : 0.8) >= 0.8,
    );
    const selected = (activeCoreSummaries.length > 0 && highSignalScoped.length >= 3)
        ? highSignalScoped.slice(-MAX_HIGH_SIGNAL_ENTRIES_WITH_CORE)
        : (highSignalScoped.length >= 8
            ? highSignalScoped.slice(-MAX_EVENT_ENTRIES)
            : scoped.slice(-MAX_EVENT_ENTRIES));

    const coreMemoriesText = activeCoreSummaries.length > 0
        ? activeCoreSummaries
            .map(e => {
                const span = typeof e.metadata?.timeSpan === "string" && e.metadata.timeSpan.trim()
                    ? e.metadata.timeSpan.trim()
                    : resolveEventDay(e);
                const label = String(e.metadata?.origin ?? "") === "user_manual" ? "用户核心设定（固定事实，不可违背）" : "系统总结";
                return `- [${span}｜${label}] ${cleanMemoryBody(e.content).replace(/\s+/g, " ")}`;
            })
            .join("\n")
        : "（暂无系统核心记忆沉淀，请直接基于下方事件脉络进行反思与提炼）";

    // ── 素材 3：短期即时片段（仅在完全没有长期记忆与核心记忆沉淀时作兜底）──
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
            // ignore
        }
    }

    if (selected.length === 0 && activeCoreSummaries.length === 0 && !transientText) {
        return { success: false, error: "没有可用于反思的素材：这个角色还没有核心记忆、长期记忆或近期事件" };
    }

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

    const reflectionTemplate = (loadMemoryConfig().reflectionPrompt ?? "").trim() || DEFAULT_REFLECTION_PROMPT;
    const hasCorePlaceholder = /\{\{coreMemories\}\}/i.test(reflectionTemplate);
    const finalEventsText = (!hasCorePlaceholder && activeCoreSummaries.length > 0)
        ? `【近期核心记忆心理沉淀】\n${coreMemoriesText}\n\n【具体事件与长期记忆】\n${eventsText}`
        : eventsText;

    const tendency = loadThinkingTendency(characterId);
    const prompt = applyTendencyToPrompt(
        reflectionTemplate
            .replace(/\{\{char\}\}/gi, resolvedName || "这个角色")
            .replace(/\{\{user\}\}/gi, userName)
            .replace(/\{\{persona\}\}/gi, personaText)
            .replace(/\{\{earliest\}\}/gi, earliest || "未知")
            .replace(/\{\{latest\}\}/gi, latest || "未知")
            .replace(/\{\{unreadCore\}\}/gi, coreMemoriesText)
            .replace(/\{\{coreMemories\}\}/gi, coreMemoriesText)
            .replace(/\{\{events\}\}/gi, finalEventsText)
            .replace(/\{\{transient\}\}/gi, transientText || "（无）")
            .replace(/\{\{previous\}\}/gi, previousText || "（这是第一次反思，此前没有留下过想法）"),
        tendency,
    );

    let result = await simpleLLMCall(
        api.apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.7, label: `核心记忆反思·${resolvedName || characterId}` },
    );
    if (!result.content && !result.wasTruncated) {
        await new Promise(r => setTimeout(r, 1000));
        result = await simpleLLMCall(
            api.apiConfig,
            [{ role: "user", content: prompt }],
            { temperature: 0.7, label: `核心记忆反思重试·${resolvedName || characterId}` },
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
            reflectionScope: scope,
            reflectionRound: round,
            timeSpan: `${earliest} ~ ${latest}`,
            summarizedLongTermEntries: selected.length,
            auditedCoreIds: activeCoreSummaries.map(e => e.id),
            hasTransientEvents: Boolean(transientText),
            previousReflectionId: previousReflection?.id ?? null,
            apiSource: api.source,
            model: api.apiConfig.defaultModel,
            // 同步保存校准正文，供下一轮系统核心记忆总结（core-memory-builder）读取作为定性修正参考
            correctedContent: reflection,
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
