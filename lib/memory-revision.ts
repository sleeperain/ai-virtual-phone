// lib/memory-revision.ts
// 记忆修订（supersede）：新记忆改写旧记忆时，旧记忆不让位消失，而是把「被改掉的部分」标出来，
// 界面上划掉变灰、检索时降权；新记忆作为独立条目正常存在。
//
// 纯函数模块，不碰存储，方便被总结管道、手动录入与记忆库 UI 共用。

import type { MemoryEntry } from "./memory-types";

/** 旧记忆正文里被改掉的字符区间（左闭右开，单位是字符下标） */
export type RevisionSpan = { start: number; end: number };

/** 旧记忆被修订后剩下的检索权重系数：0.35 表示重要性与召回分都打三折 */
export const DEFAULT_REVISION_WEIGHT = 0.35;

/** 判定「这条是同一件事的新版本」的相似度下限（低于此值视为互不相关的新记忆） */
export const REVISION_MATCH_THRESHOLD = 0.88;

/** 相似度高于此值时视为「几乎一字不差」，仍旧按重复合并处理，不产生划线记录 */
export const REVISION_EXACT_THRESHOLD = 0.97;

/** metadata 里用到的键 ── 集中定义，避免各处拼字符串写错 */
export const REVISION_META_KEYS = {
    /** 取代它的那条新记忆 id */
    by: "supersededBy",
    /** 被修订的时间（ISO） */
    at: "supersededAt",
    /** 旧正文上被改掉的字符区间 */
    spans: "supersededSpans",
    /** 被改掉的字符占比（0-1），用于显示与统计 */
    ratio: "supersededRatio",
    /** 检索权重系数，缺省 1 */
    weight: "revisionWeight",
    /** 修订时的相似度，便于回溯判定是否合理 */
    similarity: "revisionSimilarity",
} as const;

// ── 读取侧 ───────────────────────────────────────────

/** 这条记忆是否已被后来的记忆修订过 */
export function isEntrySuperseded(entry: MemoryEntry): boolean {
    return typeof entry.metadata?.[REVISION_META_KEYS.by] === "string";
}

/** 旧正文上被改掉的区间；老数据或未修订时返回空数组 */
export function readSupersededSpans(entry: MemoryEntry): RevisionSpan[] {
    const raw = entry.metadata?.[REVISION_META_KEYS.spans];
    if (!Array.isArray(raw)) return [];
    const spans: RevisionSpan[] = [];
    for (const item of raw) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const start = Number(item[0]);
        const end = Number(item[1]);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0) {
            spans.push({ start, end });
        }
    }
    return spans.sort((a, b) => a.start - b.start);
}

/** 检索权重系数：未被修订为 1，被修订则按记录值（缺省 0.35） */
export function getRevisionWeight(entry: MemoryEntry): number {
    const raw = entry.metadata?.[REVISION_META_KEYS.weight];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value) || value <= 0) return isEntrySuperseded(entry) ? DEFAULT_REVISION_WEIGHT : 1;
    return Math.max(0.05, Math.min(1, value));
}

/** 参与排序 / 阈值判断的有效重要性：原始重要性 × 修订权重 */
export function effectiveImportance(entry: MemoryEntry, fallback = 0.8): number {
    const base = Number.isFinite(entry.importance) ? entry.importance : fallback;
    return Math.max(0, Math.min(1, base * getRevisionWeight(entry)));
}

// ── 文本切分与 diff ──────────────────────────────────

type TextSegment = { text: string; start: number; end: number };

/** 按句末/句中标点切成小段，保留标点本身，便于「整句被改掉」时按句划掉 */
function splitIntoSegments(text: string): TextSegment[] {
    const segments: TextSegment[] = [];
    // 在标点之后断句；换行也当作断点
    const re = /[^。！？；!?;\n，,、：:]+[。！？；!?;\n，,、：:]*/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const piece = match[0];
        if (!piece) continue;
        segments.push({ text: piece, start: match.index, end: match.index + piece.length });
        if (piece.length === 0) re.lastIndex += 1;
    }
    // 兜底：正则在纯标点串上可能一段都没切出来
    if (segments.length === 0 && text.length > 0) {
        segments.push({ text, start: 0, end: text.length });
    }
    return segments;
}

