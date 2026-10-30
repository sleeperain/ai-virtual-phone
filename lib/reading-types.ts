// lib/reading-types.ts — Type definitions for the Reading (阅读) feature.

export type Book = {
    id: string;
    title: string;
    author?: string;
    format: "txt" | "epub" | "pdf" | "mobi";
    totalChapters: number;
    createdAt: string;
    /** 置顶时间。有值就排在书架最前面，多本置顶按置顶时间倒序。 */
    pinnedAt?: string;
};

export type BookChapter = {
    id: string;
    bookId: string;
    index: number;
    title: string;
    paragraphs: string[];
    /** EPUB 自带目录里的层级：0 = 顶层，1 = 它的子条目。没有目录的书不给。 */
    tocLevel?: number;
    /** PDF only: synthetic page chunk start (1-based) */
    pageStart?: number;
    /** PDF only: synthetic page chunk end (1-based) */
    pageEnd?: number;
    /** PDF only: page number (1-based) for each paragraph */
    paragraphPages?: number[];
    /** PDF only: vertical position (0-1 ratio) within page for each paragraph */
    paragraphYPositions?: number[];
};

export type ReadingProgress = {
    bookId: string;
    chapterIndex: number;
    scrollPosition: number;
    companionCharacterId?: string;
    progressFraction?: number;
    progressCurrent?: number;
    progressTotal?: number;
    progressScope?: "book" | "chapter";
    /** 保存进度时的阅读模式；滚动模式下 scrollPosition 存的是章节内滚动比例(0-1) */
    readingMode?: "page" | "scroll";
    lastReadAt: string;
};

/** 一个书签 = 书 + 章 + 章节内位置。位置统一用 0-1 的比例存，
 *  翻页模式和滚动模式都能还原；PDF 另外记页码。 */
export type ReadingBookmark = {
    id: string;
    bookId: string;
    chapterIndex: number;
    /** 存一份加书签时的章节名，章节重建后列表也还认得出 */
    chapterTitle: string;
    fraction: number;
    pdfPage?: number;
    /** 当前位置开头的一小段正文，列表里靠它认出是哪儿 */
    excerpt: string;
    createdAt: string;
};

export type ReadingAnnotation = {
    id: string;
    bookId: string;
    chapterIndex: number;
    paragraphIndex: number;
    characterId: string;
    characterName: string;
    content: string;
    createdAt: string;
    /** 批注作者。缺省即角色批注——存量数据没有这个字段，读出来仍按角色处理。
     *  用户批注沿用 characterId/characterName 记录「这条是写给哪个角色看的」。 */
    authorType?: "user" | "character";
    /** 批注锚定的原文片段。用户批注是自己选中的那段；角色批注是模型在
     *  [批注:段落序号|原文片段] 里给出的片段。缺省即整段批注（老数据都是这样）。 */
    quote?: string;
    /** quote 在所属段落中的字符区间（含头不含尾）。定位不到时不写。 */
    quoteStart?: number;
    quoteEnd?: number;
    /** 区分「段评」（显示在段尾💬弹窗里，支持嵌套回复）与「句子批注」（显示在被高亮/划线句子末字所在行下方）。
     *  缺省时：若无 quoteEnd 或非句子批注，亦可兼容展示。 */
    annotationKind?: "note" | "comment";
    /** 段评回复的目标评论 ID（顶层段评不填；回复某条段评或回复时填被回复的评论 ID） */
    parentId?: string;
    /** 被回复人的昵称（方便展示与构建上下文） */
    replyToName?: string;
};

/** 荧光笔 / 划线。按「段落内字符区间」锚定；纯阅读标记，不进记忆。 */
export type ReadingMarkStyle = "highlight" | "underline";

export type ReadingMark = {
    id: string;
    bookId: string;
    chapterIndex: number;
    paragraphIndex: number;
    /** 段落内的字符区间（含头不含尾） */
    start: number;
    end: number;
    text: string;
    style: ReadingMarkStyle;
    createdAt: string;
    /** 谁划的。角色也能在正文上划重点；老数据没有这个字段，都是用户自己划的。 */
    authorType?: "user" | "character";
    /** 角色划的线记下是哪个角色，列表里好显示 */
    characterId?: string;
    characterName?: string;
    /** 跨段划选时，同一次划出来的若干段共用一个 groupId：存储和渲染仍按段落切开
     *  （渲染就不用改），但删除、批注、分享都按整组处理。老数据没有这个字段，
     *  自己就是一组。 */
    groupId?: string;
};

export function isUserAnnotation(annotation: Pick<ReadingAnnotation, "authorType">): boolean {
    return annotation.authorType === "user";
}

/** 判定「批注 / 段评」只需要这三个字段，所以接受任意结构相同的对象
 *  （批注本体、只读了部分字段的投影都行）。
 *  记忆日志（ReadingAnnotationMemo）结构不同，它有 paragraphIndex、没有 quoteEnd，
 *  判据见 lib/reading-memory.ts 的 resolveReadingMemoKind。 */
export type ReadingAnnotationKindSource = {
    annotationKind?: "note" | "comment";
    quoteEnd?: number;
    parentId?: string;
};

/** 「批注」还是「段评」——判据只在这里定义一次，别处一律调这里。
 *  - 批注（note）：写在某句话旁边，锚定了 quote / quoteStart / quoteEnd；
 *  - 段评（comment）：挂在段落下面的一串评论与互相回复，靠 paragraphIndex 定位，可以有 parentId。
 *
 *  老数据没有 annotationKind，按当年的显示语义推断：有 parentId、或者没有 quoteEnd 的，
 *  当年就是显示在段末 💬 里的，算段评。新写入的记录一律显式带 kind。 */
export function resolveReadingAnnotationKind(
    annotation: ReadingAnnotationKindSource,
): "note" | "comment" {
    if (annotation.annotationKind === "note" || annotation.annotationKind === "comment") {
        return annotation.annotationKind;
    }
    if (annotation.parentId) return "comment";
    if (typeof annotation.quoteEnd === "number" && annotation.quoteEnd > 0) return "note";
    return "comment";
}

/** 这条是批注（写在句子旁边） */
export function isNoteAnnotation(annotation: ReadingAnnotationKindSource): boolean {
    return resolveReadingAnnotationKind(annotation) === "note";
}

/** 这条是段评（段落下面那串评论里的一条） */
export function isCommentAnnotation(annotation: ReadingAnnotationKindSource): boolean {
    return resolveReadingAnnotationKind(annotation) === "comment";
}

/** 旧名字，等价于 isNoteAnnotation。句子批注和整段批注都是「批注」，不是段评。 */
export const isSentenceNoteAnnotation = isNoteAnnotation;

/** 从库里读出来时把 kind 补齐：下游不必再各自推断，新老数据行为一致。
 *  不写回数据库（值由 resolveReadingAnnotationKind 推出来，与推断结果相同，写回没有意义）。 */
export function normalizeReadingAnnotation<T extends ReadingAnnotation>(annotation: T): T {
    const kind = resolveReadingAnnotationKind(annotation);
    if (annotation.annotationKind === kind) return annotation;
    return { ...annotation, annotationKind: kind };
}
