// lib/memory-embedding.ts
// Embedding generation + vector/keyword search for memory retrieval.

import type { ApiConfig } from "./settings-types";
import type { MemoryEntry, MemorySearchResult } from "./memory-types";
import { determineBaseUrl, buildRequestHeaders } from "./api-helpers";

// ── Provider → Embedding Model Mapping ──

export function getEmbeddingModelForProvider(provider: string): string | null {
    switch (provider) {
        case "OpenAI": return "text-embedding-3-small";
        case "SiliconFlow": return "BAAI/bge-large-zh-v1.5";
        case "TogetherAI": return "BAAI/bge-large-en-v1.5";
        case "Zhipu": return "embedding-3";
        case "Google":
        case "Gemini": return "text-embedding-004";
        case "Aliyun":
        case "DashScope": return "text-embedding-v3";
        case "Jina": return "jina-embeddings-v3";
        case "Voyage": return "voyage-3";
        default: return null;
    }
}

/** 常见向量模型命名特征（embedding-3 / text-embedding-* / bge-* / m3e / gte / jina / voyage / conan 等） */
const EMBEDDING_MODEL_NAME_RE = /embed|bge-|m3e|text2vec|\be5\b|\bgte\b|voyage-|conan-|jina-clip|acge_/i;

export function isEmbeddingModelName(model: string | undefined): boolean {
    return Boolean(model && EMBEDDING_MODEL_NAME_RE.test(model));
}

/** 解析该配置应使用的向量模型：默认模型名看起来像向量模型就直接用
 *  （自定义服务商、以及智谱 embedding-3 等新模型因此可配），否则回退
 *  按服务商的内置映射（老用户绑普通对话配置的行为不变）。 */
export function resolveEmbeddingModel(apiConfig: Pick<ApiConfig, "provider" | "defaultModel">): string | null {
    const model = apiConfig.defaultModel?.trim();
    if (model && isEmbeddingModelName(model)) return model;
    return getEmbeddingModelForProvider(apiConfig.provider);
}

// ── Query Cleaning & LRU Embedding Cache ──

const EMBEDDING_CACHE_MAX = 48;
const queryEmbeddingCache = new Map<string, number[]>();
let lastObservedEmbeddingDim = 0;

/** 获取最近一次成功生成的向量维度（用于 UI 检测旧记忆向量是否因换模型而维度失配） */
export function getLastObservedEmbeddingDim(): number {
    return lastObservedEmbeddingDim;
}

/**
 * 清洗用于检索的上下文 Query：
 * 去除时间戳、冗余角色名前缀、システム符号与空行，截取末尾高信息密度片段（≤ 480 字），
 * 避免长对话噪音稀释核心语义向量。
 */
export function cleanQueryForEmbedding(rawQuery: string): string {
    const cleaned = rawQuery
        .replace(/\[\d{4}-\d{2}-\d{2}[^\]]*\]/g, "")
        .replace(/^\s*(?:用户|User|Assistant|System|旁白|[^：:\n]{1,12})[：:]\s*/gm, "")
        .replace(/[*#`~>|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) return rawQuery.trim().slice(-400);
    return cleaned.length > 480 ? cleaned.slice(-480) : cleaned;
}

function getCachedEmbedding(cacheKey: string): number[] | null {
    const hit = queryEmbeddingCache.get(cacheKey);
    if (!hit) return null;
    // Refresh LRU order
    queryEmbeddingCache.delete(cacheKey);
    queryEmbeddingCache.set(cacheKey, hit);
    return hit;
}

function setCachedEmbedding(cacheKey: string, vec: number[]): void {
    if (queryEmbeddingCache.has(cacheKey)) {
        queryEmbeddingCache.delete(cacheKey);
    } else if (queryEmbeddingCache.size >= EMBEDDING_CACHE_MAX) {
        const oldestKey = queryEmbeddingCache.keys().next().value;
        if (oldestKey !== undefined) queryEmbeddingCache.delete(oldestKey);
    }
    queryEmbeddingCache.set(cacheKey, vec);
    if (vec.length > 0) lastObservedEmbeddingDim = vec.length;
}

// ── Embedding API ──

export async function generateEmbedding(
    text: string,
    apiConfig: ApiConfig,
    options: { throwOnError?: boolean; useCache?: boolean; isQuery?: boolean } = {}
): Promise<number[] | null> {
    const fail = (message: string): null => {
        if (options.throwOnError) throw new Error(message);
        console.warn("[MemoryEmbedding]", message);
        return null;
    };

    const embeddingModel = resolveEmbeddingModel(apiConfig);
    if (!embeddingModel) return fail("该配置无可用向量模型（默认模型名不像向量模型，服务商也无内置映射）");
    if (!apiConfig.apiKey) return fail("缺少 API Key");

    const baseUrl = determineBaseUrl(apiConfig);
    if (!baseUrl) return fail("缺少 Base URL");

    const normalizedInput = options.isQuery ? cleanQueryForEmbedding(text) : text.trim();
    if (!normalizedInput) return null;

    const cacheKey = `${baseUrl}|${embeddingModel}|${normalizedInput}`;
    if (options.useCache !== false) {
        const cached = getCachedEmbedding(cacheKey);
        if (cached) return cached;
    }

    const url = baseUrl.endsWith("/embeddings")
        ? baseUrl
        : `${baseUrl.replace(/\/$/, "")}/embeddings`;

    const headers = buildRequestHeaders(apiConfig, baseUrl);

    try {
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: embeddingModel,
                input: normalizedInput,
            }),
        });
        if (!res.ok) {
            return fail(`API 错误 ${res.status}: ${await res.text()}`);
        }
        const data = await res.json();
        const embedding = data?.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) {
            return fail("接口未返回向量数据");
        }
        setCachedEmbedding(cacheKey, embedding);
        return embedding;
    } catch (err) {
        if (options.throwOnError) throw err;
        console.warn("[MemoryEmbedding] fetch error:", err);
        return null;
    }
}

