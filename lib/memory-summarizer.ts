// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT, DEFAULT_MANUAL_TEXT_CLEAN_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
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
import { generateEmbeddingsBatch, resolveEmbeddingModel, cosineSimilarity, keywordOverlapRatio } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";
import {
    buildSupersededMetadata,
    computeSupersededSpans,
    effectiveImportance,
    REVISION_EXACT_THRESHOLD,
    REVISION_META_KEYS,
} from "./memory-revision";

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
 * Extract first natural date from arbitrary raw text and normalize to YYYY-MM-DD.
 * Supports: 2025-10-23, 2025/10/23, 2025.10.23, 2025年10月23日, 10月23日 (uses fallbackYear).
 */
export function extractDateFromRawText(text: string, fallbackYear?: number): string | undefined {
    const year = fallbackYear ?? new Date().getFullYear();
    // 1. Explicit structured field first
    const fieldMatch = text.match(/(?:\*\*事件日期\*\*|事件日期|所属日期|日期)\s*[：:]\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/i);
    if (fieldMatch) {
        const y = Number(fieldMatch[1]);
        const m = Number(fieldMatch[2]);
        const d = Number(fieldMatch[3]);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        }
    }
    // 2. Full YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYY年M月D日 anywhere in text
    const fullMatch = text.match(/(?:^|[^\d])(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?=$|[^\d])/);
    if (fullMatch) {
        const y = Number(fullMatch[1]);
        const m = Number(fullMatch[2]);
        const d = Number(fullMatch[3]);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        }
    }
    // 3. M月D日 or M月D号
    const mdMatch = text.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (mdMatch) {
        const m = Number(mdMatch[1]);
        const d = Number(mdMatch[2]);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        }
    }
    return undefined;
}

/**
 * Extract vector retrieval keywords, importance, and optional eventDate from Markdown memory content.
 */
