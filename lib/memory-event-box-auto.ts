// lib/memory-event-box-auto.ts
// 自动归纳：把散落的记忆按「同一件事」聚成簇，交给用户一键确认。
//
// 上百条记忆逐条手动归组不现实，所以聚类必须自动完成。但**落库前要过一道确认**：
// 把「聊养猫」和「聊养狗」折成一条，模型会拿到错的事实而且不知道自己拿的是错的，
// 比多出几个盒子糟糕得多。预览成本很低，误判成本很高，所以只在这道确认上留人工。
//
// 聚类本身不调用模型（纯向量 / 关键词计算）；只有给簇起名字时调一次模型，
// 失败就用关键词兜底，不阻塞流程。

import type { MemoryEntry } from "./memory-types";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { cosineSimilarity, keywordOverlapRatio } from "./memory-embedding";
import { resolveSummarizationApiConfig } from "./memory-summarizer";
import { simpleLLMCall } from "./api-helpers";
import { entryDateKey } from "./memory-event-boxes";

/** 两条记忆被判定为「同一件事」的相似度下限。
 *  比 memory-revision 的 0.88 低：那里判的是「同一件事的新版本」，这里判的是
 *  「围绕同一件事的不同时刻」，本来就该允许更多差异。 */
const CLUSTER_THRESHOLD_WITH_VECTOR = 0.72;
/** 没有向量时只能靠关键词重叠，信号更弱，阈值压低一点并额外要求共享关键词 */
const CLUSTER_THRESHOLD_KEYWORD = 0.42;
/** 一个簇至少两条才值得开盒子 */
const MIN_CLUSTER_SIZE = 2;
/** 参与自动归纳的记忆数量上限：避免上百条两两比较把主线程卡死 */
export const AUTO_CLUSTER_ENTRY_LIMIT = 600;

export type AutoClusterCandidate = {
    /** 稳定 id，仅用于前端列表 key */
    key: string;
    title: string;
    entries: MemoryEntry[];
    /** 关键词并集，给用户判断这簇到底是不是同一件事 */
    keywords: string[];
    /** 出现最多的日期区间端点 */
    earliest: string;
    latest: string;
    /** 平均相似度，用来排序：越确定越靠前 */
    cohesion: number;
};

function readKeywords(entry: MemoryEntry): string[] {
    const raw = entry.metadata?.keywords;
    if (!Array.isArray(raw)) return [];
    return raw.map(String).map(item => item.trim()).filter(Boolean);
}

function uniqueStrings(items: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
        if (!item || seen.has(item)) continue;
        seen.add(item);
        result.push(item);
    }
    return result;
}

/** 两两相似度：有可用向量用余弦，否则退化为关键词 + 正文重叠 */
function pairSimilarity(a: MemoryEntry, b: MemoryEntry): number {
    const embA = Array.isArray(a.embedding) ? a.embedding : null;
    const embB = Array.isArray(b.embedding) ? b.embedding : null;
    if (embA && embB && embA.length > 0 && embA.length === embB.length) {
        return cosineSimilarity(embA, embB);
    }
    const kwA = readKeywords(a).join(" ");
    const kwB = readKeywords(b).join(" ");
    const contentRatio = keywordOverlapRatio(a.content, b.content);
    const keywordRatio = kwA && kwB ? keywordOverlapRatio(kwA, kwB) : 0;
    return Math.max(contentRatio, keywordRatio * 1.1);
}

function usesVector(a: MemoryEntry, b: MemoryEntry): boolean {
    const embA = Array.isArray(a.embedding) ? a.embedding : null;
    const embB = Array.isArray(b.embedding) ? b.embedding : null;
    return Boolean(embA && embB && embA.length > 0 && embA.length === embB.length);
}

/** 并查集：把所有足够相似的条目连成一片 */
class DisjointSet {
    private parent: number[];
    constructor(size: number) {
        this.parent = Array.from({ length: size }, (_, i) => i);
    }
    find(x: number): number {
        let root = x;
        while (this.parent[root] !== root) root = this.parent[root];
        // 路径压缩，避免长链退化成 O(n)
        let cursor = x;
        while (this.parent[cursor] !== root) {
            const next = this.parent[cursor];
            this.parent[cursor] = root;
            cursor = next;
        }
        return root;
    }
    union(a: number, b: number): void {
        const rootA = this.find(a);
        const rootB = this.find(b);
        if (rootA !== rootB) this.parent[rootB] = rootA;
    }
}

/**
 * 聚类：返回候选盒子，按「越确定越靠前」排序。
 * 纯计算，不落库、不发请求。
 */