/**
 * 批量生成向量（Batch Embedding API）：
 * 一次请求最多发送 batchSize（默认 12）条文本，若服务端不支持数组输入则自动平滑回退到逐条请求。
 */
export async function generateEmbeddingsBatch(
    texts: string[],
    apiConfig: ApiConfig,
    options: { batchSize?: number } = {}
): Promise<Array<number[] | null>> {
    if (texts.length === 0) return [];
    const embeddingModel = resolveEmbeddingModel(apiConfig);
    const baseUrl = determineBaseUrl(apiConfig);
    if (!embeddingModel || !apiConfig.apiKey || !baseUrl) {
        return texts.map(() => null);
    }

    const batchSize = Math.max(1, Math.min(20, options.batchSize ?? 12));
    const results: Array<number[] | null> = new Array(texts.length).fill(null);
    const url = baseUrl.endsWith("/embeddings")
        ? baseUrl
        : `${baseUrl.replace(/\/$/, "")}/embeddings`;
    const headers = buildRequestHeaders(apiConfig, baseUrl);

    for (let start = 0; start < texts.length; start += batchSize) {
        const slice = texts.slice(start, start + batchSize).map(t => t.trim());
        const uncachedIndices: number[] = [];
        const uncachedInputs: string[] = [];

        for (let i = 0; i < slice.length; i++) {
            const input = slice[i];
            if (!input) continue;
            const cacheKey = `${baseUrl}|${embeddingModel}|${input}`;
            const cached = getCachedEmbedding(cacheKey);
            if (cached) {
                results[start + i] = cached;
            } else {
                uncachedIndices.push(start + i);
                uncachedInputs.push(input);
            }
        }

        if (uncachedInputs.length === 0) continue;

        let batchSucceeded = false;
        if (uncachedInputs.length > 1) {
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        model: embeddingModel,
                        input: uncachedInputs,
                    }),
                });
                if (res.ok) {
                    const data = await res.json();
                    if (Array.isArray(data?.data) && data.data.length === uncachedInputs.length) {
                        for (let j = 0; j < data.data.length; j++) {
                            const item = data.data[j];
                            const idx = typeof item?.index === "number" && item.index >= 0 && item.index < uncachedInputs.length
                                ? item.index
                                : j;
                            const emb = item?.embedding;
                            if (Array.isArray(emb) && emb.length > 0) {
                                const targetGlobalIdx = uncachedIndices[idx];
                                results[targetGlobalIdx] = emb;
                                setCachedEmbedding(`${baseUrl}|${embeddingModel}|${uncachedInputs[idx]}`, emb);
                            }
                        }
                        batchSucceeded = true;
                    }
                }
            } catch {
                // Fallback to single requests below
            }
        }

        if (!batchSucceeded) {
            for (let j = 0; j < uncachedInputs.length; j++) {
                const emb = await generateEmbedding(uncachedInputs[j], apiConfig);
                results[uncachedIndices[j]] = emb;
            }
        }
    }

    return results;
}

// ── Vector math & Hybrid Scoring ──

export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * 计算单条记忆相对于查询的混合相关性得分（供 Prompt 召回与记忆库 UI 检索测试共用）：
 * - 向量余弦相似度（若未向量化或维度不符，自动回退到关键词/分词重合度，绝不因维度冲突误判为 0 分）
 * - 结构化检索关键词命中加分（最高 +0.25）
 * - 重要性加权（+ imp * 0.12）
 * - 访问频次微调（最高 +0.05）
 * - 温和时间衰减（高重要性 >= 0.85 不衰减，日常记忆随天数轻微衰减，最多 -0.06）
 */
