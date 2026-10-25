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
    unresolvedIssues: string[];
};

/**
 * Strip the trailing structured sections (### 未解决问题 & **检索关键词**) from display body
 * so they aren't rendered twice when the card footer already displays them as badges/boxes.
 */
export function stripMemoryStructuredSections(content: string): string {
    return content
        .replace(/\n*###\s*未解决问题[\s\S]*?(?=\n###|\n\*\*检索关键词\*\*|\n检索关键词|$)/gi, "")
        .replace(/\n*(?:\*\*检索关键词\*\*|检索关键词|关键词)\s*[：:][^\n]*/gi, "")
        .trim();
}

/**
 * Extract vector retrieval keywords and unresolved issues from Markdown memory content.
 */
export function extractMemoryStructuredMeta(content: string): ParsedMemoryMetadata {
    const keywords: string[] = [];
    const unresolvedIssues: string[] = [];

    // 1. Extract keywords from **检索关键词**：... or 检索关键词：... or [关键词：...]
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

    // 2. Extract unresolved issues section or [ ] / [未解决] items
    const unresolvedSectionMatch = content.match(/###\s*未解决问题[\s\S]*?(?=\n###|\n\*\*检索关键词\*\*|\n检索关键词|$)/i);
    if (unresolvedSectionMatch?.[0]) {
        const lines = unresolvedSectionMatch[0].split("\n").slice(1);
        for (const line of lines) {
            const cleaned = line
                .replace(/^\s*[-*•]\s*(?:\[\s*[xX ]?\s*\]\s*)?/, "")
                .replace(/^\*\*|\*\*$/g, "")
                .trim();
            if (!cleaned || /^(?:无|暂无|没有|无未解决问题|无待办事项)[。.]?$/.test(cleaned)) continue;
            if (!unresolvedIssues.includes(cleaned)) unresolvedIssues.push(cleaned);
        }
    }

    // Also catch explicit inline markers like [ ] outside the section
    const inlineCheckboxLines = content.match(/^\s*[-*]\s*\[\s*\]\s*(.+)$/gm) || [];
    for (const rawLine of inlineCheckboxLines) {
        const item = rawLine.replace(/^\s*[-*]\s*\[\s*\]\s*/, "").trim();
        if (item && !/^(?:无|暂无|没有)/.test(item) && !unresolvedIssues.includes(item)) {
            unresolvedIssues.push(item);
        }
    }

    return { keywords, unresolvedIssues };
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

    // Cap batch size per summarization call (unless force="all") so accumulated backlog
    // doesn't overflow the LLM context window and fail every time after crossing threshold.
    const MAX_AUTO_BATCH_ENTRIES = 160;
    if (!options?.force && allEntries.length > MAX_AUTO_BATCH_ENTRIES) {
        allEntries = allEntries.slice(0, MAX_AUTO_BATCH_ENTRIES);
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const { eventsText, earliest, latest } = formatted;

    // Use user-editable prompt template from config; auto-upgrade legacy default prompt that forbade markdown
    const rawSavedPrompt = config.summarizationPrompt?.trim() || "";
    const isLegacyDefault = rawSavedPrompt.includes(LEGACY_SUMMARIZATION_PROMPT_SIGNATURE);
    let promptTemplate = (!rawSavedPrompt || isLegacyDefault)
        ? DEFAULT_SUMMARIZATION_PROMPT
        : rawSavedPrompt;

    // Ensure custom prompts also instruct Markdown, keywords extraction, and unresolved issues marking
    if (!promptTemplate.includes("检索关键词")) {
        promptTemplate += `\n\n补充输出要求：请使用 Markdown 格式输出；如有未兑现的约定、待办或未解决的问题，请单独在「### 未解决问题」小节用 \`- [ ]\` 标记列出（无则写「无」）；末尾必须附上「**检索关键词**：关键词1、关键词2...」供向量模型读取。`;
    }

    const summaryPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText);

    // Call LLM for summarization — pass sufficient max_tokens so reasoning models don't truncate mid-output,
    // and retry once if a transient network/rate-limit error occurs.
    let result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: summaryPrompt }],
        { temperature: 0.3, max_tokens: 4096, label: `记忆总结·${characterName}` },
    );
    if (!result.content && !result.wasTruncated) {
        await new Promise(r => setTimeout(r, 1200));
        result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: summaryPrompt }],
            { temperature: 0.3, max_tokens: 4096, label: `记忆总结重试·${characterName}` },
        );
    }

    if (!result.content) {
        return { success: false, error: result.error || "LLM 返回了空内容" };
    }

    if (result.wasTruncated && result.content.trim().length < 40) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限" };
    }

    const summary = result.content.trim();
    const { keywords, unresolvedIssues } = extractMemoryStructuredMeta(summary);

    // Generate embedding for the summary (prioritize extracted keywords + summary for higher vector recall accuracy)
    let embedding: number[] | undefined;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const embeddingInput = keywords.length > 0
                ? `关键词：${keywords.join("、")}\n${summary}`
                : summary;
            const emb = await generateEmbedding(embeddingInput, embeddingApiConfig);
            if (emb) embedding = emb;
        } catch { /* ignore */ }
    }

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));

    // Save as long-term memory
    const now = new Date().toISOString();
    const longTermEntry: MemoryEntry = {
        id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: dominantSource as MemoryEntry["sourceApp"],
        type: "long_term",
        content: summary,
        embedding,
        importance: 0.8,
        createdAt: now,
        updatedAt: now,
        metadata: {
            summarizedEvents: allEntries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
            ...(keywords.length > 0 ? { keywords } : {}),
            ...(unresolvedIssues.length > 0 ? { unresolvedIssues, hasUnresolved: true } : {}),
        },
    };
    await saveMemoryEntry(longTermEntry);

    // Update last summarized timestamp + reset counter
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    // Enforce long-term limit
    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, characterName);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → 1 long-term memory`);
    return { success: true };
}
