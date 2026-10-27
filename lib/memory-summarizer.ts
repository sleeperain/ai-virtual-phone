// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT, DEFAULT_MEMORY_RESPLIT_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbeddingsBatch, resolveEmbeddingModel, cosineSimilarity, keywordOverlapRatio } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";

import { loadBindingConfig, loadApiConfigs, resolveBinding } from "./settings-storage";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

/** Legacy default prompt before Markdown + keywords + unresolved issues upgrade */
const LEGACY_SUMMARIZATION_PROMPT_SIGNATURE = "不要包含格式标记";

export type ParsedMemoryMetadata = {
    keywords: string[];
    importance?: number; // 0-1 normalized
    eventDate?: string;  // YYYY-MM-DD extracted from resplit output
};

/**
 * Strip inline date/time headers and timestamps from memory body so the stored text itself
 * does not contain time markers (the entry's eventDate metadata carries the date).
 */
export function stripInlineMemoryTimeMarkers(content: string): string {
    return content
        .replace(/^(?:#+\s*)?(?:\d{4}年)?\d{1,2}月\d{1,2}日(?:[上中下]午|早[上晨]|傍晚|晚上|深夜|凌晨|中午|夜里|夜间)?\s*$/gm, "")
        .replace(/^(?:#+\s*)?\d{4}-\d{2}-\d{2}(?:\s+(?:[上中下]午|早[上晨]|傍晚|晚上|深夜|凌晨))?\s*$/gm, "")
        .replace(/^(\s*[-*•]?\s*)(?:\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]|\(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\)|\d{1,2}:\d{2}(?:\s*[-~至]\s*\d{1,2}:\d{2})?)\s*[-—:：]?\s*/gm, "$1")
        .replace(/^(\s*[-*•]?\s*)(?:\d{4}年)?\d{1,2}月\d{1,2}日(?:[上中下]午|早[上晨]|傍晚|晚上|深夜|凌晨|中午)?[，,、：\s]+/gm, "$1")
        .replace(/【未解决[^】]*】/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Strip the trailing structured sections (**重要性**, **检索关键词**, legacy ### 未解决问题 / ### 事件总结) from display body
 * so they aren't rendered twice when the card already displays them as metadata badges/chips.
 */
export function stripMemoryStructuredSections(content: string): string {
    const stripped = content
        .replace(/^###\s*事件总结\s*\n+/i, "")
        .replace(/\n*###\s*未解决问题[\s\S]*?(?=\n###|\n\*\*事件日期\*\*|\n事件日期|\n\*\*重要性\*\*|\n重要性|\n\*\*检索关键词\*\*|\n检索关键词|$)/gi, "")
        .replace(/\n*(?:\*\*事件日期\*\*|事件日期|所属日期|日期)\s*[：:][^\n]*/gi, "")
        .replace(/\n*(?:\*\*重要性\*\*|重要性|重要程度)\s*[：:][^\n]*/gi, "")
        .replace(/\n*(?:\*\*检索关键词\*\*|检索关键词|关键词)\s*[：:][^\n]*/gi, "")
        .trim();
    return stripInlineMemoryTimeMarkers(stripped);
}

/**
 * Extract vector retrieval keywords, importance, and optional eventDate from Markdown memory content.
 */
export function extractMemoryStructuredMeta(content: string): ParsedMemoryMetadata {
    const keywords: string[] = [];
    let importance: number | undefined;
    let eventDate: string | undefined;

    // 0. Extract eventDate if present (e.g. **事件日期**：2025-10-23)
    const dateMatch = content.match(/(?:\*\*事件日期\*\*|事件日期|所属日期)\s*[：:]\s*(\d{4}-\d{2}-\d{2})/i);
    if (dateMatch?.[1]) {
        eventDate = dateMatch[1].trim();
    }

    // 1. Extract importance (supports 1-10 or 0-1 or percentage)
    const impMatch = content.match(/(?:\*\*重要性\*\*|重要性|重要程度)\s*[：:]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*10|%)?/i);
    if (impMatch?.[1]) {
        const rawNum = parseFloat(impMatch[1]);
        if (Number.isFinite(rawNum)) {
            if (rawNum > 1 && rawNum <= 10) {
                importance = Math.max(0.1, Math.min(1, Number((rawNum / 10).toFixed(2))));
            } else if (rawNum > 10 && rawNum <= 100) {
                importance = Math.max(0.1, Math.min(1, Number((rawNum / 100).toFixed(2))));
            } else if (rawNum >= 0 && rawNum <= 1) {
                importance = Math.max(0.1, Math.min(1, Number(rawNum.toFixed(2))));
            }
        }
    }

    // 2. Extract keywords from **检索关键词**：... or 检索关键词：... or [关键词：...]
    const kwMatch = content.match(/(?:\*\*检索关键词\*\*|检索关键词|关键词)\s*[：:]\s*([^\n]+)/i);
    if (kwMatch?.[1]) {
        const rawList = kwMatch[1]
            .replace(/^[`[\]【】\s]+|[`[\]【】\s]+$/g, "")
            .split(/[、，,；;|/]+/)
            .map(s => s.replace(/^[-*#`]+|[-*#`]+$/g, "").trim())
            .filter(Boolean);
        for (const kw of rawList) {
            if (!keywords.includes(kw)) keywords.push(kw);
        }
    }

    // Fallback keyword extraction if LLM omitted the explicit line
    if (keywords.length === 0) {
        const boldMatches = content.match(/\*\*([^*]{2,12})\*\*/g) || [];
        for (const m of boldMatches) {
            const word = m.replace(/\*\*/g, "").trim();
            if (word && !/^(事件日期|所属日期|重要性|检索关键词|关键词|事件总结|未解决问题)$/.test(word) && !keywords.includes(word)) {
                keywords.push(word);
                if (keywords.length >= 6) break;
            }
        }
    }

    return { keywords, importance, eventDate };
}

/**
 * Split a day's LLM summary output into multiple topic-level memory segments.
 * Supports `---` horizontal rules or multiple blocks each ending with `**检索关键词**`.
 */
export function splitMultiTopicSummaries(rawOutput: string): string[] {
    const trimmed = rawOutput.trim();
    if (!trimmed) return [];

    const byHr = trimmed
        .split(/\n\s*---+\s*\n/)
        .map(s => s.trim())
        .filter(Boolean);
    if (byHr.length > 1) return byHr;

    const kwRegex = /(?:\*\*检索关键词\*\*|检索关键词|关键词)\s*[：:][^\n]+(?:\n|$)/gi;
    const matches = Array.from(trimmed.matchAll(kwRegex));
    if (matches.length > 1) {
        const blocks: string[] = [];
        let lastIndex = 0;
        for (const m of matches) {
            const endIdx = (m.index ?? 0) + m[0].length;
            const chunk = trimmed.slice(lastIndex, endIdx).trim();
            if (chunk) blocks.push(chunk);
            lastIndex = endIdx;
        }
        const tail = trimmed.slice(lastIndex).trim();
        if (tail && stripMemoryStructuredSections(tail).length > 10) {
            blocks.push(tail);
        }
        if (blocks.length > 1) return blocks;
    }

    return [trimmed];
}

/**
 * Convert an ISO timestamp into local date key "YYYY-MM-DD".
 */
function toLocalDayKey(isoStr: string): string {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.slice(0, 10) || "未知日期";
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Resolve API config for memory summarization with character-level fallback:
 * 1. Auxiliary binding `memorySummaryApiConfigId`
 * 2. Global default `apiConfigId`
 * 3. Character's bound `apiConfigId` (chat / default)
 * 4. First valid configured API
 */
export function resolveSummarizationApiConfig(characterId: string) {
    const aux = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (aux && aux.apiKey) return aux;
    const bindingCfg = loadBindingConfig();
    const apiConfigs = loadApiConfigs();
    const charSlot = resolveBinding(bindingCfg, characterId, "chat");
    if (charSlot.apiConfigId) {
        const found = apiConfigs.find(c => c.id === charSlot.apiConfigId && c.apiKey);
        if (found) return found;
    }
    return apiConfigs.find(c => Boolean(c.apiKey)) ?? aux ?? null;
}

/**
 * Check if summarization should run based on event counter OR unsummarized timeline count, then execute.
 * Fixes the bug where counter was out of sync with actual unsummarized events or failed silently after threshold.
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const interval = Math.max(4, config.summarizationEventInterval || 80);
    let counter = getEventCounter(characterId);

    // Self-healing check: even if counter was reset or missed (e.g. native tools or page reload),
    // check actual unsummarized timeline entries since last watermark.
    if (counter < interval) {
        try {
            const afterTimestamp = getLastSummarizedTimestamp(characterId) ?? undefined;
            const unsummarizedCount = filterTimelineByAllowedSources(
                loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
                config.shortTermAllowedSources,
            ).length;
            if (unsummarizedCount >= interval) {
                counter = unsummarizedCount;
            }
        } catch { /* ignore */ }
    }

    if (counter < interval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        const res = await runSummarizationPipeline(characterId, characterName);
        if (!res.success) {
            console.warn(`[MemorySummarizer] Auto-summarization failed for ${characterName}: ${res.error}`);
        }
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding (with fallback to character/global API config)
    const apiConfig = resolveSummarizationApiConfig(characterId);
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    let allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );

    if (allEntries.length < 4) {
        // 不要在事件不足 4 条时直接把 counter 清零——否则用户刚过阈值但因时间戳微差或过滤后
        // 暂时不足 4 条时，计数器归零会导致后续再发几十条都不触发总结！
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    // Cap batch size for automatic background trigger so a huge backlog doesn't block in one go
    const MAX_AUTO_BATCH_ENTRIES = 160;
    const isManualRange = Boolean(options?.force || options?.sinceTimestamp);
    if (!isManualRange && allEntries.length > MAX_AUTO_BATCH_ENTRIES) {
        allEntries = allEntries.slice(0, MAX_AUTO_BATCH_ENTRIES);
    }

    // Group entries by local calendar day (YYYY-MM-DD) so each day's events are summarized
    // independently instead of mixing multiple days into one messy wall of text.
    const dayBuckets = new Map<string, typeof allEntries>();
    for (const entry of allEntries) {
        const dayKey = toLocalDayKey(entry.timestamp);
        const list = dayBuckets.get(dayKey);
        if (list) list.push(entry);
        else dayBuckets.set(dayKey, [entry]);
    }

    const sortedDays = Array.from(dayBuckets.keys()).sort((a, b) => a.localeCompare(b));

    // Use user-editable prompt template from config; auto-upgrade legacy default prompt
    const rawSavedPrompt = config.summarizationPrompt?.trim() || "";
    const isLegacyDefault = rawSavedPrompt.includes(LEGACY_SUMMARIZATION_PROMPT_SIGNATURE)
        || rawSavedPrompt.includes("### 未解决问题")
        || rawSavedPrompt.includes("时间跨度：{{earliest}}")
        || rawSavedPrompt.includes("控制在 80-200 字左右");
    let promptTemplate = (!rawSavedPrompt || isLegacyDefault)
        ? DEFAULT_SUMMARIZATION_PROMPT
        : rawSavedPrompt;

    // Enforce our core rules even when the user has a custom summarization prompt:
    // 1. Split distinct topics with `---`
    // 2. No dates/timestamps inside the memory body
    // 3. Output **重要性** and **检索关键词** at the end of each topic memory
    const ruleEnforcement = `\n\n【硬性格式要求（最高优先级）】：\n1. **按独立话题拆条**：当天若包含多个互不相关的话题或事件，必须拆成多条独立记忆，每条之间用单独一行的 \`---\` 分隔。\n2. **记忆正文中严禁出现任何日期或具体时间**（如“10月23日”、“上午”、“18:03”等一律不写，系统会自动记录该记忆所属日期）。\n3. 每条记忆末尾必须各自单独输出两行：\n**重要性**：（1-10的整数）\n**检索关键词**：关键词1、关键词2、关键词3`;
    if (!promptTemplate.includes("按独立话题拆条") && !promptTemplate.includes("按话题拆条")) {
        promptTemplate += ruleEnforcement;
    }

    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    const canEmbed = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig));

    // Load existing long-term entries for deduplication check
    const existingLongTerm = await loadMemoryEntriesByType(characterId, "long_term");

    let summarizedDayCount = 0;
    let savedEntryCount = 0;
    let lastError = "";
    let latestSummarizedTs = "";

    for (let dayIdx = 0; dayIdx < sortedDays.length; dayIdx++) {
        const dayKey = sortedDays[dayIdx];
        const dayEntries = dayBuckets.get(dayKey)!;
        // Format events with timeAware=false so individual event timestamps are stripped before sending to LLM
        const formatted = formatTimelineForSummarization(dayEntries, { timeAware: false });
        if (!formatted) continue;

        const { eventsText, earliest, latest } = formatted;
        const summaryPrompt = promptTemplate
            .replace(/\{\{char\}\}/gi, characterName)
            .replace(/\{\{earliest\}\}/gi, dayKey)
            .replace(/\{\{latest\}\}/gi, dayKey)
            .replace(/\{\{events\}\}/gi, eventsText);

        let result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: summaryPrompt }],
            { temperature: 0.3, label: `记忆总结·${characterName}·${dayKey}` },
        );
        if (!result.content && !result.wasTruncated) {
            await new Promise(r => setTimeout(r, 1200));
            result = await simpleLLMCall(
                apiConfig,
                [{ role: "user", content: summaryPrompt }],
                { temperature: 0.3, label: `记忆总结重试·${characterName}·${dayKey}` },
            );
        }

        if (!result.content) {
            lastError = result.error || `总结 ${dayKey} 时 LLM 返回了空内容`;
            continue;
        }

        if (result.wasTruncated && result.content.trim().length < 40) {
            lastError = `总结 ${dayKey} 结果疑似被截断`;
            continue;
        }

        const rawSummary = result.content.trim();
        const topicBlocks = splitMultiTopicSummaries(rawSummary);

        // Determine dominant sourceApp for this day's entries
        const sourceCounts = new Map<string, number>();
        for (const e of dayEntries) {
            sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
        }
        let dominantSource = "chat";
        let maxCount = 0;
        for (const [src, count] of sourceCounts) {
            if (count > maxCount) { dominantSource = src; maxCount = count; }
        }
        const sourceSessionIds = Array.from(new Set(
            dayEntries
                .map(entry => entry.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId)),
        ));

        // Parse all blocks for this day first so we can batch-generate embeddings
        const parsedTopics: Array<{
            cleanBody: string;
            keywords: string[];
            importance: number;
            embeddingInput: string;
        }> = [];

        for (const block of topicBlocks) {
            const { keywords, importance } = extractMemoryStructuredMeta(block);
            const cleanSummaryBody = stripMemoryStructuredSections(block) || stripInlineMemoryTimeMarkers(block);
            if (!cleanSummaryBody) continue;
            const embeddingInput = keywords.length > 0
                ? `关键词：${keywords.join("、")}\n${cleanSummaryBody}`
                : cleanSummaryBody;
            parsedTopics.push({
                cleanBody: cleanSummaryBody,
                keywords,
                importance: importance ?? 0.8,
                embeddingInput,
            });
        }

        if (parsedTopics.length === 0) continue;

        let batchEmbeddings: Array<number[] | null> = [];
        if (canEmbed && embeddingApiConfig) {
            try {
                batchEmbeddings = await generateEmbeddingsBatch(
                    parsedTopics.map(t => t.embeddingInput),
                    embeddingApiConfig,
                );
            } catch { /* ignore */ }
        }

        for (let topicIdx = 0; topicIdx < parsedTopics.length; topicIdx++) {
            const topic = parsedTopics[topicIdx];
            const embedding = batchEmbeddings[topicIdx] ?? undefined;
            const createdAtIso = new Date(Date.now() + dayIdx * 100 + topicIdx).toISOString();

            // Deduplication check: if an existing memory on the same/nearby day is highly similar (>= 0.88),
            // merge into it instead of creating a duplicate entry.
            const duplicate = findNearDuplicateMemory(existingLongTerm, dayKey, topic.cleanBody, embedding);
            if (duplicate) {
                const existingKws = Array.isArray(duplicate.metadata?.keywords)
                    ? (duplicate.metadata.keywords as unknown[]).map(String)
                    : [];
                const mergedKeywords = Array.from(new Set([...existingKws, ...topic.keywords])).slice(0, 10);
                const mergedEntry: MemoryEntry = {
                    ...duplicate,
                    content: topic.cleanBody.length >= duplicate.content.length ? topic.cleanBody : duplicate.content,
                    embedding: embedding ?? duplicate.embedding,
                    importance: Math.max(duplicate.importance ?? 0.8, topic.importance),
                    updatedAt: createdAtIso,
                    metadata: {
                        ...(duplicate.metadata ?? {}),
                        eventDate: dayKey,
                        keywords: mergedKeywords,
                        ...(embedding ? { embeddingDim: embedding.length } : {}),
                    },
                };
                await saveMemoryEntry(mergedEntry);
                const idx = existingLongTerm.findIndex(e => e.id === duplicate.id);
                if (idx !== -1) existingLongTerm[idx] = mergedEntry;
                savedEntryCount += 1;
                continue;
            }

            const longTermEntry: MemoryEntry = {
                id: `mem_lt_${Date.now()}_${dayIdx}_${topicIdx}_${Math.random().toString(36).slice(2, 7)}`,
                characterId,
                sourceApp: dominantSource as MemoryEntry["sourceApp"],
                type: "long_term",
                content: topic.cleanBody,
                embedding,
                importance: topic.importance,
                accessCount: 0,
                createdAt: createdAtIso,
                updatedAt: createdAtIso,
                metadata: {
                    eventDate: dayKey,
                    summarizedEvents: dayEntries.length,
                    timeSpan: `${earliest} ~ ${latest}`,
                    sourceSessionIds,
                    accessCount: 0,
                    keywords: topic.keywords,
                    topicSplitV2: true,
                    ...(embedding ? { embeddingDim: embedding.length } : {}),
                },
            };
            await saveMemoryEntry(longTermEntry);
            existingLongTerm.unshift(longTermEntry);
            savedEntryCount += 1;
        }

        latestSummarizedTs = latest;
        summarizedDayCount += 1;
        incrementCoreMemoryCounter(characterId);
    }

    if (summarizedDayCount === 0 || savedEntryCount === 0) {
        return { success: false, error: lastError || "未能生成有效的记忆总结" };
    }

    // Update last summarized timestamp + reset counter
    // When summarizing a manual recent window (sinceTimestamp), only advance the watermark
    // if there wasn't an older unsummarized gap before sinceTimestamp, and never move the watermark backwards.
    if (latestSummarizedTs) {
        const prevWatermark = getLastSummarizedTimestamp(characterId);
        const skipsUnsummarizedGap = Boolean(
            options?.sinceTimestamp && (!prevWatermark || options.sinceTimestamp > prevWatermark)
        );
        if (!skipsUnsummarizedGap && (!prevWatermark || latestSummarizedTs > prevWatermark)) {
            setLastSummarizedTimestamp(characterId, latestSummarizedTs);
        }
    }
    resetEventCounter(characterId);

    // Enforce long-term limit (only on long_term entries — never evict core memories!)
    const allLongTerm = await loadMemoryEntriesByType(characterId, "long_term");
    if (allLongTerm.length > config.maxLongTermEntries) {
        const evictionSorted = [...allLongTerm].sort((a, b) => {
            const impA = Number.isFinite(a.importance) ? a.importance : 0.8;
            const impB = Number.isFinite(b.importance) ? b.importance : 0.8;
            // Protect milestone memories (>= 0.9) from eviction unless everything is a milestone
            const milestoneA = impA >= 0.9 ? 1 : 0;
            const milestoneB = impB >= 0.9 ? 1 : 0;
            if (milestoneA !== milestoneB) return milestoneA - milestoneB;
            return a.createdAt.localeCompare(b.createdAt);
        });
        const excess = evictionSorted.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    await maybeRunCoreMemoryPipeline(characterId, characterName);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries across ${summarizedDayCount} day(s) into ${savedEntryCount} memory entries`);
    return { success: true };
}

/**
 * Find if a newly summarized topic is a near-duplicate of an existing long-term memory.
 */
function findNearDuplicateMemory(
    existingEntries: MemoryEntry[],
    dayKey: string,
    newBody: string,
    newEmbedding?: number[]
): MemoryEntry | null {
    for (const item of existingEntries) {
        const itemDate = typeof item.metadata?.eventDate === "string"
            ? item.metadata.eventDate.trim()
            : item.createdAt.slice(0, 10);
        const sameDay = itemDate === dayKey;
        if (
            newEmbedding &&
            newEmbedding.length > 0 &&
            Array.isArray(item.embedding) &&
            item.embedding.length === newEmbedding.length
        ) {
            const sim = cosineSimilarity(newEmbedding, item.embedding);
            if (sim >= (sameDay ? 0.87 : 0.91)) return item;
        }
        if (sameDay) {
            const overlap = keywordOverlapRatio(newBody, item.content);
            if (overlap >= 0.82) return item;
        }
    }
    return null;
}

/**
 * 判断一条已有长期记忆是否属于「修改前未拆条/混杂的旧记忆」：
 * 1. 已显式标记过 `metadata.resplitDone` 或 `metadata.topicSplitV2` 且字数适中（<= 160字）且有关键词 → 已整理，不需重拆；
 * 2. 包含多个分段换行、列表项、`---`、或者内嵌多个日期/时间点、或者正文超过 145 字、或者缺少检索关键词 → 属于待整理旧记忆。
 */
export function isLegacyUnorganizedMemory(entry: MemoryEntry): boolean {
    if (entry.type !== "long_term") return false;
    if (entry.metadata?.resplitDone === true) return false;

    const cleanBody = stripMemoryStructuredSections(entry.content) || entry.content.trim();
    const kws = Array.isArray(entry.metadata?.keywords)
        ? (entry.metadata.keywords as unknown[]).filter(Boolean)
        : extractMemoryStructuredMeta(entry.content).keywords;

    const hasMultipleParagraphs = cleanBody.split(/\n+/).filter(line => line.trim().length > 8).length >= 2;
    const hasInlineDateMarkers = /(?:\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日|###\s*未解决问题|###\s*事件总结)/.test(entry.content);
    const isTooLong = cleanBody.length > 145;
    const missingKeywords = kws.length === 0;

    if (entry.metadata?.topicSplitV2 === true && !isTooLong && !hasMultipleParagraphs && !missingKeywords) {
        return false;
    }

    return isTooLong || hasMultipleParagraphs || hasInlineDateMarkers || missingKeywords;
}

/**
 * 将单条混杂的旧长期记忆（可能是一整天或跨多天的堆叠记录）通过 LLM 重新拆分为 1~N 条独立话题记忆，
 * 自动提取日期、重要性、检索关键词并批量生成 Embedding 向量，成功后替换原记忆。
 */
export async function resplitSingleMemoryEntry(
    entry: MemoryEntry,
    characterName: string
): Promise<{ success: boolean; newEntries?: MemoryEntry[]; error?: string }> {
    const config = loadMemoryConfig();
    const apiConfig = resolveSummarizationApiConfig(entry.characterId);
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在设置 → 绑定配置 → 辅助API绑定中设置）" };
    }

    const fallbackDate = typeof entry.metadata?.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.metadata.eventDate.trim())
        ? entry.metadata.eventDate.trim()
        : toLocalDayKey(entry.createdAt);

    const rawBody = stripMemoryStructuredSections(entry.content) || entry.content.trim();
    if (!rawBody) {
        return { success: false, error: "该记忆内容为空" };
    }

    const prompt = DEFAULT_MEMORY_RESPLIT_PROMPT
        .replace(/\{\{char\}\}/gi, characterName || "角色")
        .replace(/\{\{eventDate\}\}/gi, fallbackDate)
        .replace(/\{\{content\}\}/gi, entry.content.trim());

    let result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.25, label: `旧记忆拆分整理·${characterName}·${fallbackDate}` },
    );
    if (!result.content && !result.wasTruncated) {
        await new Promise(r => setTimeout(r, 1000));
        result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: prompt }],
            { temperature: 0.25, label: `旧记忆拆分重试·${characterName}·${fallbackDate}` },
        );
    }

    if (!result.content) {
        return { success: false, error: result.error || "模型未返回有效拆分结果" };
    }

    const blocks = splitMultiTopicSummaries(result.content.trim());
    const parsedItems: Array<{
        cleanBody: string;
        keywords: string[];
        importance: number;
        eventDate: string;
        embeddingInput: string;
    }> = [];

    for (const block of blocks) {
        const meta = extractMemoryStructuredMeta(block);
        const cleanBody = stripMemoryStructuredSections(block) || stripInlineMemoryTimeMarkers(block);
        if (!cleanBody || cleanBody.length < 4) continue;
        const resolvedDate = meta.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(meta.eventDate)
            ? meta.eventDate
            : fallbackDate;
        const kws = meta.keywords;
        const embeddingInput = kws.length > 0
            ? `关键词：${kws.join("、")}\n${cleanBody}`
            : cleanBody;
        parsedItems.push({
            cleanBody,
            keywords: kws,
            importance: meta.importance ?? (Number.isFinite(entry.importance) ? entry.importance : 0.8),
            eventDate: resolvedDate,
            embeddingInput,
        });
    }

    if (parsedItems.length === 0) {
        return { success: false, error: "未能从模型返回内容中解析出有效记忆条目" };
    }

    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    const canEmbed = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig));
    let embeddings: Array<number[] | null> = [];
    if (canEmbed && embeddingApiConfig) {
        try {
            embeddings = await generateEmbeddingsBatch(
                parsedItems.map(p => p.embeddingInput),
                embeddingApiConfig,
            );
        } catch { /* ignore */ }
    }

    const nowMs = Date.now();
    const baseAccessCount = typeof entry.accessCount === "number"
        ? entry.accessCount
        : (typeof entry.metadata?.accessCount === "number" ? Number(entry.metadata.accessCount) : 0);

    const createdEntries: MemoryEntry[] = [];
    for (let i = 0; i < parsedItems.length; i++) {
        const item = parsedItems[i];
        const emb = embeddings[i] ?? undefined;
        // Preserve original createdAt ordering with slight offset so timeline stays stable
        const baseCreatedTime = new Date(entry.createdAt).getTime();
        const entryCreatedIso = !isNaN(baseCreatedTime)
            ? new Date(baseCreatedTime + i * 10).toISOString()
            : new Date(nowMs + i * 10).toISOString();

        const newEntry: MemoryEntry = {
            id: parsedItems.length === 1
                ? entry.id
                : `mem_lt_${nowMs}_rs_${i}_${Math.random().toString(36).slice(2, 7)}`,
            characterId: entry.characterId,
            sourceApp: entry.sourceApp || "chat",
            type: "long_term",
            content: item.cleanBody,
            embedding: emb,
            importance: item.importance,
            accessCount: i === 0 ? baseAccessCount : 0,
            createdAt: entryCreatedIso,
            updatedAt: new Date(nowMs + i * 10).toISOString(),
            metadata: {
                ...(entry.metadata ?? {}),
                eventDate: item.eventDate,
                keywords: item.keywords,
                accessCount: i === 0 ? baseAccessCount : 0,
                resplitDone: true,
                topicSplitV2: true,
                resplitFromId: entry.id,
                ...(emb ? { embeddingDim: emb.length } : {}),
            },
        };
        await saveMemoryEntry(newEntry);
        createdEntries.push(newEntry);
    }

    // Remove the original monolithic entry if it was split into multiple new IDs
    if (parsedItems.length > 1) {
        await deleteMemoryEntry(entry.id);
    }

    return { success: true, newEntries: createdEntries };
}

/**
 * 批量扫描并拆分整理某个角色下所有混杂/未拆条的旧版长期记忆。
 */
export async function runLegacyMemoriesResplit(
    characterId: string,
    characterName: string,
    options?: {
        targetEntries?: MemoryEntry[];
        onProgress?: (done: number, total: number, newCount: number) => void;
    }
): Promise<{ success: boolean; processedCount: number; newTotalCount: number; error?: string }> {
    const allLongTerm = options?.targetEntries
        ?? (await loadMemoryEntriesByType(characterId, "long_term")).filter(isLegacyUnorganizedMemory);

    if (allLongTerm.length === 0) {
        return { success: true, processedCount: 0, newTotalCount: 0 };
    }

    let processedCount = 0;
    let newTotalCount = 0;
    let lastError = "";

    for (let i = 0; i < allLongTerm.length; i++) {
        const legacyEntry = allLongTerm[i];
        const res = await resplitSingleMemoryEntry(legacyEntry, characterName);
        if (res.success && res.newEntries) {
            processedCount += 1;
            newTotalCount += res.newEntries.length;
        } else if (res.error) {
            lastError = res.error;
        }
        options?.onProgress?.(i + 1, allLongTerm.length, newTotalCount);
    }

    if (processedCount === 0) {
        return { success: false, processedCount: 0, newTotalCount: 0, error: lastError || "旧记忆拆分整理失败" };
    }

    return { success: true, processedCount, newTotalCount };
}
