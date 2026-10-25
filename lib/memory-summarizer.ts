// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
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
        .replace(/\n*###\s*未解决问题[\s\S]*?(?=\n###|\n\*\*重要性\*\*|\n重要性|\n\*\*检索关键词\*\*|\n检索关键词|$)/gi, "")
        .replace(/\n*(?:\*\*重要性\*\*|重要性|重要程度)\s*[：:][^\n]*/gi, "")
        .replace(/\n*(?:\*\*检索关键词\*\*|检索关键词|关键词)\s*[：:][^\n]*/gi, "")
        .trim();
    return stripInlineMemoryTimeMarkers(stripped);
}

/**
 * Extract vector retrieval keywords and importance from Markdown memory content.
 */
export function extractMemoryStructuredMeta(content: string): ParsedMemoryMetadata {
    const keywords: string[] = [];
    let importance: number | undefined;

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
            if (word && !/^(重要性|检索关键词|关键词|事件总结|未解决问题)$/.test(word) && !keywords.includes(word)) {
                keywords.push(word);
                if (keywords.length >= 6) break;
            }
        }
    }

    return { keywords, importance };
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
function resolveSummarizationApiConfig(characterId: string) {
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

        for (let topicIdx = 0; topicIdx < topicBlocks.length; topicIdx++) {
            const block = topicBlocks[topicIdx];
            const { keywords, importance } = extractMemoryStructuredMeta(block);
            const cleanSummaryBody = stripMemoryStructuredSections(block) || stripInlineMemoryTimeMarkers(block);
            if (!cleanSummaryBody) continue;

            // Generate dedicated vector embedding for this single-topic memory
            let embedding: number[] | undefined;
            if (canEmbed && embeddingApiConfig) {
                try {
                    const embeddingInput = keywords.length > 0
                        ? `关键词：${keywords.join("、")}\n${cleanSummaryBody}`
                        : cleanSummaryBody;
                    const emb = await generateEmbedding(embeddingInput, embeddingApiConfig);
                    if (emb) embedding = emb;
                } catch { /* ignore */ }
            }

            const createdAtIso = new Date(Date.now() + dayIdx * 100 + topicIdx).toISOString();
            const resolvedImportance = importance ?? 0.8;

            const longTermEntry: MemoryEntry = {
                id: `mem_lt_${Date.now()}_${dayIdx}_${topicIdx}_${Math.random().toString(36).slice(2, 7)}`,
                characterId,
                sourceApp: dominantSource as MemoryEntry["sourceApp"],
                type: "long_term",
                content: cleanSummaryBody,
                embedding,
                importance: resolvedImportance,
                accessCount: 0,
                createdAt: createdAtIso,
                updatedAt: createdAtIso,
                metadata: {
                    eventDate: dayKey,
                    summarizedEvents: dayEntries.length,
                    timeSpan: `${earliest} ~ ${latest}`,
                    sourceSessionIds,
                    accessCount: 0,
                    keywords,
                },
            };
            await saveMemoryEntry(longTermEntry);
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
    if (latestSummarizedTs) {
        setLastSummarizedTimestamp(characterId, latestSummarizedTs);
    }
    resetEventCounter(characterId);

    // Enforce long-term limit
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    await maybeRunCoreMemoryPipeline(characterId, characterName);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries across ${summarizedDayCount} day(s) into ${savedEntryCount} memory entries`);
    return { success: true };
}
