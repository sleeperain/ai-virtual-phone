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
import { resolveSummarizationApiConfig, stripMemoryStructuredSections } from "./memory-summarizer";
import { simpleLLMCall } from "./api-helpers";
import { filterRecallableEntries, isEntryBoxDigest } from "./memory-event-boxes";
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

/** 判断是否为自动/手动提炼的「核心记忆总结」（排除角色反思与用户手动置顶的纯设定条目） */
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
    const previousSummaries = existingCoreEntries
        .filter(isAutoCoreSummaryEntry)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latestPrevSummary = previousSummaries[0];
    const previousText = latestPrevSummary
        ? (stripMemoryStructuredSections(latestPrevSummary.content) || latestPrevSummary.content).trim()
        : "";

    const { eventsText, earliest, latest } = formatted;
    const latestCursorTs = entries.reduce((max, item) => (item.timestamp > max ? item.timestamp : max), entries[0].timestamp);
    const promptTemplate = config.coreMemoryPrompt?.trim() || DEFAULT_CORE_MEMORY_PROMPT;
    const hasPreviousPlaceholder = /\{\{previous\}\}/i.test(promptTemplate);

    // 若用户自定义提示词里没写 {{previous}} 占位符，自动把上一轮核心记忆总结拼在 {{events}} 顶部，
    // 兼容「如果长期记忆记录中已包含上一轮核心记忆总结，将其作为基础进行增量更新」的写法。
    const eventsWithOptionalPrev = (!hasPreviousPlaceholder && previousText)
        ? `【上一轮核心记忆总结（待增量验证与更新）】\n${previousText}\n\n【本周期新增长期记忆与事件盒总结】\n${eventsText}`
        : eventsText;

    const prompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{previous\}\}/gi, previousText || "（首次提炼，尚无上一轮核心记忆总结）")
        .replace(/\{\{events\}\}/gi, eventsWithOptionalPrev)
        .replace(/\{\{longTermMemories\}\}/gi, eventsWithOptionalPrev);

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
