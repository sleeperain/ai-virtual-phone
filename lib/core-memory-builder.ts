import type { MemoryEntry } from "./memory-types";
import { DEFAULT_CORE_MEMORY_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    getCoreMemoryCounter,
    resetCoreMemoryCounter,
    getLastCoreSummarizedTimestamp,
    setLastCoreSummarizedTimestamp,
} from "./memory-storage";
import {
    resolveSummarizationApiConfig,
    stripMemoryStructuredSections,
    buildCharacterSummaryProfile,
    injectCharacterProfileIntoPrompt,
} from "./memory-summarizer";
import { simpleLLMCall } from "./api-helpers";
import { filterRecallableEntries, isEntryBoxDigest } from "./memory-event-boxes";
import { isEntryTrashed } from "./memory-trash";
import { resolveMemoryProvenance, type ProvenanceEntry } from "./memory-provenance";
import {
    DEFAULT_REVISION_WEIGHT,
    isEntrySuperseded,
    REVISION_META_KEYS,
} from "./memory-revision";

const coreBuildingSet = new Set<string>();

type CoreTimelineItem = {
    id: string;
    timestamp: string;
    eventDay: string;
    content: string;
    isDigest: boolean;
    boxTitle: string;
    superseded: boolean;
    sourceApp: MemoryEntry["sourceApp"];
    sourceSessionIds: string[];
};

/** 判断是否为自动/手动提炼的「核心记忆总结」（排除用户手动置顶的纯设定条目与已废弃旧条目） */
export function isAutoCoreSummaryEntry(entry: MemoryEntry): boolean {
    if (entry.type !== "core") return false;
    const origin = String(entry.metadata?.origin ?? "");
    if (origin === "character_reflection" || origin === "user_manual") return false;
    return origin === "core_summary" || typeof entry.metadata?.summarizedLongTermEntries === "number";
}

function resolveEventDay(entry: MemoryEntry): string {
    const raw = typeof entry.metadata?.eventDate === "string" ? entry.metadata.eventDate.trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return entry.createdAt.slice(0, 10);
}

function formatCoreTimelineForSummarization(
    entries: CoreTimelineItem[],
): { eventsText: string; earliest: string; latest: string; count: number } | null {
    if (entries.length === 0) return null;
    const lines = entries.map(entry => {
        const cleanBody = (stripMemoryStructuredSections(entry.content) || entry.content).replace(/\s*\n+\s*/g, " ").trim();
        const tag = entry.isDigest
            ? `【事件盒阶段总结${entry.boxTitle ? `：${entry.boxTitle}` : ""}】`
            : (entry.boxTitle ? `【事件：${entry.boxTitle}】` : "");
        const stale = entry.superseded ? "（部分内容已被后续记忆更正）" : "";
        return `- [${entry.eventDay}]${tag}${stale} ${cleanBody}`;
    });
    return {
        eventsText: lines.join("\n"),
        earliest: entries[0].eventDay || entries[0].timestamp.slice(0, 10),
        latest: entries[entries.length - 1].eventDay || entries[entries.length - 1].timestamp.slice(0, 10),
        count: entries.length,
    };
}

