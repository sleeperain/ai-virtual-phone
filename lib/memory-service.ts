// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, incrementMemoryAccessCounts } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { extractMemoryStructuredMeta } from "./memory-summarizer";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → select all
 *   2. Over budget + embedding API configured → hybrid score (vector cosine + keyword match + importance + access count), fill until budget
 *   3. Over budget + no embedding → sort by importance descending then newest first, fill until budget
 * Selected memories are ordered by importance descending (highest weight at the top) and their accessCount is incremented.
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    let selected: MemoryEntry[] = [];

    if (totalTokens <= budget) {
        selected = longTermEntries;
    } else {
        const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
        if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
            const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
            if (queryEmbedding) {
                const lowerCtx = currentContext.toLowerCase();
                const scored = longTermEntries.map(entry => {
                    const hasEmb = Array.isArray(entry.embedding) && entry.embedding.length > 0;
                    let score = hasEmb ? cosineSimilarity(queryEmbedding, entry.embedding!) : 0.25;
                    const kws = Array.isArray(entry.metadata?.keywords) && (entry.metadata.keywords as unknown[]).length > 0
                        ? (entry.metadata.keywords as unknown[]).map(String)
                        : extractMemoryStructuredMeta(entry.content).keywords;
                    if (kws.length > 0) {
                        let hits = 0;
                        for (const kw of kws) {
                            const norm = kw.trim().toLowerCase();
                            if (norm && lowerCtx.includes(norm)) hits++;
                        }
                        if (hits > 0) {
                            score += Math.min(0.25, hits * 0.06);
                        }
                    }
                    const imp = Number.isFinite(entry.importance) ? entry.importance : 0.8;
                    score += imp * 0.12;
                    const accessCnt = typeof entry.accessCount === "number"
                        ? entry.accessCount
                        : (typeof entry.metadata?.accessCount === "number" ? Number(entry.metadata.accessCount) : 0);
                    if (accessCnt > 0) {
                        score += Math.min(0.05, Math.log10(accessCnt + 1) * 0.025);
                    }
                    return { entry, score };
                });
                scored.sort((a, b) => b.score - a.score);
                selected = fillByBudget(scored.map(s => s.entry), budget);
            }
        }

        if (selected.length === 0) {
            const sorted = [...longTermEntries].sort((a, b) => {
                const impA = Number.isFinite(a.importance) ? a.importance : 0.8;
                const impB = Number.isFinite(b.importance) ? b.importance : 0.8;
                if (Math.abs(impB - impA) > 0.001) return impB - impA;
                return b.createdAt.localeCompare(a.createdAt);
            });
            selected = fillByBudget(sorted, budget);
        }
    }

    if (selected.length > 0) {
        void incrementMemoryAccessCounts(selected.map(e => e.id));
    }

    // Order injected memories by importance descending (highest weight at the top), then newest first
    return [...selected].sort((a, b) => {
        const impA = Number.isFinite(a.importance) ? a.importance : 0.8;
        const impB = Number.isFinite(b.importance) ? b.importance : 0.8;
        if (Math.abs(impB - impA) > 0.001) return impB - impA;
        return b.createdAt.localeCompare(a.createdAt);
    });
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
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

    const selected = fillByBudget(sorted, config.coreMemoryTokenBudget);
    if (selected.length > 0) {
        void incrementMemoryAccessCounts(selected.map(e => e.id));
    }
    return selected;
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