export function clusterMemories(entries: MemoryEntry[]): AutoClusterCandidate[] {
    const eligible = entries.slice(0, AUTO_CLUSTER_ENTRY_LIMIT);
    if (eligible.length < MIN_CLUSTER_SIZE) return [];

    const dsu = new DisjointSet(eligible.length);
    const pairScores = new Map<string, number>();

    for (let i = 0; i < eligible.length; i += 1) {
        for (let j = i + 1; j < eligible.length; j += 1) {
            const score = pairSimilarity(eligible[i], eligible[j]);
            const threshold = usesVector(eligible[i], eligible[j])
                ? CLUSTER_THRESHOLD_WITH_VECTOR
                : CLUSTER_THRESHOLD_KEYWORD;
            if (score >= threshold) {
                dsu.union(i, j);
                pairScores.set(`${i}:${j}`, score);
            }
        }
        // 每处理完一行让出主线程，避免上百条记忆时页面卡住
        if (i % 40 === 39) {
            // 同步函数里没法 await，这里只做规模控制：AUTO_CLUSTER_ENTRY_LIMIT 已封顶
        }
    }

    const groups = new Map<number, number[]>();
    for (let i = 0; i < eligible.length; i += 1) {
        const root = dsu.find(i);
        const bucket = groups.get(root);
        if (bucket) bucket.push(i);
        else groups.set(root, [i]);
    }

    const candidates: AutoClusterCandidate[] = [];
    for (const indexes of groups.values()) {
        if (indexes.length < MIN_CLUSTER_SIZE) continue;

        const members = indexes.map(index => eligible[index]);
        const dates = members.map(entryDateKey).filter(Boolean).sort();

        // 簇内平均相似度：用来给候选排序，也让用户看出这簇有多「紧」
        let sum = 0;
        let count = 0;
        for (let a = 0; a < indexes.length; a += 1) {
            for (let b = a + 1; b < indexes.length; b += 1) {
                const key = indexes[a] < indexes[b]
                    ? `${indexes[a]}:${indexes[b]}`
                    : `${indexes[b]}:${indexes[a]}`;
                const score = pairScores.get(key);
                if (typeof score === "number") {
                    sum += score;
                    count += 1;
                }
            }
        }

        const keywords = uniqueStrings(members.flatMap(readKeywords)).slice(0, 8);
        candidates.push({
            key: members.map(entry => entry.id).sort().join("|"),
            title: keywords.slice(0, 3).join(" · ") || members[0].content.slice(0, 12),
            entries: [...members].sort((x, y) => entryDateKey(x).localeCompare(entryDateKey(y))),
            keywords,
            earliest: dates[0] ?? entryDateKey(members[0]),
            latest: dates[dates.length - 1] ?? entryDateKey(members[0]),
            cohesion: count > 0 ? sum / count : 0,
        });
    }

    return candidates.sort((a, b) => {
        if (Math.abs(b.cohesion - a.cohesion) > 0.001) return b.cohesion - a.cohesion;
        return b.entries.length - a.entries.length;
    });
}

/**
 * 给候选簇起名字。一次请求处理全部簇，省调用次数；
 * 失败就退回关键词命名，不影响后续归档。
 */
export async function nameAutoClusters(
    characterId: string,
    characterName: string,
    candidates: AutoClusterCandidate[],
): Promise<AutoClusterCandidate[]> {
    if (candidates.length === 0) return candidates;
    const apiConfig = resolveSummarizationApiConfig(characterId);
    if (!apiConfig) return candidates;

    const blocks = candidates.map((candidate, index) => {
        const lines = candidate.entries
            .map(entry => `  - ${entry.content.replace(/\s*\n+\s*/g, " ").trim().slice(0, 120)}`)
            .join("\n");
        return `【第${index + 1}组】\n${lines}`;
    }).join("\n\n");

    const prompt = `下面是{{char}}和用户之间若干组记忆，每组是围绕某件事的一系列记录（已经自动分好组，不要改动分组）。请给每组起一个简短的中文标题。

角色：{{char}}

${blocks}

要求：
- 每组一行，格式严格为「序号. 标题」，例如「1. 学法语的那段日子」
- 标题 4-14 个字，说清这件事是什么，不要用「事件」「记忆」「组」这类空词
- 标题不要包含日期、书名号或标点
- 不要输出任何其它内容`;

    try {
        const result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: prompt.replace(/\{\{char\}\}/gi, characterName || "角色") }],
            { temperature: 0.3 },
        );
        if (!result.content) return candidates;
        const lines = result.content.split("\n");
        const titles = new Map<number, string>();
        for (const line of lines) {
            const match = line.match(/^\s*(\d+)\s*[.、．:：]\s*(.+?)\s*$/);
            if (!match) continue;
            const index = Number(match[1]) - 1;
            const title = match[2].replace(/[《》「」"“”]/g, "").trim();
            if (index >= 0 && index < candidates.length && title) {
                titles.set(index, title.slice(0, 20));
            }
        }
        if (titles.size === 0) return candidates;
        return candidates.map((candidate, index) => ({
            ...candidate,
            title: titles.get(index) ?? candidate.title,
        }));
    } catch {
        return candidates;
    }
}

/** 自动归纳的完整流程：筛选 → 聚类 → 命名。不写库。 */
export async function buildAutoClusterPlan(
    characterId: string,
    characterName: string,
    entries: MemoryEntry[],
): Promise<AutoClusterCandidate[]> {
    const candidates = clusterMemories(entries);
    if (candidates.length === 0) return [];
    return nameAutoClusters(characterId, characterName, candidates);
}