/** 归一化后再比：去掉空白与纯标点差异，避免「，」换「。」被判成改动 */
function normalizeForMatch(text: string): string {
    return text.replace(/\s+/g, "").replace(/[。！？；!?;，,、：:."'“”‘’「」（）()\-—…]/g, "");
}

/**
 * 最长公共子序列匹配：返回 a、b 各自哪些项按顺序对上了。
 * 两侧都要：旧句靠 a 判断「这段是否原样保留」，新句靠 b 判断「这句是否已被占用」。
 * 文本都在几十到一两百个 token 的量级，二维表足够快。
 */
function lcsMatchBoth(a: string[], b: string[]): { a: boolean[]; b: boolean[] } {
    const n = a.length;
    const m = b.length;
    const matchedA = new Array<boolean>(n).fill(false);
    const matchedB = new Array<boolean>(m).fill(false);
    if (n === 0 || m === 0) return { a: matchedA, b: matchedB };

    // 保险：畸形超长输入直接退化成「按出现次数配平」，别把主线程卡住
    if (n * m > 400000) {
        const pool = new Map<string, number[]>();
        for (let j = 0; j < m; j++) {
            const bucket = pool.get(b[j]);
            if (bucket) bucket.push(j);
            else pool.set(b[j], [j]);
        }
        for (let i = 0; i < n; i++) {
            const bucket = pool.get(a[i]);
            if (bucket && bucket.length > 0) {
                const j = bucket.shift()!;
                matchedA[i] = true;
                matchedB[j] = true;
            }
        }
        return { a: matchedA, b: matchedB };
    }

    const table: Uint16Array[] = [];
    for (let i = 0; i <= n; i++) table.push(new Uint16Array(m + 1));
    for (let i = 1; i <= n; i++) {
        const row = table[i];
        const prev = table[i - 1];
        for (let j = 1; j <= m; j++) {
            row[j] = a[i - 1] === b[j - 1]
                ? prev[j - 1] + 1
                : (prev[j] >= row[j - 1] ? prev[j] : row[j - 1]);
        }
    }

    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
        if (a[i - 1] === b[j - 1]) {
            matchedA[i - 1] = true;
            matchedB[j - 1] = true;
            i -= 1;
            j -= 1;
        } else if (table[i - 1][j] >= table[i][j - 1]) {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    return { a: matchedA, b: matchedB };
}

/** 两段文本的字符级相似度（0-1），用公共子序列算 Dice 系数 */
function textSimilarity(a: string, b: string): number {
    const left = a.split("");
    const right = b.split("");
    if (left.length === 0 || right.length === 0) return 0;
    const matched = lcsMatchBoth(left, right).a;
    const common = matched.reduce((sum, hit) => sum + (hit ? 1 : 0), 0);
    return (2 * common) / (left.length + right.length);
}

/** 把相邻或重叠的区间合并，避免渲染出一堆碎片 */
function mergeSpans(spans: RevisionSpan[]): RevisionSpan[] {
    if (spans.length === 0) return [];
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    const merged: RevisionSpan[] = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
        const last = merged[merged.length - 1];
        const current = sorted[i];
        // 中间只隔一两个字符（多半是标点）也并进去，视觉上更连贯
        if (current.start <= last.end + 1) {
            last.end = Math.max(last.end, current.end);
        } else {
            merged.push({ ...current });
        }
    }
    return merged;
}

/**
 * 算出旧正文里「被新版本改掉」的字符区间。
 * 策略：先按标点分句做一次 LCS，整句被换掉的直接划掉；
 * 对「长得像但有出入」的句子再做字符级 diff，只划掉真正变化的字词。
 */
export function computeSupersededSpans(
    oldText: string,
    newText: string,
): { spans: RevisionSpan[]; removedRatio: number; similarity: number } {
    const oldSegments = splitIntoSegments(oldText);
    const newSegments = splitIntoSegments(newText);
    const oldKeys = oldSegments.map(segment => normalizeForMatch(segment.text));
    const newKeys = newSegments.map(segment => normalizeForMatch(segment.text));
    const segMatch = lcsMatchBoth(oldKeys, newKeys);

    // 整体相似度按字符算：用来判断「够不够格算修订」而不是「碰巧同一天」
    const similarity = textSimilarity(normalizeForMatch(oldText), normalizeForMatch(newText));

    const spans: RevisionSpan[] = [];
    // 被旧句原样占用的新句，不再作为「改写字句」的候选
    const takenNewKeys = new Set(newKeys.filter((key, index) => segMatch.b[index] && key.length > 0));

    for (let i = 0; i < oldSegments.length; i++) {
        const segment = oldSegments[i];
        const key = oldKeys[i];
        if (key.length === 0) continue; // 纯标点段不参与
        if (segMatch.a[i]) continue;    // 原样保留

        // 找一个最像的新句子：相似度够高就把差异精确定位到字
        let bestKey = "";
        let bestScore = 0;
        for (const candidate of newKeys) {
            if (candidate.length === 0) continue;
            if (takenNewKeys.has(candidate)) continue; // 已被别的旧句原样占用了
            const score = textSimilarity(key, candidate);
            if (score > bestScore && score >= 0.45) {
                bestScore = score;
                bestKey = candidate;
            }
        }

        if (!bestKey) {
            spans.push({ start: segment.start, end: segment.end });
            continue;
        }

        // 字符级 diff：只划掉旧句里被删改的字，保留还一致的部分
        const oldChars = segment.text.split("");
        const newChars = bestKey.split("");
        const charFlags = lcsMatchBoth(
            oldChars.map(ch => normalizeForMatch(ch)),
            newChars,
        ).a;
        let runStart = -1;
        for (let c = 0; c <= oldChars.length; c++) {
            const unmatched = c < oldChars.length && !charFlags[c] && normalizeForMatch(oldChars[c]) !== "";
            if (unmatched && runStart < 0) runStart = c;
            if (!unmatched && runStart >= 0) {
                spans.push({ start: segment.start + runStart, end: segment.start + c });
                runStart = -1;
            }
        }
    }

    const mergedSpans = mergeSpans(spans.filter(span => span.end > span.start && span.start < oldText.length));
    const cleanedOldLength = normalizeForMatch(oldText).length || 1;
    const removedChars = mergedSpans.reduce(
        (sum, span) => sum + normalizeForMatch(oldText.slice(span.start, span.end)).length,
        0,
    );
    return {
        spans: mergedSpans,
        removedRatio: Math.max(0, Math.min(1, removedChars / cleanedOldLength)),
        similarity,
    };
}

/**
 * 生成旧记忆要写入的修订元数据。
 * 只碰这四个键，其余 metadata（日期、关键词、向量维度等）原样保留。
 */
export function buildSupersededMetadata(
    oldEntry: MemoryEntry,
    newEntryId: string,
    revision: { spans: RevisionSpan[]; removedRatio: number; similarity: number },
    weight: number = DEFAULT_REVISION_WEIGHT,
    /** 区间基准文本的长度：默认按原始 content，实际传「显示用正文」的长度 */
    baseLength?: number,
): Record<string, unknown> {
    const previous = oldEntry.metadata ?? {};
    const limit = typeof baseLength === "number" && baseLength > 0 ? baseLength : oldEntry.content.length;
    // 已经是「被修订」状态时，把新的划掉区间并到旧的上面：
    // 一条记忆可能被后来的新版本连续改写多次，不该只剩最后一刀的痕迹。
    const previousSpans = readSupersededSpans(oldEntry);
    const combined = mergeSpans([
        ...previousSpans,
        ...revision.spans,
    ].filter(span => span.end > span.start && span.start < limit));

    return {
        ...previous,
        [REVISION_META_KEYS.by]: newEntryId,
        [REVISION_META_KEYS.at]: new Date().toISOString(),
        [REVISION_META_KEYS.spans]: combined.map(span => [span.start, span.end]),
        [REVISION_META_KEYS.ratio]: Math.max(
            revision.removedRatio,
            Number(previous[REVISION_META_KEYS.ratio] ?? 0) || 0,
        ),
        [REVISION_META_KEYS.weight]: weight,
        [REVISION_META_KEYS.similarity]: Number(revision.similarity.toFixed(4)),
    };
}

/**
 * 卡片折叠时会把正文截断（180 字 + "..."），划掉区间要跟着裁到可见范围内，
 * 否则删除线会画到看不见的地方、或者把结尾那几个点也划上。
 */
export function clipSupersededSpans(visibleText: string, spans: RevisionSpan[]): RevisionSpan[] {
    const limit = visibleText.length;
    const clipped: RevisionSpan[] = [];
    for (const span of spans) {
        const start = Math.max(0, Math.min(limit, span.start));
        const end = Math.max(start, Math.min(limit, span.end));
        if (end > start) clipped.push({ start, end });
    }
    return clipped;
}

/**
 * 把正文按「是否被划掉」切成片段，供界面渲染：
 * [{ text, superseded: false }, { text, superseded: true }, ...]
 */
export function sliceSupersededText(
    text: string,
    spans: RevisionSpan[],
): Array<{ text: string; superseded: boolean }> {
    if (spans.length === 0) return [{ text, superseded: false }];
    const pieces: Array<{ text: string; superseded: boolean }> = [];
    let cursor = 0;
    for (const span of spans) {
        const start = Math.max(cursor, Math.min(text.length, span.start));
        const end = Math.max(start, Math.min(text.length, span.end));
        if (start > cursor) pieces.push({ text: text.slice(cursor, start), superseded: false });
        if (end > start) pieces.push({ text: text.slice(start, end), superseded: true });
        cursor = end;
    }
    if (cursor < text.length) pieces.push({ text: text.slice(cursor), superseded: false });
    return pieces.filter(piece => piece.text.length > 0);
}