export function extractMemoryStructuredMeta(content: string): ParsedMemoryMetadata {
    const keywords: string[] = [];
    let importance: number | undefined;
    const eventDate = extractDateFromRawText(content);

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

            // 相似记忆处理，分两种情形：
            // 1. 几乎一字不差（相似度 >= REVISION_EXACT_THRESHOLD）：合并进旧条目，沿用原行为；
            // 2. 部分或全部被改写：旧条目保留，把被改掉的字句标成「划掉」并降权，新记忆独立入库。
            //    这样「原来住城东」改成「搬去城西」时，旧记忆不会连着新事实一起消失。
            const match = findNearDuplicateMemory(existingLongTerm, dayKey, topic.cleanBody, embedding);
            // 划掉区间的基准必须是「显示用的正文」而不是原始 content：
            // 卡片渲染时展示的是 stripMemoryStructuredSections 之后的内容，
            // 用原始 content 算偏移会因为末尾元数据段被剥掉而错位。
            const oldBaseText = match
                ? (stripMemoryStructuredSections(match.entry.content) || match.entry.content)
                : "";
            const revision = match && match.similarity < REVISION_EXACT_THRESHOLD
                ? computeSupersededSpans(oldBaseText, topic.cleanBody)
                : null;
            const duplicate = match && (!revision || revision.spans.length === 0) ? match.entry : null;
            if (duplicate) {
                const existingKws = Array.isArray(duplicate.metadata?.keywords)
                    ? (duplicate.metadata.keywords as unknown[]).map(String)
                    : [];
                const mergedKeywords = Array.from(new Set([...existingKws, ...topic.keywords])).slice(0, 10);
                const mergedContent = topic.cleanBody.length >= duplicate.content.length ? topic.cleanBody : duplicate.content;
                // 正文被换成新文本时，旧的划掉区间（按老正文下标算的）已经失效，必须一并清掉，
                // 否则删除线会画到毫不相干的位置上。
                const contentReplaced = mergedContent !== duplicate.content;
                const mergedMetadata: Record<string, unknown> = {
                    ...(duplicate.metadata ?? {}),
                    eventDate: dayKey,
                    keywords: mergedKeywords,
                    ...(embedding ? { embeddingDim: embedding.length } : {}),
                };
                if (contentReplaced) {
                    delete mergedMetadata[REVISION_META_KEYS.by];
                    delete mergedMetadata[REVISION_META_KEYS.at];
                    delete mergedMetadata[REVISION_META_KEYS.spans];
                    delete mergedMetadata[REVISION_META_KEYS.ratio];
                    delete mergedMetadata[REVISION_META_KEYS.similarity];
                    // 权重也还原：这条现在就是最新版本
                    delete mergedMetadata[REVISION_META_KEYS.weight];
                }
                const mergedEntry: MemoryEntry = {
                    ...duplicate,
                    content: mergedContent,
                    embedding: embedding ?? duplicate.embedding,
                    importance: Math.max(duplicate.importance ?? 0.8, topic.importance),
                    updatedAt: createdAtIso,
                    metadata: mergedMetadata,
                };
                await saveMemoryEntry(mergedEntry);
                const idx = existingLongTerm.findIndex(e => e.id === duplicate.id);
                if (idx !== -1) existingLongTerm[idx] = mergedEntry;
                savedEntryCount += 1;
                continue;
            }

            const newEntryId = `mem_lt_${Date.now()}_${dayIdx}_${topicIdx}_${Math.random().toString(36).slice(2, 7)}`;
            const longTermEntry: MemoryEntry = {
                id: newEntryId,
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
                    // 这条记忆改写了哪条旧记忆：点进详情时能顺着找回去
                    ...(match && revision && revision.spans.length > 0 ? { revisesMemoryId: match.entry.id } : {}),
                    ...(embedding ? { embeddingDim: embedding.length } : {}),
                },
            };
            await saveMemoryEntry(longTermEntry);

            // 旧记忆不让位：把被改写的字句标成划掉并降权，其余内容照旧可用。
            if (match && revision && revision.spans.length > 0) {
                const supersededEntry: MemoryEntry = {
                    ...match.entry,
                    updatedAt: createdAtIso,
                    metadata: buildSupersededMetadata(match.entry, newEntryId, revision, undefined, oldBaseText.length),
                };
                await saveMemoryEntry(supersededEntry);
                const oldIdx = existingLongTerm.findIndex(e => e.id === match.entry.id);
                if (oldIdx !== -1) existingLongTerm[oldIdx] = supersededEntry;
            }

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
            // 用「修订后的有效重要性」排序：已被改写的旧版本会先被淘汰，
            // 不会因为原始重要性高就赖在库里占额度。
            const impA = effectiveImportance(a, 0.8);
            const impB = effectiveImportance(b, 0.8);
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
type NearDuplicateMatch = {
    entry: MemoryEntry;
    similarity: number;
};

function findNearDuplicateMemory(
    existingEntries: MemoryEntry[],
    dayKey: string,
    newBody: string,
    newEmbedding?: number[]
): NearDuplicateMatch | null {
    let best: NearDuplicateMatch | null = null;
    let bestRank = -1;
    for (const item of existingEntries) {
        const itemDate = typeof item.metadata?.eventDate === "string"
            ? item.metadata.eventDate.trim()
            : item.createdAt.slice(0, 10);
        const sameDay = itemDate === dayKey;
        let similarity = 0;
        if (
            newEmbedding &&
            newEmbedding.length > 0 &&
            Array.isArray(item.embedding) &&
            item.embedding.length === newEmbedding.length
        ) {
            const sim = cosineSimilarity(newEmbedding, item.embedding);
            if (sim >= (sameDay ? 0.87 : 0.91)) similarity = sim;
        }
        if (similarity === 0 && sameDay) {
            const overlap = keywordOverlapRatio(newBody, item.content);
            if (overlap >= 0.82) similarity = overlap;
        }
        if (similarity <= 0) continue;
        // 已经被修订过的旧版本再被改写时，优先挂在「最新那一版」上；
        // 否则划掉区间会一层层叠在最早的文本上，越叠越乱。
        const alreadySuperseded = typeof item.metadata?.[REVISION_META_KEYS.by] === "string";
        const rank = similarity - (alreadySuperseded ? 0.02 : 0);
        if (rank > bestRank) {
            bestRank = rank;
            best = { entry: item, similarity };
        }
    }
    return best;
}

