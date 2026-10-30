"use client";

import { hydrateKvDb, kvGet, kvSet, registerKvMigration } from "./kv-db";

// 批注写进记忆区要在 loadNativeTimeline 里同步读到，而批注本体存在 Dexie（异步）。
// 所以写批注时顺手往这个 kv 日志里追一条，时间线直接读日志。
// 荧光笔/划线不写进来——那是纯阅读标记，不该占记忆。
const MEMO_KEY = "ai_phone_reading_annotation_memos_v1";
registerKvMigration(MEMO_KEY);

/** 只保留最近这么多条：记忆区本身还会再截断，日志没必要无限长。 */
const MEMO_LIMIT = 300;

export type ReadingAnnotationMemo = {
    /** 批注条目与 ReadingAnnotation.id 一致，删批注时按它删日志 */
    id: string;
    /** 缺省即批注——老数据没有这个字段，读出来仍按批注处理 */
    kind?: "annotation" | "summary";
    /** 区间总结用：人读的范围描述，例如「第3章—第5章」 */
    rangeLabel?: string;
    characterId: string;
    /** 老数据没有这个字段，按书筛选时退回书名比对 */
    bookId?: string;
    bookTitle: string;
    chapterIndex: number;
    chapterTitle: string;
    authorType: "user" | "character";
    /** 批注锚定的原文片段，没有就是整段批注 */
    quote?: string;
    content: string;
    createdAt: string;
    /** 这条是「批注」还是「段评」。
     *  段评是挂在段落底下的一串评论（含互相回复），批注是写在某句话旁边的。
     *  两者混着记，记忆区和提示词就会把段评说成批注、把回复顺序讲串。 */
    annotationKind?: "note" | "comment";
    /** 段评挂在第几段（0 起）。批注靠 quote 定位，不需要这个。 */
    paragraphIndex?: number;
};

export function loadReadingAnnotationMemos(): ReadingAnnotationMemo[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(MEMO_KEY) || "[]") as unknown;
        return Array.isArray(parsed) ? parsed as ReadingAnnotationMemo[] : [];
    } catch {
        return [];
    }
}

function persist(list: ReadingAnnotationMemo[]): void {
    kvSet(MEMO_KEY, JSON.stringify(list.slice(-MEMO_LIMIT)));
}

export function appendReadingAnnotationMemos(memos: ReadingAnnotationMemo[]): void {
    if (typeof window === "undefined" || memos.length === 0) return;
    const existing = loadReadingAnnotationMemos();
    const seen = new Set(existing.map(memo => memo.id));
    const added = memos.filter(memo => !seen.has(memo.id));
    if (added.length === 0) return;
    persist([...existing, ...added]);
}

/** 某本书里已存的区间摘要，最新的在前 */
export function loadReadingSummaryMemos(bookId: string, bookTitle: string): ReadingAnnotationMemo[] {
    return loadReadingAnnotationMemos()
        .filter(memo => memo.kind === "summary")
        .filter(memo => (memo.bookId ? memo.bookId === bookId : memo.bookTitle === bookTitle))
        .reverse();
}

/** 批注被手动改过之后，记忆区那条要跟着变——否则角色记得的还是旧话。 */
export function updateReadingAnnotationMemoContent(annotationId: string, content: string): void {
    if (typeof window === "undefined") return;
    const existing = loadReadingAnnotationMemos();
    let changed = false;
    const next = existing.map(memo => {
        if (memo.id !== annotationId || memo.content === content) return memo;
        changed = true;
        return { ...memo, content };
    });
    if (changed) persist(next);
}

export function deleteReadingAnnotationMemo(annotationId: string): void {
    if (typeof window === "undefined") return;
    const existing = loadReadingAnnotationMemos();
    const next = existing.filter(memo => memo.id !== annotationId);
    if (next.length !== existing.length) persist(next);
}

/** 删除一本书时，把这本书在记忆区里的批注、段评、区间总结一并清掉（同时兼容无 bookId 的老数据与待删批注 ID 集合）。 */
export function deleteReadingAnnotationMemosByBook(
    bookId: string,
    bookTitle?: string,
    annotationIds?: Iterable<string>,
): void {
    if (typeof window === "undefined") return;
    const existing = loadReadingAnnotationMemos();
    if (existing.length === 0) return;
    const idSet = annotationIds ? new Set(annotationIds) : null;
    const normalizedTitle = bookTitle?.trim();
    const next = existing.filter((memo) => {
        if (idSet && idSet.has(memo.id)) return false;
        if (memo.bookId) return memo.bookId !== bookId;
        if (normalizedTitle && memo.bookTitle.trim() === normalizedTitle) return false;
        return true;
    });
    if (next.length !== existing.length) persist(next);
}