/** 识别模型是否判定「本周期无新增核心变化」 */
function isNoCoreChangeOutput(text: string): boolean {
    const clean = text.replace(/[。！!."”'’\s]/g, "");
    return clean.length <= 24 && /本周期无新增核心变化|无新增核心变化|暂无新增核心变化/.test(clean);
}

export async function runCoreMemoryPipeline(
    characterId: string,
    characterName: string,
    options?: { force?: boolean },
): Promise<{ success: boolean; error?: string; rebuiltCount?: number; skippedNoChange?: boolean }> {
    const config = loadMemoryConfig();
    const allLongTermEntries = filterRecallableEntries(await loadMemoryEntriesByType(characterId, "long_term"));

    if (allLongTermEntries.length === 0) {
        return { success: false, error: "没有可用于总结核心记忆的长期记忆" };
    }

    const apiConfig = resolveSummarizationApiConfig(characterId);
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    const afterTimestamp = options?.force ? undefined : (getLastCoreSummarizedTimestamp(characterId) ?? undefined);
    const entries = allLongTermEntries
        .filter(entry => !afterTimestamp || entry.createdAt > afterTimestamp || entry.updatedAt > afterTimestamp)
        .map(entry => ({
            id: entry.id,
            timestamp: entry.updatedAt > entry.createdAt ? entry.updatedAt : entry.createdAt,
            eventDay: resolveEventDay(entry),
            content: entry.content,
            isDigest: isEntryBoxDigest(entry),
            boxTitle: typeof entry.metadata?.eventBoxTitle === "string" ? entry.metadata.eventBoxTitle.trim() : "",
            superseded: isEntrySuperseded(entry),
            sourceApp: entry.sourceApp,
            sourceSessionIds: Array.isArray(entry.metadata?.sourceSessionIds)
                ? entry.metadata.sourceSessionIds.map(String)
                : [],
        }))
        .sort((a, b) => a.eventDay.localeCompare(b.eventDay) || a.timestamp.localeCompare(b.timestamp));

    if (entries.length === 0) {
        if (!options?.force) resetCoreMemoryCounter(characterId);
        return { success: false, error: "没有新的长期记忆需要总结" };
    }

    const formatted = formatCoreTimelineForSummarization(entries);
    if (!formatted) return { success: false, error: "格式化核心记忆数据失败" };

    // 读取上一轮核心记忆总结，供增量验证与演进
    const existingCoreEntries = await loadMemoryEntriesByType(characterId, "core");
    // 被弃用（进了回收站）的核心记忆不再作为「上一轮总结」的基线，也不参与演进
    const previousSummaries = existingCoreEntries
        .filter(entry => isAutoCoreSummaryEntry(entry) && !isEntryTrashed(entry))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latestPrevSummary = previousSummaries[0];
    const previousText = latestPrevSummary
        ? (stripMemoryStructuredSections(latestPrevSummary.content) || latestPrevSummary.content).trim()
        : "";

    const { eventsText, earliest, latest } = formatted;
    const latestCursorTs = entries.reduce((max, item) => (item.timestamp > max ? item.timestamp : max), entries[0].timestamp);
    const charProfile = buildCharacterSummaryProfile(characterId, characterName);
    let promptTemplate = config.coreMemoryPrompt?.trim() || DEFAULT_CORE_MEMORY_PROMPT;
    // 清理旧版自定义模板里遗留的 {{previousRefined}} 角色反思段落
    promptTemplate = promptTemplate
        .replace(/\n*角色本人对上一轮的修正意见[^\n]*\n\{\{previousRefined\}\}\n*/gi, "\n")
        .replace(/\{\{previousRefined\}\}/gi, "");

    const hasPreviousPlaceholder = /\{\{previous\}\}/i.test(promptTemplate);

    // 若用户自定义提示词里没写 {{previous}} 占位符，自动把上一轮核心记忆总结拼在 {{events}} 顶部
    const eventsWithOptionalPrev = (!hasPreviousPlaceholder && previousText)
        ? `【上一轮核心记忆总结（待增量验证与更新）】\n${previousText}\n\n【本周期新增长期记忆与事件盒总结】\n${eventsText}`
        : eventsText;

    const prompt = injectCharacterProfileIntoPrompt(
        promptTemplate
            .replace(/\{\{char\}\}/gi, characterName)
            .replace(/\{\{earliest\}\}/gi, earliest)
            .replace(/\{\{latest\}\}/gi, latest)
            .replace(/\{\{previous\}\}/gi, previousText || "（首次提炼，尚无上一轮核心记忆总结）")
            .replace(/\{\{events\}\}/gi, eventsWithOptionalPrev)
            .replace(/\{\{longTermMemories\}\}/gi, eventsWithOptionalPrev),
        charProfile,
    );

    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.35, label: `核心记忆提炼·${characterName || characterId}` },
    );

    if (!result.content) {
        return { success: false, error: result.error || "核心记忆总结失败" };
    }
    if (result.wasTruncated) {
        return { success: false, error: "核心记忆总结结果疑似被截断，已取消入库，请稍后重试" };
    }

    const summary = result.content.trim();
    if (!summary) {
        return { success: false, error: "核心记忆总结结果为空" };
    }

    const prevCoreTs = getLastCoreSummarizedTimestamp(characterId);
    if (!prevCoreTs || latestCursorTs > prevCoreTs) {
        setLastCoreSummarizedTimestamp(characterId, latestCursorTs);
    }
    if (!options?.force) {
        resetCoreMemoryCounter(characterId);
    }

    // 模型明确判定本周期无新增核心变化时：保留上一轮核心记忆不动，不写入无意义条目
    if (isNoCoreChangeOutput(summary)) {
        return { success: true, rebuiltCount: 0, skippedNoChange: true };
    }

    const now = new Date().toISOString();
    const sourceCounts = new Map<string, number>();
    for (const entry of entries) {
        sourceCounts.set(entry.sourceApp, (sourceCounts.get(entry.sourceApp) || 0) + 1);
    }
    let dominantSource: MemoryEntry["sourceApp"] = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) {
            dominantSource = src as MemoryEntry["sourceApp"];
            maxCount = count;
        }
    }
    const sourceSessionIds = Array.from(new Set(entries.flatMap(entry => entry.sourceSessionIds)));
    const round = latestPrevSummary
        ? Math.max(1, Number(latestPrevSummary.metadata?.coreSummaryRound ?? 1)) + 1
        : 1;

    const entryId = `mem_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const coreEntry: MemoryEntry = {
        id: entryId,
        characterId,
        sourceApp: dominantSource,
        type: "core",
        content: summary,
        importance: 0.95,
        createdAt: now,
        updatedAt: now,
        metadata: {
            origin: "core_summary",
            active: true,
            coreSummaryRound: round,
            previousCoreSummaryId: latestPrevSummary?.id ?? null,
            summarizedLongTermEntries: entries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(coreEntry);

    // 增量更新完成后，将上一轮核心记忆总结标记为已被新版本演进接替并降权，
    // 历史记录仍留在核心记忆列表供回看，但避免多轮高度重合的阶段总结同时塞爆核心记忆预算。
    for (const oldSum of previousSummaries) {
        if (oldSum.id === entryId) continue;
        const alreadySuperseded = Boolean(oldSum.metadata?.[REVISION_META_KEYS.by]);
        const wasActive = Boolean(oldSum.metadata?.active);
        if (!alreadySuperseded || wasActive) {
            await saveMemoryEntry({
                ...oldSum,
                updatedAt: now,
                metadata: {
                    ...(oldSum.metadata ?? {}),
                    active: false,
                    [REVISION_META_KEYS.by]: alreadySuperseded
                        ? oldSum.metadata?.[REVISION_META_KEYS.by]
                        : entryId,
                    [REVISION_META_KEYS.at]: alreadySuperseded
                        ? oldSum.metadata?.[REVISION_META_KEYS.at]
                        : now,
                    [REVISION_META_KEYS.weight]: DEFAULT_REVISION_WEIGHT,
                },
            });
        }
    }

    return { success: true, rebuiltCount: 1 };
}

/**
 * 追溯一条核心记忆的「原文」：
 * 核心记忆是从一批长期记忆里提炼出来的，所以它的原文分两层——
 * 1. 当时提供素材的长期记忆（按上一轮核心总结与这一轮之间的时间窗挑选）；
 * 2. 这些长期记忆各自对应的原始对话/事件记录（复用 memory-provenance 的解析）。
 * 两层都拿不到时返回 null，上层必须拒绝重新总结，绝不对着旧结论二次编造。
 */
export async function resolveCoreMemorySource(
    characterId: string,
    coreEntry: MemoryEntry,
): Promise<{
    longTermEntries: MemoryEntry[];
    rawEntries: ProvenanceEntry[];
    earliest: string;
    latest: string;
    totalLongTerm: number;
} | null> {
    if (!characterId || !coreEntry) return null;

    const allLongTerm = (await loadMemoryEntriesByType(characterId, "long_term"))
        .filter(e => !isEntryTrashed(e));
    if (allLongTerm.length === 0) return null;

    const coreTs = Date.parse(coreEntry.createdAt);
    // 时间窗下界：上一轮核心总结的生成时间。没有就不设下界（老数据兼容）
    const prevId = typeof coreEntry.metadata?.previousCoreSummaryId === "string"
        ? coreEntry.metadata.previousCoreSummaryId
        : "";
    let lowerMs = Number.NEGATIVE_INFINITY;
    if (prevId) {
        const allCore = await loadMemoryEntriesByType(characterId, "core");
        const prev = allCore.find(e => e.id === prevId);
        const prevTs = prev ? Date.parse(prev.createdAt) : NaN;
        if (Number.isFinite(prevTs)) lowerMs = prevTs;
    }

    const pickByWindow = (useLowerBound: boolean) => allLongTerm.filter(entry => {
        const ts = Date.parse(entry.updatedAt > entry.createdAt ? entry.updatedAt : entry.createdAt);
        if (!Number.isFinite(ts) || !Number.isFinite(coreTs)) return true;
        if (ts > coreTs) return false;
        return useLowerBound ? ts > lowerMs : true;
    });

    let picked = pickByWindow(true);
    // 兜底：窗口内为空（例如老数据缺 previousCoreSummaryId）时退回到「所有早于该核心记忆的长期记忆」
    if (picked.length === 0) picked = pickByWindow(false);
    if (picked.length === 0) return null;

    const sorted = [...picked].sort((a, b) => resolveEventDay(a).localeCompare(resolveEventDay(b)));

    const rawEntries: ProvenanceEntry[] = [];
    const seen = new Set<string>();
    for (const lt of sorted.slice(-40)) {
        const prov = resolveMemoryProvenance(characterId, lt);
        if (!prov) continue;
        for (const item of prov.entries) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            rawEntries.push(item);
        }
    }
    rawEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
        longTermEntries: sorted,
        rawEntries: rawEntries.slice(-120),
        earliest: resolveEventDay(sorted[0]),
        latest: resolveEventDay(sorted[sorted.length - 1]),
        totalLongTerm: sorted.length,
    };
}

/**
 * 重新总结一条核心记忆：
 * 严格依据「当时依据的长期记忆 + 这些记忆对应的原始记录」重写，用户可在弹窗里写修正思路。
 * 原条目不让位消失，而是标记为被新版本接替（active=false + supersededBy），历史仍可回看。
 */
export async function resummarizeCoreMemory(
    characterId: string,
    characterName: string,
    entryId: string,
    extraInstruction?: string,
): Promise<{ success: boolean; error?: string; newEntryId?: string }> {
    const apiConfig = resolveSummarizationApiConfig(characterId);
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    const target = coreEntries.find(e => e.id === entryId);
    if (!target) return { success: false, error: "找不到这条核心记忆，可能已被删除" };
    if (isEntryTrashed(target)) {
        return { success: false, error: "这条核心记忆已在「最近删除」里，请先恢复后再操作" };
    }
    if (target.metadata?.origin === "user_manual") {
        return { success: false, error: "这条是你手写的核心设定，重新总结会覆盖原文，请直接用「编辑」修改" };
    }

    const source = await resolveCoreMemorySource(characterId, target);
    if (!source || source.longTermEntries.length === 0) {
        return {
            success: false,
            error: "追溯不到这条核心记忆所依据的长期记忆与原始记录，已中止重新总结（防止无依据二次编造，如需调整请手动编辑）",
        };
    }

    const previousText = (stripMemoryStructuredSections(target.content) || target.content).trim();
    const charProfile = buildCharacterSummaryProfile(characterId, characterName);
    let template = loadMemoryConfig().coreMemoryPrompt?.trim() || DEFAULT_CORE_MEMORY_PROMPT;
    template = template.replace(/\{\{previousRefined\}\}/gi, "");

    const longTermText = source.longTermEntries
        .map(entry => {
            const body = (stripMemoryStructuredSections(entry.content) || entry.content).replace(/\s*\n+\s*/g, " ").trim();
            return `- [${resolveEventDay(entry)}] ${body}`;
        })
        .join("\n");
    const rawText = source.rawEntries.length > 0
        ? source.rawEntries.map(item => `- [${item.sourceApp}] ${item.content}`).join("\n")
        : "（这批长期记忆已无对应的原始对话记录，只能依据上方的长期记忆正文）";

    const eventsBlock = [
        `【这条核心记忆当前依据的长期记忆（共 ${source.longTermEntries.length} 条）】`,
        longTermText,
        "",
        "【这些长期记忆对应的原始对话/事件记录（事实依据，与长期记忆冲突时以此为准）】",
        rawText,
    ].join("\n");

    const cleanedInstruction = (extraInstruction ?? "").trim().slice(0, 2000);
    const instructionBlock = cleanedInstruction
        ? [
            "",
            "═══ 用户本次的修正要求（最高优先级，必须逐条落实）═══",
            cleanedInstruction,
            "（以上要求只允许在【长期记忆】与【原始对话/事件记录】支持的事实范围内执行；"
            + "若与原始记录冲突，以原始记录为准，并直接说明无法按该要求改写。严禁为了满足要求而编造事实。）",
        ].join("\n")
        : "";

    const hasPreviousPlaceholder = /\{\{previous\}\}/i.test(template);
    const eventsWithInstruction = instructionBlock
        ? `${eventsBlock}${instructionBlock}`
        : eventsBlock;

    const prompt = injectCharacterProfileIntoPrompt(
        template
            .replace(/\{\{char\}\}/gi, characterName || "角色")
            .replace(/\{\{earliest\}\}/gi, source.earliest)
            .replace(/\{\{latest\}\}/gi, source.latest)
            .replace(/\{\{previous\}\}/gi, previousText || "（无）")
            .replace(/\{\{events\}\}/gi, eventsWithOptionalNote(
                hasPreviousPlaceholder,
                previousText,
                eventsWithInstruction,
            ))
            .replace(/\{\{longTermMemories\}\}/gi, eventsWithInstruction),
        charProfile,
    );

    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.2, label: `核心记忆重新总结·${characterName || characterId}` },
    );

    if (!result.content) {
        return { success: false, error: result.error || "核心记忆重新总结失败：模型没有返回内容" };
    }
    if (result.wasTruncated) {
        return { success: false, error: "核心记忆重新总结结果疑似被截断，已取消入库，请稍后重试" };
    }

    const summary = result.content.trim();
    if (!summary) return { success: false, error: "核心记忆重新总结结果为空" };
    if (isNoCoreChangeOutput(summary)) {
        return { success: false, error: "模型判定本周期无新增核心变化，未生成新版本（原核心记忆保持不动）" };
    }

    const now = new Date().toISOString();
    const newEntryId = `mem_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const round = Math.max(1, Number(target.metadata?.coreSummaryRound ?? 1));

    const next: MemoryEntry = {
        id: newEntryId,
        characterId,
        sourceApp: target.sourceApp,
        type: "core",
        content: summary,
        importance: Number.isFinite(target.importance) ? target.importance : 0.95,
        accessCount: target.accessCount ?? 0,
        createdAt: now,
        updatedAt: now,
        metadata: {
            ...(target.metadata ?? {}),
            origin: "core_summary",
            active: true,
            coreSummaryRound: round,
            previousCoreSummaryId: target.id,
            summarizedLongTermEntries: source.totalLongTerm,
            timeSpan: `${source.earliest} ~ ${source.latest}`,
            resummarizedFrom: target.id,
            ...(cleanedInstruction ? { resummarizeInstruction: cleanedInstruction } : {}),
        },
    };
    await saveMemoryEntry(next);

    // 旧版本不让位消失：标记为已被接替并降权，历史仍可回看
    await saveMemoryEntry({
        ...target,
        updatedAt: now,
        metadata: {
            ...(target.metadata ?? {}),
            active: false,
            [REVISION_META_KEYS.by]: newEntryId,
            [REVISION_META_KEYS.at]: now,
            [REVISION_META_KEYS.weight]: DEFAULT_REVISION_WEIGHT,
        },
    });

    return { success: true, newEntryId };
}

/** 提示词没写 {{previous}} 时，把旧版本补进 events 顶部，避免模型看不到要修正的对象 */
function eventsWithOptionalNote(
    hasPreviousPlaceholder: boolean,
    previousText: string,
    eventsBlock: string,
): string {
    if (hasPreviousPlaceholder || !previousText) return eventsBlock;
    return `【本次要被修正的旧核心记忆（其中与原始记录不符的判断一律作废）】\n${previousText}\n\n${eventsBlock}`;
}

export async function maybeRunCoreMemoryPipeline(
    characterId: string,
    characterName: string,
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoBuildCoreEnabled) return;

    const counter = getCoreMemoryCounter(characterId);
    if (counter < config.coreSummarizationInterval) return;

    if (coreBuildingSet.has(characterId)) return;
    coreBuildingSet.add(characterId);
    try {
        const result = await runCoreMemoryPipeline(characterId, characterName);
        if (!result.success) {
            console.warn("[CoreMemory] Auto summary failed:", result.error);
        }
    } finally {
        coreBuildingSet.delete(characterId);
    }
}