import { deleteMemoryEntry } from "./memory-storage";

export type CleanedManualMemoryDraft = {
    cleanBody: string;
    eventDate: string;
    importance: number; // 1-10 integer for UI display/editing
    keywords: string[];
};

/**
 * 判断一条已有长期记忆是否属于「修改前未清洗/未拆条的旧长文本记忆」：
 * 包含多段落、内嵌日期/旧标题、正文超过 145 字、或缺少检索关键词。
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
 * 将单条旧版长文本/混杂长期记忆通过 LLM 清洗并拆分为 1~N 条规范记忆，自动提取日期、重要性与关键词并生成向量。
 */
export async function cleanLegacyMemoryEntry(
    entry: MemoryEntry,
    characterName: string
): Promise<{ success: boolean; newEntries?: MemoryEntry[]; error?: string }> {
    const config = loadMemoryConfig();
    const fallbackDate = typeof entry.metadata?.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.metadata.eventDate.trim())
        ? entry.metadata.eventDate.trim()
        : toLocalDayKey(entry.createdAt);

    const res = await cleanAndSplitManualMemoryText(
        entry.characterId,
        characterName,
        entry.content,
        fallbackDate,
    );
    if (!res.success || !res.drafts || res.drafts.length === 0) {
        return { success: false, error: res.error || "旧记忆清洗失败" };
    }

    const drafts = res.drafts;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    const canEmbed = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig));
    let embeddings: Array<number[] | null> = [];
    if (canEmbed && embeddingApiConfig) {
        try {
            embeddings = await generateEmbeddingsBatch(
                drafts.map(d => d.keywords.length > 0 ? `关键词：${d.keywords.join("、")}\n${d.cleanBody}` : d.cleanBody),
                embeddingApiConfig,
            );
        } catch { /* ignore */ }
    }

    const nowMs = Date.now();
    const baseAccessCount = typeof entry.accessCount === "number"
        ? entry.accessCount
        : (typeof entry.metadata?.accessCount === "number" ? Number(entry.metadata.accessCount) : 0);
    const baseCreatedTime = new Date(entry.createdAt).getTime();

    const createdEntries: MemoryEntry[] = [];
    for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        const emb = embeddings[i] ?? undefined;
        const entryCreatedIso = !isNaN(baseCreatedTime)
            ? new Date(baseCreatedTime + i * 10).toISOString()
            : new Date(nowMs + i * 10).toISOString();
        const normalizedImportance = Math.max(0.1, Math.min(1, Number((d.importance / 10).toFixed(2))));

        const newEntry: MemoryEntry = {
            id: drafts.length === 1
                ? entry.id
                : `mem_lt_${nowMs}_cl_${i}_${Math.random().toString(36).slice(2, 7)}`,
            characterId: entry.characterId,
            sourceApp: entry.sourceApp || "chat",
            type: "long_term",
            content: d.cleanBody,
            embedding: emb,
            importance: normalizedImportance,
            accessCount: i === 0 ? baseAccessCount : 0,
            createdAt: entryCreatedIso,
            updatedAt: new Date(nowMs + i * 10).toISOString(),
            metadata: {
                ...(entry.metadata ?? {}),
                eventDate: d.eventDate || fallbackDate,
                keywords: d.keywords,
                accessCount: i === 0 ? baseAccessCount : 0,
                resplitDone: true,
                topicSplitV2: true,
                ...(emb ? { embeddingDim: emb.length } : {}),
            },
        };
        await saveMemoryEntry(newEntry);
        createdEntries.push(newEntry);
    }

    if (drafts.length > 1) {
        await deleteMemoryEntry(entry.id);
    }

    return { success: true, newEntries: createdEntries };
}

/**
 * 一键批量清洗某个角色下所有混杂/长文本旧记忆。
 */