/** 这条日志是「批注」还是「段评」。
 *  memo 和批注本体字段不完全一样：memo 不存 quoteEnd，但段评一定会记 paragraphIndex
 *  （批注靠 quote 定位，不记段落号）。所以这里按 memo 自己的字段判：
 *  写了 annotationKind 就听它的，老日志退回看有没有 paragraphIndex。 */
export function resolveReadingMemoKind(memo: ReadingAnnotationMemo): "note" | "comment" {
    if (memo.annotationKind === "note" || memo.annotationKind === "comment") return memo.annotationKind;
    return typeof memo.paragraphIndex === "number" ? "comment" : "note";
}

/** 老日志的「批注 / 段评」类型固化下来，跑一次就够。
 *  不跑也不会认错（判据是现算的），但固化了以后规则再变、或者有别的工具读这份日志，都不会走样。 */
const MEMO_KIND_MIGRATED_KEY = "ai_phone_reading_memo_kind_migrated_v1";
registerKvMigration(MEMO_KIND_MIGRATED_KEY);

export async function migrateReadingMemoKinds(): Promise<number> {
    if (typeof window === "undefined") return 0;
    // 日志是从 kv 的内存缓存里读的，缓存还没 hydrate 好时会读成空数组——
    // 那就会「迁移了 0 条」却把迁移标记写下去，真实日志反而被永久跳过。所以先等它。
    await hydrateKvDb().catch(() => undefined);
    if (kvGet(MEMO_KIND_MIGRATED_KEY) === "1") return 0;
    let changed = 0;
    try {
        const next = loadReadingAnnotationMemos().map((memo) => {
            // 区间总结不是批注也不是段评，不动
            if (memo.kind === "summary") return memo;
            const kind = resolveReadingMemoKind(memo);
            if (memo.annotationKind === kind) return memo;
            changed += 1;
            return { ...memo, annotationKind: kind };
        });
        if (changed > 0) persist(next);
        // 写成功才记下「已迁移」：中途失败的话下次启动还会再试
        kvSet(MEMO_KIND_MIGRATED_KEY, "1");
    } catch (error) {
        console.warn("[Reading] 批注日志类型迁移失败，下次启动再试：", error);
        return 0;
    }
    return changed;
}

/** 记忆区里的标签，交给 formatStoredPromptEventContent 补时间戳。
 *  段评和批注是两回事：段评挂在整段下面（还能互相回复），批注写在某句话旁边。 */
export function readingMemoLabel(memo: ReadingAnnotationMemo): string {
    if (memo.kind === "summary") return "共读摘要";
    return resolveReadingMemoKind(memo) === "comment" ? "段评" : "批注";
}

/** 记忆区里那一行，带 [标签] 头交给 formatStoredPromptEventContent 补时间。
 *  角色名和用户名一律由调用方传进来，不在这里写死。 */
export function formatReadingAnnotationMemo(
    memo: ReadingAnnotationMemo,
    params: { userName: string; characterName: string },
): string {
    const chapter = memo.chapterTitle.trim() || `第${memo.chapterIndex + 1}章`;
    if (memo.kind === "summary") {
        const range = memo.rangeLabel?.trim() || chapter;
        // 带上「谁读了什么」：否则记忆区里突然冒出一段小说情节，读起来莫名其妙
        return `[共读摘要]${params.userName}和${params.characterName}读了《${memo.bookTitle}》${range}：${memo.content}`;
    }
    const who = memo.authorType === "user" ? params.userName : params.characterName;
    if (resolveReadingMemoKind(memo) === "comment") {
        // 段评说的是「这一段下面的评论」，不是某句话的批注，
        // 所以不能写成「在「…」旁写道」
        const where = typeof memo.paragraphIndex === "number" ? `第${memo.paragraphIndex + 1}段` : "";
        return `[段评]《${memo.bookTitle}》${chapter}${where} ${who}评论：${memo.content}`;
    }
    const where = memo.quote ? `在「${memo.quote}」旁` : "";
    return `[批注]《${memo.bookTitle}》${chapter} ${who}${where}写道：${memo.content}`;
}
