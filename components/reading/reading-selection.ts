/** 选区端点在某个行元素内的文本偏移（相对该行起点）。 */
export function textOffsetWithin(lineEl: HTMLElement, container: Node, offset: number): number {
    let total = 0;
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
        if (node === container) return total + offset;
        total += (node.textContent || "").length;
        node = walker.nextNode();
    }
    return total;
}

/** 划选落在正文里的一段：某章某段的字符区间（含头不含尾）。 */
export type ReadingSelectionSegment = {
    chapterIndex: number;
    paragraphIndex: number;
    start: number;
    end: number;
};

/** 一个段落内部拆出来的单句区间（含头不含尾，包含句末标点与紧随的后引号/右括号）。 */
export type ReadingSentenceSpan = {
    start: number;
    end: number;
    text: string;
};

const SENTENCE_TERMINATORS = new Set(["。", "？", "！", "?", "!", "…", "；", ";"]);
const SENTENCE_CLOSERS = new Set(["”", "’", "」", "』", "》", "）", "】", "\"", "'", ")", "]"]);

/** 按「。」「？」「！」等句末标点把段落拆成单句区间，保留原段落字符偏移与换行不变。 */
export function splitParagraphIntoSentences(paragraph: string): ReadingSentenceSpan[] {
    if (!paragraph) return [];
    const spans: ReadingSentenceSpan[] = [];
    const n = paragraph.length;
    let sentenceStart = 0;
    let i = 0;

    while (i < n) {
        // 跳过行内图标占位符 \uFFFCico:N\uFFFC，避免把其中的字符当普通标点
        if (paragraph[i] === "\uFFFC" && paragraph.slice(i, i + 5) === "\uFFFCico:") {
            const closeIdx = paragraph.indexOf("\uFFFC", i + 5);
            if (closeIdx !== -1) {
                i = closeIdx + 1;
                continue;
            }
        }
        const ch = paragraph[i];
        if (ch === "\n") {
            if (i > sentenceStart) {
                spans.push({
                    start: sentenceStart,
                    end: i,
                    text: paragraph.slice(sentenceStart, i),
                });
            }
            sentenceStart = i + 1;
            i += 1;
            continue;
        }
        if (SENTENCE_TERMINATORS.has(ch)) {
            let end = i + 1;
            // 连续句末标点（如 ？！、……、！！）合并到同一句末尾
            while (end < n && SENTENCE_TERMINATORS.has(paragraph[end])) {
                end += 1;
            }
            // 紧跟在句末标点后面的后引号/右括号一并归入本句
            while (end < n && SENTENCE_CLOSERS.has(paragraph[end])) {
                end += 1;
            }
            spans.push({
                start: sentenceStart,
                end,
                text: paragraph.slice(sentenceStart, end),
            });
            sentenceStart = end;
            i = end;
            continue;
        }
        i += 1;
    }

    if (sentenceStart < n) {
        spans.push({
            start: sentenceStart,
            end: n,
            text: paragraph.slice(sentenceStart, n),
        });
    }

    return spans.filter((s) => s.text.trim().length > 0);
}

/** 给定段落与段落内字符偏移，找到所属的单句区间。 */
export function findSentenceAtOffset(paragraph: string, offset: number): ReadingSentenceSpan | null {
    const spans = splitParagraphIntoSentences(paragraph);
    if (spans.length === 0) return null;
    const clamped = Math.max(0, Math.min(paragraph.length - 1, offset));
    for (const span of spans) {
        if (clamped >= span.start && clamped < span.end) return span;
    }
    return spans[spans.length - 1] || null;
}

/** 把一次划选拆成「每段一条」。
 *
 *  跨段落划选以前是直接拒绝的（锚点落不到单一段落上）。其实不必：存储和渲染
 *  继续按段落切开，只是同一次划选的这几条共用一个 groupId，删除/批注/分享时
 *  再当成一条处理。这样渲染那边一行代码都不用改。
 *
 *  一个段落在翻页模式下可能被拆成多行元素，所以这里先按行算区间，再按
 *  (章, 段) 合并；行内偏移要加上该行的 data-charstart 才是段落内的偏移。 */
export function collectSelectionSegments(range: Range, root: ParentNode): ReadingSelectionSegment[] {
    const byParagraph = new Map<string, ReadingSelectionSegment>();
    for (const line of Array.from(root.querySelectorAll<HTMLElement>("[data-paragraph]"))) {
        if (!range.intersectsNode(line)) continue;
        const chapterIndex = Number(line.dataset.chapter);
        const paragraphIndex = Number(line.dataset.paragraph);
        if (!Number.isFinite(chapterIndex) || !Number.isFinite(paragraphIndex)) continue;

        const lineStart = Number(line.dataset.charstart || 0);
        const lineLength = (line.textContent || "").length;
        // 选区端点不在这一行里，说明这一行是被整行圈进来的
        const from = line.contains(range.startContainer)
            ? textOffsetWithin(line, range.startContainer, range.startOffset)
            : 0;
        const to = line.contains(range.endContainer)
            ? textOffsetWithin(line, range.endContainer, range.endOffset)
            : lineLength;
        // 端点正好停在某行开头时，这一行会被算成「相交但长度为 0」，跳过
        if (to <= from) continue;

        const key = `${chapterIndex}:${paragraphIndex}`;
        const existing = byParagraph.get(key);
        if (existing) {
            existing.start = Math.min(existing.start, lineStart + from);
            existing.end = Math.max(existing.end, lineStart + to);
        } else {
            byParagraph.set(key, {
                chapterIndex,
                paragraphIndex,
                start: lineStart + from,
                end: lineStart + to,
            });
        }
    }
    return [...byParagraph.values()].sort(
        (a, b) => a.chapterIndex - b.chapterIndex || a.paragraphIndex - b.paragraphIndex,
    );
}