export async function runBatchCleanLegacyMemories(
    characterId: string,
    characterName: string,
    options?: {
        targetEntries?: MemoryEntry[];
        onProgress?: (done: number, total: number, newCount: number) => void;
    }
): Promise<{ success: boolean; processedCount: number; newTotalCount: number; error?: string }> {
    const targets = options?.targetEntries
        ?? (await loadMemoryEntriesByType(characterId, "long_term")).filter(isLegacyUnorganizedMemory);

    if (targets.length === 0) {
        return { success: true, processedCount: 0, newTotalCount: 0 };
    }

    let processedCount = 0;
    let newTotalCount = 0;
    let lastError = "";

    for (let i = 0; i < targets.length; i++) {
        const res = await cleanLegacyMemoryEntry(targets[i], characterName);
        if (res.success && res.newEntries) {
            processedCount += 1;
            newTotalCount += res.newEntries.length;
        } else if (res.error) {
            lastError = res.error;
        }
        options?.onProgress?.(i + 1, targets.length, newTotalCount);
    }

    if (processedCount === 0) {
        return { success: false, processedCount: 0, newTotalCount: 0, error: lastError || "一键清洗旧记忆失败" };
    }

    return { success: true, processedCount, newTotalCount };
}

/**
 * 调用 LLM 对用户手动录入的长文本进行清洗、按独立话题拆分、自动提取事件日期、重要性和检索关键词。
 */
export async function cleanAndSplitManualMemoryText(
    characterId: string,
    characterName: string,
    rawText: string,
    defaultEventDate: string
): Promise<{ success: boolean; drafts?: CleanedManualMemoryDraft[]; error?: string }> {
    const apiConfig = resolveSummarizationApiConfig(characterId);
    if (!apiConfig) {
        return { success: false, error: "未配置可用 API（请在设置 → API 设置或辅助API绑定中配置）" };
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
        return { success: false, error: "请先输入需要清洗的记忆文本" };
    }

    const fallbackDate = /^\d{4}-\d{2}-\d{2}$/.test(defaultEventDate.trim())
        ? defaultEventDate.trim()
        : toLocalDayKey(new Date().toISOString());
    const fallbackYear = Number(fallbackDate.slice(0, 4)) || new Date().getFullYear();

    const prompt = DEFAULT_MANUAL_TEXT_CLEAN_PROMPT
        .replace(/\{\{char\}\}/gi, characterName || "角色")
        .replace(/\{\{eventDate\}\}/gi, fallbackDate)
        .replace(/\{\{content\}\}/gi, trimmed);

    let result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.25, label: `手动记忆清洗拆分·${characterName}` },
    );
    if (!result.content && !result.wasTruncated) {
        await new Promise(r => setTimeout(r, 1000));
        result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: prompt }],
            { temperature: 0.25, label: `手动记忆清洗重试·${characterName}` },
        );
    }

    if (!result.content) {
        return { success: false, error: result.error || "模型未返回有效清洗结果" };
    }

    const blocks = splitMultiTopicSummaries(result.content.trim());
    const drafts: CleanedManualMemoryDraft[] = [];

    for (const block of blocks) {
        const meta = extractMemoryStructuredMeta(block);
        const cleanBody = stripMemoryStructuredSections(block) || stripInlineMemoryTimeMarkers(block);
        if (!cleanBody || cleanBody.length < 2) continue;
        const resolvedDate = meta.eventDate
            || extractDateFromRawText(block, fallbackYear)
            || extractDateFromRawText(trimmed, fallbackYear)
            || fallbackDate;
        const impScore = meta.importance !== undefined
            ? Math.max(1, Math.min(10, Math.round(meta.importance * 10)))
            : 8;
        drafts.push({
            cleanBody,
            eventDate: resolvedDate,
            importance: impScore,
            keywords: meta.keywords,
        });
    }

    if (drafts.length === 0) {
        return { success: false, error: "未能从模型返回内容中解析出有效记忆条目" };
    }

    return { success: true, drafts };
}
