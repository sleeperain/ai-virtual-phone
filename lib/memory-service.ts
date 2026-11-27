// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, incrementMemoryAccessCounts } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, computeHybridMemoryScore } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { extractMemoryStructuredMeta } from "./memory-summarizer";
import { sortMemoriesByDateThenImportance } from "./memory-injector";
import { effectiveImportance, isEntrySuperseded } from "./memory-revision";
// 事件盒相关：仅保留召回过滤（filterRecallableEntries），盒串联/盒上下文注入已移除
import { filterRecallableEntries } from "./memory-event-boxes";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. When vectorRecallEnabled is true and (totalTokens > budget OR entries.length > topK):
 *      compute hybrid relevance score (vector cosine + keyword match + importance + recency + access count),
 *      filter by vectorMinScore (milestone memories with importance >= 0.9 are exempted),
 *      take up to topK and fill until longTermTokenBudget.
 *   2. Fallback when vector recall is disabled or unavailable:
 *      if over budget, prioritize by importance & date until budget.
 *   3. Final output ordering: ordered by eventDate first (newest date at the top),
 *      then by importance descending within the same day.
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    // 事件盒中「已归档」的原始条目由盒子的「先前事件总结」代表参与召回；
    // 盒内尚未总结的「新事件」以及盒外记忆正常参与召回。
    const longTermEntries = filterRecallableEntries(await loadMemoryEntriesByType(characterId, "long_term"));
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;
    const topK = Math.max(3, Math.min(100, config.vectorRecallTopK ?? 15));
    const minScore = Math.max(0.05, Math.min(0.85, config.vectorMinScore ?? 0.38));

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    let selected: MemoryEntry[] = [];
    const shouldRunVectorFilter = config.vectorRecallEnabled && (totalTokens > budget || longTermEntries.length > topK);

    if (!shouldRunVectorFilter && totalTokens <= budget) {
        selected = longTermEntries;
    } else {
        const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
        const canUseEmbedding = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig));

        if (config.vectorRecallEnabled) {
            const queryEmbedding = canUseEmbedding && embeddingApiConfig
                ? await generateEmbedding(currentContext, embeddingApiConfig, { isQuery: true })
                : null;

            const scored = longTermEntries.map(entry => {
                const kws = Array.isArray(entry.metadata?.keywords) && (entry.metadata.keywords as unknown[]).length > 0
                    ? (entry.metadata.keywords as unknown[]).map(String)
                    : extractMemoryStructuredMeta(entry.content).keywords;
                const score = computeHybridMemoryScore(entry, currentContext, queryEmbedding, kws);
                return { entry, score };
            });

            scored.sort((a, b) => b.score - a.score);

            // Filter by minimum hybrid score (milestone memories with importance >= 0.9 are always kept)
            const qualified = scored.filter(item => {
                // 里程碑豁免也按「修订后的有效重要性」算：
                // 否则一条已被改写的旧记忆能靠原始高分绕过阈值，重新冒到新版本前面。
                const imp = effectiveImportance(item.entry, 0.8);
                return item.score >= minScore || imp >= 0.9;
            });

            // Ensure at least top 3 highest-scoring entries are kept even if all scored low
            const baseCandidates = (qualified.length >= 3 ? qualified : scored.slice(0, Math.min(5, scored.length)))
                .slice(0, topK)
                .map(s => s.entry);

            // 事件盒脉络串联已移除：召回只按相关度/预算独立挑选，不再为了「同一件事前后呼应」
            // 把同盒的其它条目强行绑进上下文——那会让不相干的内容被一起塞进 Prompt。
            selected = fillByBudget(baseCandidates, budget);
        }

        if (selected.length === 0) {
            const sorted = sortMemoriesByDateThenImportance(longTermEntries, 0.8);
            selected = fillByBudget(sorted, budget);
        }
    }

    if (selected.length > 0) {
        void incrementMemoryAccessCounts(selected.map(e => e.id));
    }

    // Order injected memories by eventDate first, then importance descending within the same day
    return sortMemoriesByDateThenImportance(selected, 0.8);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = filterRecallableEntries(await loadMemoryEntriesByType(characterId, "core"));
    if (coreEntries.length === 0) return [];

    // 增量演进的核心记忆总结只保留最新一轮参与对话注入（已移除角色反思功能，旧存量反思条目不再注入）：
    const autoCoreSummaries = coreEntries
        .filter(e => e.metadata?.origin === "core_summary")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latestCoreSummaryId = autoCoreSummaries[0]?.id;

    const candidateEntries = coreEntries.filter(e => {
        if (e.metadata?.origin === "character_reflection") {
            return false;
        }
        if (e.metadata?.origin === "core_summary") {
            return e.id === latestCoreSummaryId;
        }
        return !isEntrySuperseded(e);
    });

    // Selection stage: active & effective importance first so budget never drops critical milestones
    const prioritySorted = [...candidateEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const impA = effectiveImportance(a, 0.95);
        const impB = effectiveImportance(b, 0.95);
        if (Math.abs(impB - impA) > 0.001) return impB - impA;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    const selected = fillByBudget(prioritySorted, config.coreMemoryTokenBudget);
    if (selected.length > 0) {
        void incrementMemoryAccessCounts(selected.map(e => e.id));
    }
    // Injection stage: order by date first, then importance descending
    return sortMemoriesByDateThenImportance(selected, 0.95);
}

/** Pick entries in order until token budget is exhausted (skips oversized single entry to fit smaller ones). */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) continue;
        result.push(entry);
        used += tokens;
    }
    return result;
}
