// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, incrementMemoryAccessCounts } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, computeHybridMemoryScore } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { extractMemoryStructuredMeta } from "./memory-summarizer";
import { sortMemoriesByDateThenImportance } from "./memory-injector";
import { effectiveImportance } from "./memory-revision";
import { filterRecallableEntries, getEntryBoxId, isEntryBoxDigest } from "./memory-event-boxes";

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

            // 事件盒脉络串联：当某条被召回的记忆属于某个事件盒时，自动把该事件盒的「先前事件总结」
            // 以及盒内尚未归档的关联新事件紧随其后排入候选，保证同一件事的前因后果在预算内一起注入
            const chainedCandidates = chainEventBoxEntries(baseCandidates, longTermEntries);
            selected = fillByBudget(chainedCandidates, budget);
        }

        if (selected.length === 0) {
            const sorted = chainEventBoxEntries(sortMemoriesByDateThenImportance(longTermEntries, 0.8), longTermEntries);
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
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    // Selection stage: active & high importance first so budget never drops critical milestones
    const prioritySorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const impA = Number.isFinite(a.importance) ? a.importance : 0.95;
        const impB = Number.isFinite(b.importance) ? b.importance : 0.95;
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

/**
 * 事件盒脉络串联：
 * 当候选列表中命中了某个事件盒里的条目（无论是盒子的阶段性总结还是盒内尚未总结的新事件），
 * 自动把同一个事件盒的「先前事件总结」与盒内关联新事件排在该条目之后，确保同一件事的前因后果不断裂。
 */
function chainEventBoxEntries(candidates: MemoryEntry[], allRecallable: MemoryEntry[]): MemoryEntry[] {
    const byBox = new Map<string, MemoryEntry[]>();
    for (const entry of allRecallable) {
        const boxId = getEntryBoxId(entry) || (isEntryBoxDigest(entry) ? String(entry.metadata?.eventBoxDigestOf ?? "") : "");
        if (!boxId) continue;
        const list = byBox.get(boxId) ?? [];
        list.push(entry);
        byBox.set(boxId, list);
    }

    const result: MemoryEntry[] = [];
    const seen = new Set<string>();

    for (const entry of candidates) {
        if (seen.has(entry.id)) continue;
        result.push(entry);
        seen.add(entry.id);

        const boxId = getEntryBoxId(entry) || (isEntryBoxDigest(entry) ? String(entry.metadata?.eventBoxDigestOf ?? "") : "");
        if (!boxId) continue;
        const siblings = byBox.get(boxId);
        if (!siblings || siblings.length <= 1) continue;

        // 优先补充该事件盒的阶段性总结（背景前情），再按时间从近到远补充同盒的未归档新进展（最多附带 3 条以防挤爆预算）
        const sortedSiblings = [...siblings]
            .filter(s => !seen.has(s.id))
            .sort((a, b) => {
                const aDigest = isEntryBoxDigest(a) ? 0 : 1;
                const bDigest = isEntryBoxDigest(b) ? 0 : 1;
                if (aDigest !== bDigest) return aDigest - bDigest;
                return b.createdAt.localeCompare(a.createdAt);
            })
            .slice(0, 3);

        for (const sib of sortedSiblings) {
            result.push(sib);
            seen.add(sib.id);
        }
    }

    return result;
}

/** Pick entries in order until token budget is exhausted (skips oversized single entry to fit smaller chained ones). */
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