export function computeHybridMemoryScore(
    entry: MemoryEntry,
    query: string,
    queryEmbedding: number[] | null,
    explicitKeywords?: string[]
): number {
    const lowerCtx = query.toLowerCase();
    const hasEmb = Array.isArray(entry.embedding) && entry.embedding.length > 0;
    const dimMatches = Boolean(queryEmbedding && hasEmb && entry.embedding!.length === queryEmbedding.length);

    let baseScore = 0.22;
    if (dimMatches && queryEmbedding) {
        baseScore = Math.max(0, cosineSimilarity(queryEmbedding, entry.embedding!));
    } else {
        // Fallback when entry has no vector OR vector dimension mismatches current model
        const overlap = keywordOverlapRatio(query, entry.content);
        baseScore = 0.22 + overlap * 0.48;
    }

    const kws = explicitKeywords && explicitKeywords.length > 0
        ? explicitKeywords
        : (Array.isArray(entry.metadata?.keywords)
            ? (entry.metadata.keywords as unknown[]).map(String)
            : []);

    if (kws.length > 0 && lowerCtx.length > 0) {
        let hits = 0;
        for (const kw of kws) {
            const norm = kw.trim().toLowerCase();
            if (!norm) continue;
            if (
                (norm.length >= 2 && lowerCtx.includes(norm)) ||
                (lowerCtx.length >= 2 && norm.includes(lowerCtx)) ||
                lowerCtx === norm
            ) {
                hits++;
            }
        }
        if (hits > 0) {
            baseScore += Math.min(0.25, hits * 0.07);
        }
    }

    const imp = Number.isFinite(entry.importance) ? entry.importance : 0.8;
    baseScore += imp * 0.12;

    const accessCnt = typeof entry.accessCount === "number"
        ? entry.accessCount
        : (typeof entry.metadata?.accessCount === "number" ? Number(entry.metadata.accessCount) : 0);
    if (accessCnt > 0) {
        baseScore += Math.min(0.05, Math.log10(accessCnt + 1) * 0.025);
    }

    // Gentle recency / time decay for non-milestone memories
    if (imp < 0.85) {
        const rawDate = typeof entry.metadata?.eventDate === "string" && entry.metadata.eventDate.trim()
            ? entry.metadata.eventDate.trim()
            : entry.createdAt;
        const ts = new Date(rawDate).getTime();
        if (!isNaN(ts)) {
            const ageDays = Math.max(0, (Date.now() - ts) / 86400000);
            if (ageDays > 7) {
                const decay = Math.min(0.06, Math.log10(ageDays / 7 + 1) * 0.03);
                baseScore = Math.max(0, baseScore - decay);
            }
        }
    }

    return Number(baseScore.toFixed(4));
}

// ── Search ──

export async function searchMemories(
    query: string,
    memories: MemoryEntry[],
    apiConfig: ApiConfig | null,
    topK: number
): Promise<MemorySearchResult[]> {
    if (memories.length === 0) return [];
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
        return memories.slice(0, topK).map(entry => ({ entry, score: entry.importance ?? 0.8 }));
    }

    // Try hybrid vector search if the config resolves to an embedding model
    if (apiConfig && resolveEmbeddingModel(apiConfig)) {
        const queryEmbedding = await generateEmbedding(trimmedQuery, apiConfig, { isQuery: true });
        if (queryEmbedding) {
            const scored = memories.map(entry => ({
                entry,
                score: computeHybridMemoryScore(entry, trimmedQuery, queryEmbedding),
            }));
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, topK);
        }
    }

    // Fallback: keyword search
    return keywordSearch(trimmedQuery, memories, topK);
}

// ── Keyword fallback ──

export function keywordSearch(
    query: string,
    memories: MemoryEntry[],
    topK: number
): MemorySearchResult[] {
    const queryTokens = extractTokens(query);
    if (queryTokens.length === 0) {
        // Return most recent
        return memories.slice(-topK).reverse().map(entry => ({ entry, score: 0.5 }));
    }

    const scored: MemorySearchResult[] = memories.map(entry => {
        const kws = Array.isArray(entry.metadata?.keywords)
            ? (entry.metadata.keywords as unknown[]).map(String).join(" ")
            : "";
        const entryTokens = extractTokens(kws ? `${kws} ${entry.content}` : entry.content);
        if (entryTokens.length === 0) return { entry, score: 0 };
        let matched = 0;
        for (const qt of queryTokens) {
            if (entryTokens.some(et => et === qt || (et.length >= 2 && qt.length >= 2 && (et.includes(qt) || qt.includes(et))))) {
                matched++;
            }
        }
        return { entry, score: matched / queryTokens.length };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(r => r.score > 0);
}

/** Extract tokens: split on punctuation/whitespace, plus CJK bigrams */
function extractTokens(text: string): string[] {
    const lower = text.toLowerCase();
    // Latin words
    const words = lower.match(/[a-zA-Z0-9]+/g) || [];
    // CJK bigrams
    const cjk = lower.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]+/g) || [];
    const bigrams: string[] = [];
    for (const seg of cjk) {
        for (let i = 0; i < seg.length - 1; i++) {
            bigrams.push(seg.slice(i, i + 2));
        }
        if (seg.length === 1) bigrams.push(seg);
    }
    return [...words, ...bigrams];
}

/** Check keyword overlap ratio between two texts */
export function keywordOverlapRatio(textA: string, textB: string): number {
    const tokensA = new Set(extractTokens(textA));
    const tokensB = new Set(extractTokens(textB));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokensA) {
        if (tokensB.has(t)) overlap++;
    }
    return overlap / Math.min(tokensA.size, tokensB.size);
}
