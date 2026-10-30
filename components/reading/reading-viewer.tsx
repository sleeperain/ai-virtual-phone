"use client";

import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, type CSSProperties } from "react";
import { ChevronDown, ChevronRight, Highlighter, Languages, Menu, Minus, MoreHorizontal, PenLine, Rocket, SendHorizontal, Trash2, X, ZoomIn } from "lucide-react";
import {
    loadChapters,
    loadProgress,
    saveProgress,
    loadAnnotations,
    saveAnnotations,
    saveAnnotation,
    deleteAnnotation,
    saveChapters,
    loadRawFileBlob,
    updateBook,
    loadReadingInteractionConfig,
    saveReadingInteractionConfig,
    loadBookmarks,
    saveBookmark,
    deleteBookmark,
    DEFAULT_READING_INTERACTION_CONFIG,
    ensureReadingDbAlive,
} from "@/lib/reading-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { loadReadingMarks, saveReadingMark, deleteReadingMark, readingMarkGroup, readingMarkGroupId } from "@/lib/reading-marks";
import {
    appendReadingAnnotationMemos,
    deleteReadingAnnotationMemo,
    loadReadingSummaryMemos,
    updateReadingAnnotationMemoContent,
    type ReadingAnnotationMemo,
} from "@/lib/reading-memory";
import { annotationExportFileName, buildAnnotationMarkdown } from "@/lib/reading-export";
import { downloadFile } from "@/lib/download-utils";
import { collectSelectionSegments, splitParagraphIntoSentences, textOffsetWithin, type ReadingSelectionSegment } from "./reading-selection";
import {
    isCommentAnnotation,
    isNoteAnnotation,
    isUserAnnotation,
    resolveReadingAnnotationKind,
    type ReadingBookmark,
    type ReadingMark,
    type ReadingMarkStyle,
} from "@/lib/reading-types";
import { generateAnnotationBatch, generateParagraphCommentReply, generateReadingChat, parseReadingDiscussResponse, summarizeReadingRange, type ReadingDiscussAction, type ReadingDiscussContext } from "@/lib/reading-engine";
import { READING_PROFILE_CHANGED_EVENT, loadReadingProfile, loadReadingProfileAvatar } from "@/lib/reading-profile";
import { loadChatMessages, pushChatMessage, deleteChatMessage, editChatMessage, loadChatContacts, createOrGetSession, isReadingDiscussMessage } from "@/lib/chat-storage";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ContentDialog } from "@/components/ui/modal";
import { Select, Toggle } from "@/components/ui/form";
import { PdfPageRenderer } from "./reading-pdf-viewer";
import { ReadingShareDialog } from "./reading-share-dialog";
import { decodeTxtArrayBuffer, parsePdfPageRange, PDF_PAGES_PER_CHAPTER, parseTxtContent, parseEpubFile, parseMobiFile } from "@/lib/reading-parser";
import type { Book, BookChapter, ReadingAnnotation, ReadingProgress } from "@/lib/reading-types";
import type { Character } from "@/lib/character-types";
import { splitBilingualText } from "@/lib/bilingual-text";
import {
    collectReadingInlineIconIndices,
    parseReadingImageMarker,
    readingImageAssetKey,
    splitTextByInlineIcons,
    stripReadingInlineIconMarkers,
    type ReadingImageRef,
} from "@/lib/reading-inline-image";
import { loadReadingAsset } from "@/lib/reading-appearance";

type TxtPageItem =
    | { kind: "line"; text: string; chapterIndex: number; paragraphIndex: number; indent?: boolean; segEnd?: boolean; charStart?: number; annotationCount?: number }
    | { kind: "gap"; chapterIndex: number; paragraphIndex: number }
    | { kind: "image"; image: ReadingImageRef; chapterIndex: number; paragraphIndex: number }
    | { kind: "annotation"; annotation: ReadingAnnotation; chapterIndex: number; paragraphIndex: number };

/** 菜单半宽，避免贴着某个点算出来的位置把菜单顶出屏幕 */
const MENU_HALF_WIDTH = 152;

/** 正文句子/已有标记的长按时长：和批注卡片、共读消息的长按保持一致 */
const SENTENCE_LONG_PRESS_MS = 500;

function clampMenuX(centerX: number, width: number): number {
    return Math.min(Math.max(centerX, MENU_HALF_WIDTH), Math.max(MENU_HALF_WIDTH, width - MENU_HALF_WIDTH));
}

// 「批注 / 段评」的判据统一在 lib/reading-types.ts：
//   批注（note）= 写在某句话旁边，锚定了 quote；
//   段评（comment）= 挂在段落下面的一串评论与回复。
// 这个组件里所有分栏、计数、提示词、记忆都只认那一个判据，不再各自推断。

function formatCommentTimestamp(iso: string): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate()
    ) {
        return hm;
    }
    const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;
    if (date.getFullYear() === now.getFullYear()) return md;
    return `${date.getFullYear()}-${md}`;
}

/** iOS 的 Copy / Look Up 条出现在选区上方还是下方，UIKit 没有公开规则，
 *  实测同一本书里两种都出现过，跟着选区放就一定有撞上的时候。
 *  但它永远「紧贴选区」，所以我们去离选区最远的那一端：
 *  选区在上半屏就把菜单钉在页脚上方，在下半屏就钉在页眉下方，两者不可能重合。 */
function selectionMenuStyle(placeAtTop: boolean, topOffset: number, footerHeight: number): React.CSSProperties {
    if (placeAtTop) return { top: `${topOffset}px`, left: "50%", transform: "translateX(-50%)" };
    return { bottom: `${footerHeight + 12}px`, left: "50%", transform: "translateX(-50%)" };
}

type ParagraphRef = {
    absoluteIndex: number;
    chapterIndex: number;
    paragraphIndex: number;
    text: string;
    pageNum?: number;
    yRatio?: number;
};

type AnnotationBatchRequest = {
    key: string;
    title: string;
    size: number;
    items: ParagraphRef[];
};

type AnnotationDialogMode = "manual" | "auto";
type AnnotationBatchMode = AnnotationDialogMode | "auto-current";

const DISCUSS_TARGET_CHARS = 1000;
const DISCUSS_MIN_CHARS = 700;
const DISCUSS_MAX_CHARS = 1600;
const DISCUSS_MAX_PARAGRAPHS = 16;
const MAX_MANUAL_PDF_PREFETCH_PAGES = 30;

/** 聊天悬浮球/悬浮条/悬浮窗的位置记忆键 */
const CHAT_FLOAT_POS_KEY = "reading-chat-float-pos-v1";
const CHAT_FLOAT_MARGIN = 12;

function toCanvasFont(style: CSSStyleDeclaration): string {
    return [
        style.fontStyle,
        style.fontVariant,
        style.fontWeight,
        style.fontSize,
        style.fontFamily,
    ].join(" ");
}

function formatParagraphRangeLabel(start: number, end: number): string {
    return start === end ? `第${start + 1}段` : `第${start + 1}-${end + 1}段`;
}

function getParagraphLength(text: string): number {
    return text.replace(/\s+/g, "").length || text.trim().length;
}

/** 静默重试：生成失败时按用户配置的次数重试，重试间隔逐渐加大，全部失败后抛出最后一次错误 */
async function withAnnotationRetry<T>(task: () => Promise<T>, retryCount: number): Promise<T> {
    const maxAttempts = Math.max(1, retryCount + 1);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await task();
        } catch (err) {
            lastError = err;
            if (attempt >= maxAttempts) break;
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(1200, 400 * attempt)));
        }
    }
    throw lastError;
}

function buildPdfChunkTitle(startPage: number, endPage: number): string {
    return `第${startPage}-${endPage}页`;
}

function buildParagraphRefsFromChapters(chapters: BookChapter[]): ParagraphRef[] {
    const refs: ParagraphRef[] = chapters.flatMap((chapter, currentChapterIndex) =>
        chapter.paragraphs.flatMap((text, paragraphIndex) => (
            // 插图占位不是正文，不该出现在给模型的段落里，也不该被批注
            parseReadingImageMarker(text) ? [] : [{
            absoluteIndex: 0,
            chapterIndex: currentChapterIndex,
            paragraphIndex,
            text: stripReadingInlineIconMarkers(text),
            pageNum: chapter.paragraphPages?.[paragraphIndex],
            yRatio: chapter.paragraphYPositions?.[paragraphIndex],
        }]
        )),
    );

    for (let i = 0; i < refs.length; i += 1) {
        refs[i].absoluteIndex = i;
    }

    return refs;
}

function trimTrailingGaps(items: TxtPageItem[]): TxtPageItem[] {
    let end = items.length;
    while (end > 0 && items[end - 1]?.kind === "gap") end -= 1;
    return items.slice(0, end);
}

/** 把一段文本切成「单字符或单个行内小图标标记」的原子序列，
 *  避免 wrapTextToLines 把 \uFFFCico:12\uFFFC 拆成两行，且算宽度时把整个标记按大约 1 个字宽计。 */
function tokenizeLineUnits(text: string): string[] {
    if (!text.includes("￼ico:")) return Array.from(text);
    const units: string[] = [];
    const parts = splitTextByInlineIcons(text);
    for (const part of parts) {
        if (part.type === "icon") {
            units.push(`￼ico:${part.index}￼`);
        } else {
            units.push(...Array.from(part.text));
        }
    }
    return units;
}

function measureLineWithIcons(text: string, ctx: CanvasRenderingContext2D): number {
    if (!text.includes("￼ico:")) return ctx.measureText(text).width;
    const replaced = text.replace(/￼ico:\d+￼/g, "注");
    return ctx.measureText(replaced).width;
}

function wrapTextToLines(text: string, maxWidth: number, ctx: CanvasRenderingContext2D, firstLineOffset = 0): string[] {
    if (!text) return [""];

    const lines: string[] = [];
    let current = "";
    let lineIndex = 0;

    for (const unit of tokenizeLineUnits(text)) {
        const candidate = current + unit;
        const lineLimit = lineIndex === 0 ? Math.max(1, maxWidth - firstLineOffset) : maxWidth;
        if (current && measureLineWithIcons(candidate, ctx) > lineLimit) {
            lines.push(current);
            current = unit;
            lineIndex += 1;
        } else {
            current = candidate;
        }
    }

    if (current) lines.push(current);
    return lines.length > 0 ? lines : [""];
}

function ReadingLoadingView({
    title,
    subtitle,
    compact = false,
    overlay = false,
}: {
    title: string;
    subtitle: string;
    compact?: boolean;
    overlay?: boolean;
}) {
    return (
        <div
            className={`reading-loading-view${compact ? " reading-loading-view--compact" : ""}${overlay ? " reading-loading-view--overlay" : ""}`}
            data-no-nav="true"
        >
            <div className="reading-loading-mark" aria-hidden="true">
                <span className="reading-loading-page reading-loading-page--back" />
                <span className="reading-loading-page reading-loading-page--middle" />
                <span className="reading-loading-page reading-loading-page--front" />
            </div>
            <div className="reading-loading-copy">
                <span className="reading-loading-title">
                    {title}
                    <span className="reading-loading-dots" aria-hidden="true"><i /><i /><i /></span>
                </span>
                <span className="reading-loading-subtitle">{subtitle}</span>
            </div>
            <div className="reading-loading-lines" aria-hidden="true">
                <span />
                <span />
                <span />
            </div>
        </div>
    );
}

function ReadingAnnotationContent({
    text,
    bilingualEnabled,
    expanded,
    onToggle,
}: {
    text: string;
    bilingualEnabled: boolean;
    expanded: boolean;
    onToggle: () => void;
}) {
    const bilingual = bilingualEnabled ? splitBilingualText(text) : null;
    if (!bilingual) {
        return <div className="reading-annotation-text">{text}</div>;
    }

    return (
        <div className="reading-annotation-text">
            <div>{bilingual.original}</div>
            <button
                type="button"
                className="chat-bilingual-toggle reading-annotation-bilingual-toggle"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onPointerCancel={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.stopPropagation();
                    onToggle();
                }}
                aria-expanded={expanded}
            >
                {expanded ? "收起中文" : "中文"}
            </button>
            {expanded && <div className="reading-annotation-translation">{bilingual.translated}</div>}
        </div>
    );
}

type Props = {
    book: Book;
    /** 正文字体 / 字号 / 行距的指纹。变了就得重排——翻页模式的断行是按当时的
     *  字体量出来的，阅读器返回书架时又不卸载，不重排就会用旧字体的断行位置。 */
    appearanceKey?: string;
    onBack: () => void;
};

export function ReadingViewer({ book, appearanceKey, onBack }: Props) {
    const isPdf = book.format === "pdf";
    const [readingConfig, setReadingConfig] = useState(() => loadReadingInteractionConfig());
    // 阅读器保持挂载（返回书架不卸载），书架设置页保存后通过事件同步最新配置
    useEffect(() => {
        const reload = () => setReadingConfig(loadReadingInteractionConfig());
        window.addEventListener("reading-interaction-config-changed", reload);
        return () => window.removeEventListener("reading-interaction-config-changed", reload);
    }, []);
    const [chapters, setChapters] = useState<BookChapter[]>([]);
    const [chapterIndex, setChapterIndex] = useState(0);
    const [pdfCurrentPage, setPdfCurrentPage] = useState(1);
    const [pdfTotalPages, setPdfTotalPages] = useState(0);
    const [txtPage, setTxtPage] = useState(0);
    const [annotations, setAnnotations] = useState<ReadingAnnotation[]>([]);
    const [generating, setGenerating] = useState(false);
    const [companionId, setCompanionId] = useState<string | null>(null);
    const [marks, setMarks] = useState<ReadingMark[]>([]);
    /** 插图序号 → objectURL。只为当前正在显示的章节加载，读到哪加载到哪 */
    const [inlineImageUrls, setInlineImageUrls] = useState<Record<number, string>>({});
    const [selectionInfo, setSelectionInfo] = useState<
        {
            text: string;
            /** 划选覆盖的每一段。跨段划选时不止一条，按阅读顺序排好 */
            segments: ReadingSelectionSegment[];
            /** 菜单落点：系统菜单永远紧贴选区，所以我们去屏幕另一端 */
            placeAtTop: boolean; topOffset: number;
        } | null
    >(null);
    /** 点到已有的荧光笔/划线时弹出的删除菜单 */
    const [markMenu, setMarkMenu] = useState<{ mark: ReadingMark; x: number; y: number } | null>(null);
    const [shareTarget, setShareTarget] = useState<ReadingMark[] | null>(null);
    /** 选字菜单要停在页脚正上方，页脚高度随安全区/字号变，量出来最稳 */
    const footerRef = useRef<HTMLElement | null>(null);
    const headerRef = useRef<HTMLElement | null>(null);
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const [footerHeight, setFooterHeight] = useState(96);
    const [showMyAnnotation, setShowMyAnnotation] = useState(false);
    const [showCharAnnotationMenu, setShowCharAnnotationMenu] = useState(false);
    const [showMyMarksPanel, setShowMyMarksPanel] = useState(false);
    const [exportNote, setExportNote] = useState("");
    /** 面板里按章折叠要看全书；页面渲染用的 annotations 只覆盖读过的章节，两者分开 */
    const [panelAnnotations, setPanelAnnotations] = useState<ReadingAnnotation[]>([]);
    const [summaryMemos, setSummaryMemos] = useState<ReadingAnnotationMemo[]>([]);
    const [showRangeSummary, setShowRangeSummary] = useState(false);
    const [summaryRange, setSummaryRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
    const [summaryDraft, setSummaryDraft] = useState("");
    const [summaryLabel, setSummaryLabel] = useState("");
    const [summaryBusy, setSummaryBusy] = useState(false);
    const [summaryNote, setSummaryNote] = useState("");
    const [pendingQuote, setPendingQuote] = useState<
        { text: string; chapterIndex: number; paragraphIndex: number; start?: number; end?: number } | null
    >(null);
    const [myAnnotationText, setMyAnnotationText] = useState("");
    /** 用户单点某一句后弹出的句子菜单 */
    const [sentenceMenu, setSentenceMenu] = useState<{
        chapterIndex: number;
        paragraphIndex: number;
        start: number;
        end: number;
        text: string;
        x: number;
        y: number;
        placeAbove?: boolean;
    } | null>(null);
    /** 正在打开的「段评」（💬）弹窗定位 */
    const [activeParagraphCommentModal, setActiveParagraphCommentModal] = useState<{
        chapterIndex: number;
        paragraphIndex: number;
    } | null>(null);
    /** 段评弹窗底部输入框内容 */
    const [paragraphCommentDraft, setParagraphCommentDraft] = useState("");
    /** 段评弹窗内当前正在回复的目标评论（null 表示直接发段评） */
    const [paragraphCommentReplyTarget, setParagraphCommentReplyTarget] = useState<{
        id: string;
        parentId: string;
        authorName: string;
        content: string;
    } | null>(null);
    /** 手动触发陪读角色发段评的加载态 */
    const [generatingParagraphComment, setGeneratingParagraphComment] = useState(false);
    /** 段评弹窗里当前展开「⋯」菜单的那条评论（主评论和回复共用，一次只开一个） */
    const [commentActionMenuId, setCommentActionMenuId] = useState<string | null>(null);
    /** 刚从批注列表跳过来时闪一下的那一段，用来让人一眼看到落点 */
    const [jumpFlash, setJumpFlash] = useState<{ chapterIndex: number; paragraphIndex: number } | null>(null);
    const jumpFlashTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    // 离开阅读器时别把定时器留着，否则会在已卸载的组件上 setState
    useEffect(() => () => {
        if (jumpFlashTimerRef.current) clearTimeout(jumpFlashTimerRef.current);
    }, []);
    /** 阅读账号自定义头像 objectURL */
    const [readingProfileAvatarUrl, setReadingProfileAvatarUrl] = useState<string>("");
    const [immersive, setImmersive] = useState(true);
    const [showCharPicker, setShowCharPicker] = useState(false);
    const [charPickerClosing, setCharPickerClosing] = useState(false);
    const closeCharPicker = useCallback(() => {
        if (!showCharPicker || charPickerClosing) return;
        setCharPickerClosing(true);
        setTimeout(() => { setShowCharPicker(false); setCharPickerClosing(false); }, 180);
    }, [showCharPicker, charPickerClosing]);
    const [showChat, setShowChat] = useState(false);
    const [chatExpanded, setChatExpanded] = useState(false);
    const [chatOffset, setChatOffset] = useState<{ x: number; y: number }>(() => {
        try {
            const raw = localStorage.getItem(CHAT_FLOAT_POS_KEY);
            if (!raw) return { x: 0, y: 0 };
            const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
            if (typeof parsed.x === "number" && typeof parsed.y === "number" && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
                return { x: parsed.x, y: parsed.y };
            }
        } catch {
            // ignore storage errors
        }
        return { x: 0, y: 0 };
    });
    const [isDragging, setIsDragging] = useState(false);
    const [chatInput, setChatInput] = useState("");
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [chatting, setChatting] = useState(false);
    const [autoAnnotate, setAutoAnnotate] = useState(false);
    const [annotationBatchSize, setAnnotationBatchSize] = useState(isPdf ? 5 : 50);
    const [annotationBatchInput, setAnnotationBatchInput] = useState(String(isPdf ? 5 : 50));
    const [annotationDialogMode, setAnnotationDialogMode] = useState<AnnotationDialogMode | null>(null);
    const [showReadingSettings, setShowReadingSettings] = useState(false);
    const [showTranslationDialog, setShowTranslationDialog] = useState(false);
    const [pdfRenderDraft, setPdfRenderDraft] = useState(() => ({
        pdfZoom: readingConfig.pdfZoom ?? 1,
        pdfPreloadRadius: readingConfig.pdfPreloadRadius ?? 3,
        pdfPreloadEnabled: readingConfig.pdfPreloadEnabled !== false,
    }));
    const [showNavigationDialog, setShowNavigationDialog] = useState(false);
    const [bookmarks, setBookmarks] = useState<ReadingBookmark[]>([]);
    const [showBookmarks, setShowBookmarks] = useState(false);
    const [pdfJumpPage, setPdfJumpPage] = useState<number | undefined>(undefined);
    /** PDF 手动预批注对话框：自定义起始页/结束页，确认后立即预解析并预生成该范围批注 */
    const [pdfPrefetchDialogOpen, setPdfPrefetchDialogOpen] = useState(false);
    const [pdfPrefetchStartInput, setPdfPrefetchStartInput] = useState("");
    const [pdfPrefetchEndInput, setPdfPrefetchEndInput] = useState("");
    const [chaptersLoaded, setChaptersLoaded] = useState(false);
    /** 打开书时读书库出错（重连后还是不行）：不再一直转圈，给一个「再试一次」 */
    const [loadFailed, setLoadFailed] = useState(false);
    const [loadAttempt, setLoadAttempt] = useState(0);
    const touchStartRef = useRef({ x: 0, y: 0 });
    const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
    const [readingMessageMenu, setReadingMessageMenu] = useState<{ messageId: string; x: number; y: number } | null>(null);
    const [editingDiscussMessage, setEditingDiscussMessage] = useState<ChatMessage | null>(null);
    const [editingDiscussContent, setEditingDiscussContent] = useState("");
    const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
    /** 正在手动编辑的批注（自己写的和角色写的都能改） */
    const [editingAnnotation, setEditingAnnotation] = useState<ReadingAnnotation | null>(null);
    const [editingText, setEditingText] = useState("");
    const [annotationTranslationOverrides, setAnnotationTranslationOverrides] = useState<Record<string, boolean>>({});
    const [openAnnotationParagraphs, setOpenAnnotationParagraphs] = useState<Record<string, boolean>>({});
    const toggleParagraphAnnotationBubble = useCallback((cIdx: number, pIdx: number) => {
        const key = `${cIdx}:${pIdx}`;
        setOpenAnnotationParagraphs((prev) => ({ ...prev, [key]: !prev[key] }));
    }, []);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const readingMessagePressStartRef = useRef<{ x: number; y: number } | null>(null);
    const chatDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
    const chatMovedRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const chatListRef = useRef<HTMLDivElement>(null); // 共读讨论悬浮窗消息列表（滚动容器）
    const txtMeasureLineRef = useRef<HTMLParagraphElement>(null);
    const txtMeasureGapRef = useRef<HTMLDivElement>(null);
    const txtMeasureAnnotationRef = useRef<HTMLDivElement>(null);
    const generatedBatchesRef = useRef<Set<string>>(new Set());
    /** 同步「生成中」锁：防止 auto/prefetch 竞态导致同一帧内并发发起多个批注生成任务 */
    const annotationInFlightRef = useRef(false);
    /** 正在生成中的批次 key：防止同一批在生成完成前被再次发起 */
    const inFlightBatchesRef = useRef<Set<string>>(new Set());
    const pendingTxtPageFractionRef = useRef<number | null>(null);
    const lastTxtPaginationSignatureRef = useRef("");
    // 滚动阅读模式：连续滚动（多章窗口无缝衔接）
    const scrollFractionRef = useRef(0);
    const initialScrollFractionRef = useRef<number | null>(null); // 打开书时保存的章节内比例
    const pendingScrollFractionRef = useRef<number | null>(null); // 滑块跨章待定位比例
    /** 从批注列表点过来的目标段落。章内比例只能算到「附近」，
     *  这一项用来在目标章排版完之后精确落到那一段。 */
    const pendingParagraphJumpRef = useRef<{ chapterIndex: number; paragraphIndex: number } | null>(null);
    const scrollContentRef = useRef<HTMLDivElement>(null);        // 滚动内容容器（含多章块）
    const chapterMetricsRef = useRef<Map<number, { top: number; height: number }>>(new Map()); // 各章块在滚动坐标系中的 top/height
    const pendingScrollActionRef = useRef<{ kind: "shift-forward"; oldScrollTop: number; removedHeight: number } | { kind: "shift-backward"; oldScrollTop: number } | null>(null);
    const shiftCooldownRef = useRef(false);                      // 窗口平移后的冷却期，防止边界来回抖动
    const scrollPositionedKeyRef = useRef("");                   // 已做过初始定位的「书+模式」标识
    const chapterIndexRef = useRef(0);
    const chaptersLenRef = useRef(0);
    const [txtLayoutVersion, setTxtLayoutVersion] = useState(0);
    // 外观改了就重排一次。分页那个 effect 已经把 txtLayoutVersion 列进依赖，
    // 这里只负责把「字体变了」这件事翻译成它认识的信号。
    useEffect(() => {
        setTxtLayoutVersion((version) => version + 1);
    }, [appearanceKey]);
    const [txtPages, setTxtPages] = useState<TxtPageItem[][]>([]);
    /** 一页能放下的高度，同时用来限制插图的最大高度（翻页模式） */
    const [imageMaxHeight, setImageMaxHeight] = useState(0);
    const [scrollFraction, setScrollFraction] = useState(0);
    const [flipAnim, setFlipAnim] = useState<{ direction: 'forward' | 'backward'; items: TxtPageItem[] } | null>(null);

    const [enrichedContacts, setEnrichedContacts] = useState<(ReturnType<typeof loadChatContacts>[number] & { char: Character })[]>([]);

    useEffect(() => {
        const chars = loadCharacters();
        const contacts = loadChatContacts();
        const enriched = contacts
            .map(c => ({ ...c, char: chars.find(ch => ch.id === c.characterId) }))
            .filter(c => c.char) as (typeof contacts[number] & { char: Character })[];
        setEnrichedContacts(enriched);
    }, []);

    useEffect(() => {
        const nextSize = isPdf ? 5 : 50;
        setAnnotationBatchSize(nextSize);
        setAnnotationBatchInput(String(nextSize));
        setAutoAnnotate(false);
        generatedBatchesRef.current.clear();
    }, [book.id, isPdf]);

    useEffect(() => {
        setAnnotationTranslationOverrides({});
    }, [book.id, chapterIndex, readingConfig.collapseBilingualTranslation]);

    useEffect(() => {
        setOpenAnnotationParagraphs({});
    }, [book.id]);

    const companion = companionId ? (enrichedContacts.find(c => c.characterId === companionId)?.char || loadCharacters().find(c => c.id === companionId)) : null;
    const bilingualTranslationEnabled = readingConfig.bilingualTranslationEnabled === true;
    /** 翻页动画；老配置里没有这个字段时默认开着，和加开关之前的表现一致 */
    const flipAnimationEnabled = readingConfig.pageFlipAnimation !== false;
    const defaultTranslationExpanded = readingConfig.collapseBilingualTranslation !== true;
    const isScrollMode = !isPdf && readingConfig.readingMode === "scroll";
    // 保持 ref 与最新状态同步（供长生命周期滚动回调读取）
    chapterIndexRef.current = chapterIndex;
    chaptersLenRef.current = chapters.length;
    // 滚动模式渲染的章节窗口：上一章 + 当前章 + 下一章（无缝衔接用）
    const windowChapters = useMemo(() => {
        if (chapters.length === 0) return [] as BookChapter[];
        const start = Math.max(0, chapterIndex - 1);
        const end = Math.min(chapters.length - 1, chapterIndex + 1);
        const out: BookChapter[] = [];
        for (let i = start; i <= end; i++) out.push(chapters[i]);
        return out;
    }, [chapters, chapterIndex]);
    // 滚动模式：将「章节内比例(0-1)」换算为具体滚动位置（窗口布局下按当前章块定位）
    const scrollToChapterFraction = useCallback((fraction: number, targetChapterIndex: number) => {
        const body = scrollRef.current;
        if (!body) return;
        const metrics = chapterMetricsRef.current.get(targetChapterIndex);
        if (!metrics) return;
        const maxScroll = Math.max(0, body.scrollHeight - body.clientHeight);
        const span = Math.max(0, metrics.height - body.clientHeight);
        const target = Math.max(0, Math.min(maxScroll, metrics.top + Math.max(0, Math.min(1, fraction)) * span));
        body.scrollTop = target;
        const actual = span > 0 ? Math.min(1, Math.max(0, (target - metrics.top) / span)) : 0;
        scrollFractionRef.current = actual;
        setScrollFraction(actual);
    }, []);
    const currentChapter = chapters[chapterIndex];

    /** 当前屏上会用到的插图序号（含独立插图与行内角标小图）。只加载这些，读完就放掉，
     *  免得整本画册的图全挂在内存里。 */
    const visibleImageIndices = useMemo(() => {
        const source = isScrollMode ? windowChapters : (currentChapter ? [currentChapter] : []);
        const indices = new Set<number>();
        for (const chapter of source) {
            for (const paragraph of chapter.paragraphs) {
                const marker = parseReadingImageMarker(paragraph);
                if (marker) {
                    indices.add(marker.index);
                    continue;
                }
                for (const iconIdx of collectReadingInlineIconIndices(paragraph)) {
                    indices.add(iconIdx);
                }
            }
        }
        return [...indices].sort((a, b) => a - b);
    }, [currentChapter, isScrollMode, windowChapters]);

    useEffect(() => {
        let cancelled = false;
        const wanted = new Set(visibleImageIndices);
        // 离开视野的先放掉（objectURL 不回收就一直占着内存）
        setInlineImageUrls((prev) => {
            let changed = false;
            const next: Record<number, string> = {};
            for (const [key, url] of Object.entries(prev)) {
                if (wanted.has(Number(key))) next[Number(key)] = url;
                else { URL.revokeObjectURL(url); changed = true; }
            }
            return changed ? next : prev;
        });
        void (async () => {
            for (const index of visibleImageIndices) {
                if (cancelled) return;
                // 串行：这几张图和封面/字体共用一个 IndexedDB，并发打开会互相 block
                const blob = await loadReadingAsset(readingImageAssetKey(book.id, index)).catch(() => null);
                if (cancelled) return;
                if (!blob || blob.size === 0) continue;
                setInlineImageUrls((prev) => {
                    if (prev[index]) return prev;
                    return { ...prev, [index]: URL.createObjectURL(blob) };
                });
            }
        })();
        return () => { cancelled = true; };
    }, [book.id, visibleImageIndices]);

    // 离开阅读器时把剩下的 objectURL 全放掉
    useEffect(() => () => {
        setInlineImageUrls((prev) => {
            Object.values(prev).forEach((url) => URL.revokeObjectURL(url));
            return {};
        });
    }, []);
    // 阅读账号的头像和昵称。换了账号以后，段评里自己发的那几条要立刻换头像，
    // 所以这里除了挂载时读一次，还要监听保存事件重读——不能只在挂载时读一次，
    // 那就是「换了头像段评不跟着变」的老毛病。
    const [readingProfileName, setReadingProfileName] = useState(() => loadReadingProfile().name);
    useEffect(() => {
        let alive = true;
        let url = "";
        const refresh = async () => {
            const profile = loadReadingProfile();
            if (!alive) return;
            setReadingProfileName(profile.name);
            const blob = await loadReadingProfileAvatar().catch(() => null);
            if (!alive) return;
            if (url) { URL.revokeObjectURL(url); url = ""; }
            if (!blob || blob.size === 0) {
                setReadingProfileAvatarUrl("");
                return;
            }
            url = URL.createObjectURL(blob);
            setReadingProfileAvatarUrl(url);
        };
        void refresh();
        const onChange = () => { void refresh(); };
        window.addEventListener(READING_PROFILE_CHANGED_EVENT, onChange);
        return () => {
            alive = false;
            window.removeEventListener(READING_PROFILE_CHANGED_EVENT, onChange);
            if (url) URL.revokeObjectURL(url);
        };
    }, []);
    const userIdentity = useMemo(
        () => resolveUserIdentity(companionId || undefined, "reading"),
        [companionId],
    );
    // 批注/段评署名优先用阅读账号昵称或绑定的用户身份，不写死。
    // readingProfileName 是这次会话里读到的账号昵称（换账号会刷新），排最前。
    const userDisplayName = useMemo(
        () => readingProfileName.trim() || userIdentity?.name?.trim() || "我",
        [readingProfileName, userIdentity],
    );
    const userAvatarUrl = readingProfileAvatarUrl || userIdentity?.avatarUrl || "";
    const characterById = useMemo(() => {
        const map = new Map<string, Character>();
        for (const item of enrichedContacts) {
            map.set(item.characterId, item.char);
        }
        for (const ch of loadCharacters()) {
            if (!map.has(ch.id)) map.set(ch.id, ch);
        }
        return map;
    }, [enrichedContacts]);
    const txtPagesChapterIndex = txtPages[0]?.find((item) => item.kind !== "gap")?.chapterIndex ?? txtPages[0]?.[0]?.chapterIndex;
    const txtPagesReadyForCurrentChapter = !isPdf && !isScrollMode && txtPages.length > 0 && txtPagesChapterIndex === chapterIndex;
    const showTxtLoading = !isPdf && (
        !chaptersLoaded ||
        (chaptersLoaded && chapters.length > 0 && Boolean(currentChapter) && !isScrollMode && !txtPagesReadyForCurrentChapter)
    );

    const renderTxtPage = (pageIndex: number) => {
        const pageItems = txtPages[pageIndex] || [];
        if (pageItems.length === 0) return null;
        return (
            <div className="reading-page-content">
                {pageItems.map((item, i) => (
                    item.kind === "gap"
                        ? <div key={i} className="reading-line-gap" />
                        : item.kind === "annotation"
                            ? renderAnnotationItem(item.annotation)
                            : item.kind === "image"
                                ? renderImageItem(item.image, i)
                                : renderLine(item, i)
                ))}
            </div>
        );
    };

    useEffect(() => { setMarks(loadReadingMarks(book.id)); }, [book.id]);

    useEffect(() => {
        const el = footerRef.current;
        if (!el) return;
        const sync = () => setFooterHeight(el.offsetHeight);
        sync();
        const observer = new ResizeObserver(sync);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);


    // ── 句子的左右拖动把手 ──────────────────────────────────
    // 点一句先把它选中，两端各出一个圆点；拖圆点就能把范围往前 / 往后拉，
    // 一直拉到相邻那句就是跨句划线。结果存回 sentenceMenu，
    // 后面的「高亮 / 划线 / 批注 / 分享」全都按这个范围走。
    const [sentenceHandles, setSentenceHandles] = useState<{
        start: { x: number; y: number };
        end: { x: number; y: number };
    } | null>(null);
    const sentenceDragRef = useRef<{ side: "start" | "end"; pointerId: number } | null>(null);

    /** 段落内第 offset 个字符所在字的屏幕位置，用来把把手贴到字上 */
    const paragraphOffsetRect = useCallback((cIdx: number, pIdx: number, offset: number): DOMRect | null => {
        const surface = surfaceRef.current;
        if (!surface) return null;
        const lines = surface.querySelectorAll<HTMLElement>(`[data-chapter="${cIdx}"][data-paragraph="${pIdx}"]`);
        for (const line of Array.from(lines)) {
            const lineStart = Number(line.dataset.charstart || 0);
            const lineLength = (line.textContent || "").length;
            if (offset < lineStart || offset > lineStart + lineLength) continue;
            const local = offset - lineStart;
            const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
            let acc = 0;
            let node = walker.nextNode();
            while (node) {
                const length = (node.textContent || "").length;
                if (local <= acc + length) {
                    const range = document.createRange();
                    const from = Math.max(0, Math.min(length, local - acc));
                    try {
                        range.setStart(node, from);
                        range.setEnd(node, Math.min(length, from + 1));
                    } catch {
                        return null;
                    }
                    const rect = range.getBoundingClientRect();
                    if (rect && (rect.width > 0 || rect.height > 0)) return rect;
                }
                acc += length;
                node = walker.nextNode();
            }
        }
        return null;
    }, []);

    /** 屏幕坐标落在正文的哪个位置（章 / 段 / 段内偏移）。拖动时靠它换算。 */
    const offsetFromPoint = useCallback((x: number, y: number): { chapterIndex: number; paragraphIndex: number; offset: number } | null => {
        const doc = document as Document & {
            caretRangeFromPoint?: (px: number, py: number) => Range | null;
            caretPositionFromPoint?: (px: number, py: number) => { offsetNode: Node; offset: number } | null;
        };
        let container: Node | null = null;
        let offset = 0;
        if (typeof doc.caretRangeFromPoint === "function") {
            const range = doc.caretRangeFromPoint(x, y);
            if (range) { container = range.startContainer; offset = range.startOffset; }
        }
        if (!container && typeof doc.caretPositionFromPoint === "function") {
            const position = doc.caretPositionFromPoint(x, y);
            if (position) { container = position.offsetNode; offset = position.offset; }
        }
        if (!container) return null;
        const element = container.nodeType === Node.TEXT_NODE ? container.parentElement : container as HTMLElement;
        const line = element?.closest<HTMLElement>("[data-paragraph]");
        if (!line) return null;
        const chapterIndex = Number(line.dataset.chapter);
        const paragraphIndex = Number(line.dataset.paragraph);
        if (!Number.isFinite(chapterIndex) || !Number.isFinite(paragraphIndex)) return null;
        const lineStart = Number(line.dataset.charstart || 0);
        const local = textOffsetWithin(line, container, offset);
        return { chapterIndex, paragraphIndex, offset: lineStart + local };
    }, []);

    /** 把两个把手摆到当前选区两端。位置没变就不 setState——滚动时每帧都会调它，
     *  无脑写 state 会把整页重渲染一遍。 */
    const syncSentenceHandles = useCallback(() => {
        if (!sentenceMenu) { setSentenceHandles(null); return; }
        const { chapterIndex: cIdx, paragraphIndex: pIdx, start, end } = sentenceMenu;
        const startRect = paragraphOffsetRect(cIdx, pIdx, start);
        const endRect = paragraphOffsetRect(cIdx, pIdx, Math.max(start + 1, end) - 1);
        if (!startRect || !endRect) { setSentenceHandles(null); return; }
        // 换算成相对阅读区的位置：把手是阅读区里的绝对定位元素，
        // 这样手机壳整体缩放时也不会和文字错位。
        // 左手柄贴首字最左沿（startRect.left），右手柄贴末字最右沿（endRect.right）。
        const surfaceRect = surfaceRef.current?.getBoundingClientRect();
        const originX = surfaceRect?.left ?? 0;
        const originY = surfaceRect?.top ?? 0;
        const next = {
            start: {
                x: startRect.left - originX,
                y: startRect.top + startRect.height / 2 - originY,
            },
            end: {
                x: endRect.right - originX,
                y: endRect.top + endRect.height / 2 - originY,
            },
        };
        setSentenceHandles((prev) => (
            prev
            && Math.abs(prev.start.x - next.start.x) < 0.5
            && Math.abs(prev.start.y - next.start.y) < 0.5
            && Math.abs(prev.end.x - next.end.x) < 0.5
            && Math.abs(prev.end.y - next.end.y) < 0.5
                ? prev
                : next
        ));
    }, [paragraphOffsetRect, sentenceMenu]);

    useLayoutEffect(() => {
        syncSentenceHandles();
    }, [syncSentenceHandles]);

    // 滚一滚、转个屏，字的位置就变了，把手跟着重新贴一次
    useEffect(() => {
        if (!sentenceMenu) return;
        const body = scrollRef.current;
        const onShift = () => syncSentenceHandles();
        body?.addEventListener("scroll", onShift, { passive: true });
        window.addEventListener("resize", onShift);
        return () => {
            body?.removeEventListener("scroll", onShift);
            window.removeEventListener("resize", onShift);
        };
    }, [sentenceMenu, syncSentenceHandles]);

    /** 拖把手：按手指下的字反过来改选区的起点 / 终点 */
    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            const drag = sentenceDragRef.current;
            if (!drag || drag.pointerId !== e.pointerId) return;
            e.preventDefault();
            setSentenceMenu((prev) => {
                if (!prev) return prev;
                const hit = offsetFromPoint(e.clientX, e.clientY);
                if (!hit) return prev;
                // 把手只在本段内有效。跨段划线还是长按选字那条路，
                // 硬把范围接到别段很容易一次选出一大截。
                if (hit.chapterIndex !== prev.chapterIndex || hit.paragraphIndex !== prev.paragraphIndex) return prev;
                const paragraph = chapters[prev.chapterIndex]?.paragraphs[prev.paragraphIndex] || "";
                if (paragraph.length === 0) return prev;
                let start = prev.start;
                let end = prev.end;
                if (drag.side === "start") {
                    start = Math.min(hit.offset, end - 1);
                } else {
                    end = Math.max(hit.offset, start + 1);
                }
                start = Math.max(0, Math.min(paragraph.length - 1, start));
                end = Math.max(start + 1, Math.min(paragraph.length, end));
                if (start === prev.start && end === prev.end) return prev;
                const text = stripReadingInlineIconMarkers(paragraph.slice(start, end)).trim();
                return { ...prev, start, end, text: text || prev.text };
            });
        };
        const onUp = (e: PointerEvent) => {
            if (sentenceDragRef.current?.pointerId === e.pointerId) sentenceDragRef.current = null;
        };
        window.addEventListener("pointermove", onMove, { passive: false });
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
    }, [chapters, offsetFromPoint]);

    /** 长按弹出句子菜单后的一小段时间内忽略系统选区：指纹设备（尤其 iOS）会在我们清空选区之后
     *  又把词选回来，不挡住的话「高亮/划线/取消」那条划选菜单会跟着冒出来，和我们自己的菜单叠在一起。 */
    const suppressSelectionUntilRef = useRef(0);

    /** 松手后读取选区：定位到覆盖的每一段，换算成段落内字符区间 */
    const captureSelection = useCallback(() => {
        if (Date.now() < suppressSelectionUntilRef.current) { setSelectionInfo(null); return; }
        const sel = typeof window !== "undefined" ? window.getSelection() : null;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setSelectionInfo(null); return; }

        const range = sel.getRangeAt(0);
        const surface = surfaceRef.current;
        if (!surface) { setSelectionInfo(null); return; }
        // 跨段划选：拆成「每段一条」。批注卡片不带 data-paragraph，不会被算进来，
        // 所以从正文划到下一段时，中间那张批注卡片的文字不会混进摘抄。
        const segments = collectSelectionSegments(range, surface);
        if (segments.length === 0) { setSelectionInfo(null); return; }
        // 正文按数据里的段落切，不从 DOM 取：翻页模式下一段可能被切成好几行，
        // 中间还可能夹着批注卡片
        const selectedText = segments
            .map((segment) => (chapters[segment.chapterIndex]?.paragraphs[segment.paragraphIndex] || "").slice(segment.start, segment.end))
            .filter(Boolean)
            .join("\n");
        if (selectedText.trim().length < 2) { setSelectionInfo(null); return; }

        const surfaceRect = surfaceRef.current?.getBoundingClientRect();
        const rect = range.getBoundingClientRect();
        const originY = surfaceRect?.top ?? 0;
        const surfaceHeight = surfaceRect?.height ?? (typeof window !== "undefined" ? window.innerHeight : 812);
        const headerRect = headerRef.current?.getBoundingClientRect();
        const selectionCenterY = (rect.top + rect.bottom) / 2 - originY;
        setSelectionInfo({
            text: selectedText,
            segments,
            placeAtTop: selectionCenterY > surfaceHeight / 2,
            topOffset: (headerRect ? headerRect.bottom - originY : 56) + 12,
        });
    }, [chapters]);

    /** 从一条已有划线/高亮的元素上打开菜单：范围精确到这条标记本身。
     *  点一下已划线的句子走这里；长按留给「准备划线」，仍走 openSentenceMenuFromTarget。 */
    const openMenuFromMarkElement = (hit: HTMLElement): boolean => {
        const mark = marks.find(item => item.id === hit.dataset.markId);
        if (!mark) return false;
        const rect = hit.getBoundingClientRect();
        const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 375;
        const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 812;
        const placeAbove = rect.bottom + 84 > viewportHeight - 40;
        const paragraph = chapters[mark.chapterIndex]?.paragraphs[mark.paragraphIndex] || "";
        const rawSlice = paragraph.slice(mark.start, mark.end) || mark.text;
        setMarkMenu(null);
        setSentenceMenu({
            chapterIndex: mark.chapterIndex,
            paragraphIndex: mark.paragraphIndex,
            start: mark.start,
            end: mark.end,
            text: stripReadingInlineIconMarkers(rawSlice).trim() || mark.text,
            x: clampMenuX(rect.left + rect.width / 2, viewportWidth),
            y: placeAbove ? Math.max(56, rect.top - 8) : rect.bottom + 8,
            placeAbove,
        });
        return true;
    };

    /** 算出「点到某一句 / 某个已有标记」时该弹的菜单并打开它。
     *  触摸端由长按调用，鼠标端由单击调用；返回 true 表示这一点确实落在正文的句子或标记上。 */
    const openSentenceMenuFromTarget = (target: HTMLElement | null): boolean => {
        if (!target) return false;
        const sentenceHit = target.closest<HTMLElement>("[data-sentence-start]");
        if (sentenceHit) {
            const cIdx = Number(sentenceHit.dataset.sentenceChapter);
            const pIdx = Number(sentenceHit.dataset.sentenceParagraph);
            const start = Number(sentenceHit.dataset.sentenceStart);
            const end = Number(sentenceHit.dataset.sentenceEnd);
            const paragraph = chapters[cIdx]?.paragraphs[pIdx] || "";
            if (Number.isFinite(cIdx) && Number.isFinite(pIdx) && Number.isFinite(start) && Number.isFinite(end) && end > start) {
                const rawSlice = paragraph.slice(start, end);
                const cleanText = stripReadingInlineIconMarkers(rawSlice).trim();
                const rect = sentenceHit.getBoundingClientRect();
                const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 375;
                const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 812;
                const placeAbove = rect.bottom + 84 > viewportHeight - 40;
                setMarkMenu(null);
                setSentenceMenu((prev) => {
                    if (
                        prev &&
                        prev.chapterIndex === cIdx &&
                        prev.paragraphIndex === pIdx &&
                        prev.start === start &&
                        prev.end === end
                    ) {
                        return null;
                    }
                    return {
                        chapterIndex: cIdx,
                        paragraphIndex: pIdx,
                        start,
                        end,
                        text: cleanText || rawSlice,
                        x: clampMenuX(rect.left + rect.width / 2, viewportWidth),
                        y: placeAbove ? Math.max(56, rect.top - 8) : rect.bottom + 8,
                        placeAbove,
                    };
                });
                return true;
            }
            return false;
        }

        const hit = target.closest<HTMLElement>("[data-mark-id]");
        if (!hit) return false;
        return openMenuFromMarkElement(hit);
    };

    // ── 句子/标记菜单的呼出方式：触摸长按 ──
    // 以前是「点一下就弹」，但正文字句排得密，翻页、滚屏、唤出沉浸界面时顺手一碰
    // 就会弹出划线菜单，误触很频繁。改成：触摸长按 500ms 才弹，鼠标点一下照旧
    // （桌面没有误触问题，也不该逼人按住不动）。
    const surfaceLongPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const surfacePressRef = useRef<{ x: number; y: number } | null>(null);
    /** 长按已经弹过菜单：紧跟其后那次 click 是松手的余波，要放过一次 */
    const longPressClickGuardRef = useRef(false);
    /** 最近一次按下用的是鼠标还是手指，决定单击要不要直接弹菜单 */
    const lastPointerTypeRef = useRef("mouse");

    const cancelSurfaceLongPress = useCallback(() => {
        surfacePressRef.current = null;
        if (surfaceLongPressTimer.current) {
            clearTimeout(surfaceLongPressTimer.current);
            surfaceLongPressTimer.current = undefined;
        }
    }, []);

    /** 长按会连带把原生的词句选中，把系统选区清掉，免得系统菜单和我们这个菜单叠在一起 */
    const clearNativeSelection = useCallback(() => {
        try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
        setSelectionInfo(null);
    }, []);

    const handleSurfacePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        lastPointerTypeRef.current = e.pointerType || "mouse";
        longPressClickGuardRef.current = false;
        cancelSurfaceLongPress();
        if (e.button > 0) return;
        const target = e.target as HTMLElement | null;
        if (!target) return;
        // 只对正文里的句子 / 已有标记起长按，按钮、菜单、批注卡片一概不参与
        if (!target.closest("[data-sentence-start], [data-mark-id]")) return;
        if (target.closest("button, input, select, textarea, a, .reading-sentence-menu, .reading-mark-menu, .reading-selection-menu, .reading-sentence-handle, .reading-annotation-interactive")) return;
        const pressX = e.clientX;
        const pressY = e.clientY;
        surfacePressRef.current = { x: pressX, y: pressY };
        surfaceLongPressTimer.current = setTimeout(() => {
            surfaceLongPressTimer.current = undefined;
            surfacePressRef.current = null;
            longPressClickGuardRef.current = true;
            // 长按期间系统可能已经把词选上了，先压住选区捕获，再清空
            suppressSelectionUntilRef.current = Date.now() + 400;
            clearNativeSelection();
            // 按住这几百毫秒里可能翻页或重排过，按坐标重新取一次落点最稳
            const hit = (document.elementFromPoint(pressX, pressY) as HTMLElement | null) || target;
            openSentenceMenuFromTarget(hit);
        }, SENTENCE_LONG_PRESS_MS);
    };

    const handleSurfacePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const start = surfacePressRef.current;
        if (!start) return;
        // 手指动了说明是在划选或滚动，不再算长按
        if (Math.abs(e.clientX - start.x) > 10 || Math.abs(e.clientY - start.y) > 10) cancelSurfaceLongPress();
    };

    const handleSurfacePointerEnd = () => {
        cancelSurfaceLongPress();
        // 系统选区菜单往往在 pointerup 之后才冒出来，这里再清一次
        if (longPressClickGuardRef.current) clearNativeSelection();
    };

    const handleSurfaceContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        // 正文句子/标记上的长按归我们的句子菜单管，别让系统再压一层选词菜单
        if (target.closest("[data-sentence-start], [data-mark-id]")) e.preventDefault();
    };

    /** 正文上的单击：点空白收起菜单；鼠标点句子照旧弹菜单，触摸端只认长按 */
    const handleSurfaceClick = (e: React.MouseEvent) => {
        const sel = typeof window !== "undefined" ? window.getSelection() : null;
        if (sel && !sel.isCollapsed) return; // 正在选字，交给选字菜单
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest(".reading-sentence-menu, .reading-mark-menu, .reading-selection-menu")) return;
        // 长按刚弹过菜单，这次 click 是松手的余波
        if (longPressClickGuardRef.current) {
            longPressClickGuardRef.current = false;
            return;
        }
        if (target.closest("[data-sentence-start], [data-mark-id]")) {
            // 点已有划线/高亮的句子：手指和鼠标都弹菜单（取消高亮/取消划线/批注/分享都在里面）。
            // 长按才是「准备划线」，见 handleSurfacePointerDown。
            const markHit = target.closest<HTMLElement>("[data-mark-id]");
            if (markHit && openMenuFromMarkElement(markHit)) return;
            if (lastPointerTypeRef.current === "mouse" && openSentenceMenuFromTarget(target)) return;
            // 触摸端短按空白句子不弹菜单，但菜单开着时点一下能收起
            setMarkMenu(null);
            setSentenceMenu(null);
            return;
        }
        setMarkMenu(null);
        setSentenceMenu(null);
    };

    const openShareDialog = (mark: ReadingMark) => {
        setShareTarget(readingMarkGroup(marks, mark));
        setMarkMenu(null);
        setSentenceMenu(null);
    };

    const toggleSentenceMark = (style: ReadingMarkStyle) => {
        if (!sentenceMenu) return;
        const { chapterIndex: cIdx, paragraphIndex: pIdx, start, end } = sentenceMenu;
        const overlappingSameStyle = marks.filter(
            (m) =>
                m.chapterIndex === cIdx &&
                m.paragraphIndex === pIdx &&
                m.style === style &&
                m.start < end &&
                m.end > start,
        );
        if (overlappingSameStyle.length > 0) {
            // 已有同类型标记 → 取消高亮 / 取消划线
            const toRemoveIds = new Set<string>();
            for (const m of overlappingSameStyle) {
                for (const gm of readingMarkGroup(marks, m)) {
                    toRemoveIds.add(gm.id);
                }
            }
            toRemoveIds.forEach((id) => deleteReadingMark(book.id, id));
            setMarks((prev) => prev.filter((item) => !toRemoveIds.has(item.id)));
            return;
        }
        // 如果该句已有另一种样式（如高亮改划线），先移除旧样式再添加新样式，保持清晰
        const overlappingOtherStyle = marks.filter(
            (m) =>
                m.chapterIndex === cIdx &&
                m.paragraphIndex === pIdx &&
                m.style !== style &&
                m.start === start &&
                m.end === end,
        );
        if (overlappingOtherStyle.length > 0) {
            const otherIds = new Set(overlappingOtherStyle.map((m) => m.id));
            otherIds.forEach((id) => deleteReadingMark(book.id, id));
            setMarks((prev) => prev.filter((item) => !otherIds.has(item.id)));
        }
        const paragraphText = chapters[cIdx]?.paragraphs[pIdx] || "";
        const created: ReadingMark = {
            id: `mk_${Date.now()}_0_${Math.random().toString(36).slice(2, 6)}`,
            bookId: book.id,
            chapterIndex: cIdx,
            paragraphIndex: pIdx,
            start,
            end,
            text: stripReadingInlineIconMarkers(paragraphText.slice(start, end)) || sentenceMenu.text,
            style,
            createdAt: new Date().toISOString(),
            authorType: "user",
        };
        saveReadingMark(created);
        setMarks((prev) => [...prev, created]);
        // 注意：点击「高亮」或「划线」后不关闭 sentenceMenu，以便按钮立即变为「取消高亮/取消划线」并显示插入的「批注」按钮
    };

    const removeMark = (mark: ReadingMark) => {
        // 跨段划出来的那几条是一体的，删一条就该整组消失
        const group = readingMarkGroup(marks, mark);
        const ids = new Set(group.map(item => item.id));
        group.forEach(item => deleteReadingMark(book.id, item.id));
        setMarks(prev => prev.filter(item => !ids.has(item.id)));
        setMarkMenu(null);
    };

    const addMark = (style: ReadingMarkStyle) => {
        if (!selectionInfo || selectionInfo.segments.length === 0) return;
        // 跨段划选存成一组：渲染仍按段落切开，删除/批注/分享时按整组处理
        const groupId = `mg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const createdAt = new Date().toISOString();
        const created: ReadingMark[] = selectionInfo.segments.map((segment, index) => ({
            id: `mk_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
            bookId: book.id,
            chapterIndex: segment.chapterIndex,
            paragraphIndex: segment.paragraphIndex,
            start: segment.start,
            end: segment.end,
            text: (chapters[segment.chapterIndex]?.paragraphs[segment.paragraphIndex] || "").slice(segment.start, segment.end),
            style,
            createdAt,
            groupId,
        }));
        created.forEach(saveReadingMark);
        setMarks(prev => [...prev, ...created]);
        clearSelection();
    };

    const clearSelection = () => {
        setSelectionInfo(null);
        try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
    };

    useEffect(() => {
        const onUp = () => { window.setTimeout(captureSelection, 10); };
        document.addEventListener("pointerup", onUp);
        document.addEventListener("selectionchange", onUp);
        return () => {
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("selectionchange", onUp);
        };
    }, [captureSelection]);

    /** 批注落库后同步往记忆日志追一条。没有共读角色时不写——没人可记。 */
    const toAnnotationMemos = (list: ReadingAnnotation[]): ReadingAnnotationMemo[] =>
        list
            .filter(annotation => annotation.characterId)
            .map(annotation => ({
                id: annotation.id,
                characterId: annotation.characterId,
                bookId: book.id,
                bookTitle: book.title,
                chapterIndex: annotation.chapterIndex,
                chapterTitle: chapters.find(chapter => chapter.index === annotation.chapterIndex)?.title || "",
                authorType: annotation.authorType === "user" ? "user" as const : "character" as const,
                quote: annotation.quote,
                content: annotation.content,
                createdAt: annotation.createdAt,
                // 段评和批注分开记：混成一种，记忆区和提示词就会把两者说串。
                // kind 统一走 resolveReadingAnnotationKind，不在这里再判一遍。
                annotationKind: resolveReadingAnnotationKind(annotation),
                ...(isCommentAnnotation(annotation) ? { paragraphIndex: annotation.paragraphIndex } : {}),
            }));

    /** 批注列表里那行「划线句子」。取批注锚定的 quote；
     *  老数据是整段批注、没有 quote 的，退回它所在段落开头的原文，
     *  免得列表里只剩一句没头没脑的话。 */
    const annotationQuotePreview = (annotation: ReadingAnnotation): string => {
        const quote = (annotation.quote || "").replace(/\s+/g, " ").trim();
        if (quote) return quote.slice(0, 40);
        const paragraph = chapters[annotation.chapterIndex]?.paragraphs[annotation.paragraphIndex] || "";
        return stripReadingInlineIconMarkers(paragraph).replace(/\s+/g, " ").trim().slice(0, 40);
    };

    /** 列表里那句「可以点回去」的原文。点一下跳到它在正文里的位置，读完再回列表。
     *  用 span + role 而不是 button：这段文字本来就带着划线样式，换成 button
     *  会被浏览器的默认样式覆盖，显示就跟正文里的划线对不上了。 */
    const renderJumpableQuote = (
        text: string,
        chapterIdx: number,
        paragraphIdx: number,
        className: string,
        markStyle?: ReadingMarkStyle,
    ) => {
        if (!text) return null;
        const jump = () => jumpToSavedLine(chapterIdx, paragraphIdx);
        return (
            <span
                className={`${className} reading-quote-jump`}
                {...(markStyle ? { "data-style": markStyle } : {})}
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                title="跳到原文那一页"
                onClick={(event) => { event.stopPropagation(); jump(); }}
                onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    jump();
                }}
            >
                {text}
            </span>
        );
    };

    /** 批注列表里的一行：上面是划线句子，下面是这条批注本身，右边删除。
     *  段评不走这里——段评只出现在段末 💬 弹窗里。 */
    const renderAnnotationRow = (annotation: ReadingAnnotation, onDelete: () => void) => {
        const quote = annotationQuotePreview(annotation);
        return (
            <div key={annotation.id} className="reading-mark-row">
                <span className="reading-my-annotation-row-body">
                    {renderJumpableQuote(quote, annotation.chapterIndex, annotation.paragraphIndex, "reading-my-annotation-row-quote")}
                    <span>{annotation.content}</span>
                </span>
                <button type="button" onClick={onDelete}>删除</button>
            </div>
        );
    };

    /** 按章折叠的列表壳。当前章默认展开，其余收起，长书里才好找。 */
    const renderChapterFoldList = (
        sections: Array<{ index: number; count: number; rows: React.ReactNode }>,
        emptyText: string,
    ) => {
        if (sections.length === 0) {
            return <div className="reading-settings-inline-note"><span>{emptyText}</span></div>;
        }
        return (
            <>
                {sections.map(section => (
                    <details key={section.index} className="reading-fold" open={section.index === chapterIndex}>
                        <summary className="reading-fold-summary">
                            <span>{chapters.find(chapter => chapter.index === section.index)?.title?.trim() || `第${section.index + 1}章`}</span>
                            <span className="reading-fold-count">{section.count}</span>
                        </summary>
                        <div className="reading-fold-body">{section.rows}</div>
                    </details>
                ))}
            </>
        );
    };

    /** 导出全书批注。state 里的 annotations 只覆盖读过的章节，这里重新按章全量取一遍。 */
    const exportAnnotations = async () => {
        setExportNote("正在整理…");
        try {
            const groups = await Promise.all(chapters.map(chapter => loadAnnotations(book.id, chapter.index)));
            const markdown = buildAnnotationMarkdown({
                book,
                chapters,
                annotations: groups.flat(),
                marks,
                userName: userDisplayName,
            });
            await downloadFile(
                new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
                annotationExportFileName(book),
            );
            setExportNote("");
        } catch (err) {
            setExportNote(err instanceof Error ? err.message : "导出失败");
        }
    };

    const saveMyAnnotation = async () => {
        const text = myAnnotationText.trim();
        if (!text || !pendingQuote) return;
        const hasRange = typeof pendingQuote.end === "number" && pendingQuote.end > 0;
        const annotation: ReadingAnnotation = {
            id: `ann_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            bookId: book.id,
            chapterIndex: pendingQuote.chapterIndex,
            paragraphIndex: pendingQuote.paragraphIndex,
            // 用户批注仍记录当前共读的角色，便于「这条是写给谁看的」
            characterId: companionId || "",
            characterName: userDisplayName,
            content: text,
            createdAt: new Date().toISOString(),
            authorType: "user",
            // 句子批注一律是「批注」，哪怕范围算不出来（没有 quoteEnd）也不能落进段评
            annotationKind: "note",
            quote: pendingQuote.text,
            ...(typeof pendingQuote.start === "number" ? { quoteStart: pendingQuote.start } : {}),
            ...(hasRange ? { quoteEnd: pendingQuote.end } : {}),
        };
        await saveAnnotation(annotation);
        appendReadingAnnotationMemos(toAnnotationMemos([annotation]));
        setAnnotations(prev => [...prev, annotation]);
        setShowMyAnnotation(false);
        setMyAnnotationText("");
        setPendingQuote(null);
        setSentenceMenu(null);
    };

    const openParagraphCommentDialog = useCallback((cIdx: number, pIdx: number) => {
        setActiveParagraphCommentModal({ chapterIndex: cIdx, paragraphIndex: pIdx });
        setParagraphCommentReplyTarget(null);
        setParagraphCommentDraft("");
        // 上一次留下的「⋯」菜单别带进来
        setCommentActionMenuId(null);
        setSentenceMenu(null);
    }, []);

    const handleSendParagraphComment = async () => {
        if (!activeParagraphCommentModal) return;
        const text = paragraphCommentDraft.trim();
        if (!text) return;
        const { chapterIndex: cIdx, paragraphIndex: pIdx } = activeParagraphCommentModal;
        const annotation: ReadingAnnotation = {
            id: `ann_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            bookId: book.id,
            chapterIndex: cIdx,
            paragraphIndex: pIdx,
            characterId: companionId || "",
            characterName: userDisplayName,
            content: text,
            createdAt: new Date().toISOString(),
            authorType: "user",
            annotationKind: "comment",
            ...(paragraphCommentReplyTarget
                ? {
                    parentId: paragraphCommentReplyTarget.parentId,
                    replyToName: paragraphCommentReplyTarget.authorName,
                }
                : {}),
        };
        await saveAnnotation(annotation);
        appendReadingAnnotationMemos(toAnnotationMemos([annotation]));
        setAnnotations((prev) => [...prev, annotation]);
        setParagraphCommentDraft("");
        setParagraphCommentReplyTarget(null);
    };

    const handleRefreshCompanionParagraphComment = async () => {
        if (!activeParagraphCommentModal || generatingParagraphComment) return;
        if (!companionId || !companion) {
            setAnnotationError("请先在左下角选择陪读角色");
            return;
        }
        const { chapterIndex: cIdx, paragraphIndex: pIdx } = activeParagraphCommentModal;
        const chapter = chapters[cIdx];
        const rawParagraph = chapter?.paragraphs[pIdx] || "";
        const paragraphText = stripReadingInlineIconMarkers(rawParagraph).trim();
        if (!paragraphText) return;

        const prevPara = pIdx > 0 ? stripReadingInlineIconMarkers(chapter?.paragraphs[pIdx - 1] || "").trim() : "";
        const nextPara = pIdx + 1 < (chapter?.paragraphs.length || 0) ? stripReadingInlineIconMarkers(chapter?.paragraphs[pIdx + 1] || "").trim() : "";
        const surroundingText = [prevPara, nextPara].filter(Boolean).join("\n");

        const rawExistingComments = annotations
            .filter(
                (a) =>
                    a.chapterIndex === cIdx &&
                    a.paragraphIndex === pIdx &&
                    !isNoteAnnotation(a),
            )
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

        const existingComments = rawExistingComments.map((a) => ({
            id: a.id,
            authorName: isUserAnnotation(a) ? userDisplayName : (a.characterName || companion.name),
            isUser: isUserAnnotation(a),
            content: a.content,
            replyToName: a.replyToName,
        }));

        setGeneratingParagraphComment(true);
        setAnnotationError(null);
        try {
            const replyResult = await generateParagraphCommentReply({
                book,
                chapterTitle: chapter?.title || book.title,
                paragraphIndex: pIdx,
                paragraphText,
                surroundingText,
                existingComments,
                characterId: companionId,
                replyTarget: paragraphCommentReplyTarget
                    ? {
                        id: paragraphCommentReplyTarget.id,
                        authorName: paragraphCommentReplyTarget.authorName,
                        content: paragraphCommentReplyTarget.content,
                    }
                    : undefined,
            });

            // 解析归属：若用户显式选了「回复」某条评论，或模型主动标记回复了某条已有评论，
            // 一律作为子回复挂在对应主评论（root parentId）下方，绝不单独开顶层评论回复别人
            let resolvedParentId: string | undefined;
            let resolvedReplyToName: string | undefined;
            if (paragraphCommentReplyTarget) {
                resolvedParentId = paragraphCommentReplyTarget.parentId;
                resolvedReplyToName = paragraphCommentReplyTarget.authorName;
            } else if (
                typeof replyResult.replyToCommentIndex === "number" &&
                rawExistingComments[replyResult.replyToCommentIndex]
            ) {
                const targetAnnotation = rawExistingComments[replyResult.replyToCommentIndex];
                const targetMeta = existingComments[replyResult.replyToCommentIndex];
                resolvedParentId = targetAnnotation.parentId || targetAnnotation.id;
                resolvedReplyToName = targetMeta.authorName;
            }

            const newComment: ReadingAnnotation = {
                id: `ra_cmt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                bookId: book.id,
                chapterIndex: cIdx,
                paragraphIndex: pIdx,
                characterId: companionId,
                characterName: companion.name,
                content: replyResult.content,
                createdAt: new Date().toISOString(),
                authorType: "character",
                annotationKind: "comment",
                ...(resolvedParentId
                    ? {
                        parentId: resolvedParentId,
                        replyToName: resolvedReplyToName,
                    }
                    : {}),
            };
            await saveAnnotation(newComment);
            appendReadingAnnotationMemos(toAnnotationMemos([newComment]));
            setAnnotations((prev) => [...prev, newComment]);
            if (paragraphCommentReplyTarget) {
                setParagraphCommentReplyTarget(null);
            }
        } catch (err) {
            console.error("[Reading] Companion paragraph comment error:", err);
            setAnnotationError(`段评生成失败: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setGeneratingParagraphComment(false);
        }
    };

    /** 手动改批注。记忆区那条要一起改，否则角色嘴上记得的还是旧话。 */
    const saveEditedAnnotation = async () => {
        if (!editingAnnotation) return;
        const content = editingText.trim();
        if (!content || content === editingAnnotation.content) { setEditingAnnotation(null); return; }
        const updated = { ...editingAnnotation, content };
        await saveAnnotation(updated);
        updateReadingAnnotationMemoContent(updated.id, content);
        setAnnotations(prev => prev.map(item => (item.id === updated.id ? updated : item)));
        setEditingAnnotation(null);
        setEditingText("");
    };

    // 批注块（翻页与滚动模式共用）：长按呼出 编辑/复制/删除 菜单
    const renderAnnotationItem = (annotation: ReadingAnnotation) => (
        <div
            key={annotation.id}
            // 菜单挂在卡片下沿外面，不抬层就会被下一张批注卡片盖住
            className={`reading-annotation reading-annotation-interactive${activeAnnotationId === annotation.id ? " is-menu-open" : ""}`}
            data-author={annotation.authorType === "user" ? "user" : "character"}
            data-no-nav="true"
            onPointerDown={() => {
                longPressTimer.current = setTimeout(() => {
                    setActiveMessageId(null);
                    setActiveAnnotationId(annotation.id);
                }, 500);
            }}
            onPointerUp={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onPointerCancel={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onPointerLeave={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current); }}
            onClick={(e) => {
                e.stopPropagation();
                if (activeAnnotationId && activeAnnotationId !== annotation.id) setActiveAnnotationId(null);
            }}
        >
            <span className="reading-annotation-name">
                {annotation.authorType === "user" ? userDisplayName : annotation.characterName}
            </span>
            <ReadingAnnotationContent
                text={annotation.content}
                bilingualEnabled={bilingualTranslationEnabled}
                expanded={isAnnotationTranslationExpanded(annotation.id)}
                onToggle={() => handleAnnotationTranslationToggle(annotation.id)}
            />
            {activeAnnotationId === annotation.id && (
                <div className="ctx-menu reading-annotation-menu" onClick={(e) => e.stopPropagation()}>
                    <button
                        onClick={() => {
                            setEditingAnnotation(annotation);
                            setEditingText(annotation.content);
                            setActiveAnnotationId(null);
                        }}
                        className="ctx-menu-btn"
                    >
                        编辑
                    </button>
                    <button
                        onClick={() => {
                            copyToClipboard(annotation.content);
                            setActiveAnnotationId(null);
                        }}
                        className="ctx-menu-btn"
                    >
                        复制
                    </button>
                    <button
                        onClick={() => { void handleDeleteReadingAnnotation(annotation.id); }}
                        className="ctx-menu-btn ctx-menu-btn-danger"
                    >
                        删除
                    </button>
                </div>
            )}
        </div>
    );

    const marksByParagraph = useMemo(() => {
        const map = new Map<string, ReadingMark[]>();
        for (const mark of marks) {
            const key = `${mark.chapterIndex}:${mark.paragraphIndex}`;
            map.set(key, [...(map.get(key) || []), mark]);
        }
        return map;
    }, [marks]);

    /** 把一段纯文本里的行内小图标标记（\uFFFCico:N\uFFFC）渲染成真实的 <img> 角标 */
    const renderTextSliceWithIcons = (slice: string, keyPrefix: string): React.ReactNode => {
        if (!slice.includes("￼ico:")) return slice;
        const parts = splitTextByInlineIcons(slice);
        return parts.map((part, idx) => {
            if (part.type === "text") return part.text;
            const url = inlineImageUrls[part.index];
            return url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    key={`${keyPrefix}-ico-${idx}`}
                    src={url}
                    alt=""
                    className="reading-inline-icon"
                />
            ) : null;
        });
    };

    /** 缓存每个段落按句末标点拆分出的单句列表，供单点句子交互使用 */
    const sentencesByParagraph = useMemo(() => {
        const map = new Map<string, ReturnType<typeof splitParagraphIntoSentences>>();
        for (const ch of chapters) {
            ch.paragraphs.forEach((p, pIdx) => {
                if (!p || parseReadingImageMarker(p)) return;
                map.set(`${ch.index}:${pIdx}`, splitParagraphIntoSentences(p));
            });
        }
        return map;
    }, [chapters]);

    /** 把一段范围 [sliceFrom, sliceTo) 内部的高亮/划线渲染出来 */
    const renderRangeWithMarks = (
        lineText: string,
        lineStart: number,
        sliceFrom: number,
        sliceTo: number,
        paragraphMarks: ReadingMark[],
        keyPrefix: string,
    ): React.ReactNode => {
        const hits = paragraphMarks
            .filter((mark) => mark.start < sliceTo && mark.end > sliceFrom)
            .sort((a, b) => a.start - b.start);
        if (hits.length === 0) {
            return renderTextSliceWithIcons(lineText.slice(sliceFrom - lineStart, sliceTo - lineStart), keyPrefix);
        }
        const nodes: React.ReactNode[] = [];
        let cursor = sliceFrom;
        hits.forEach((mark, i) => {
            const from = Math.max(cursor, mark.start);
            const to = Math.min(sliceTo, mark.end);
            if (from > cursor) {
                nodes.push(
                    renderTextSliceWithIcons(
                        lineText.slice(cursor - lineStart, from - lineStart),
                        `${keyPrefix}-pre-${i}`,
                    ),
                );
            }
            if (to > from) {
                nodes.push(
                    <span
                        key={`${keyPrefix}-${mark.id}-${i}`}
                        className="reading-mark"
                        data-style={mark.style}
                        data-author={mark.authorType === "character" ? "character" : "user"}
                        data-mark-id={mark.id}
                    >
                        {renderTextSliceWithIcons(
                            lineText.slice(from - lineStart, to - lineStart),
                            `${keyPrefix}-mk-${i}`,
                        )}
                    </span>,
                );
                cursor = to;
            }
        });
        if (cursor < sliceTo) {
            nodes.push(
                renderTextSliceWithIcons(
                    lineText.slice(cursor - lineStart, sliceTo - lineStart),
                    `${keyPrefix}-tail`,
                ),
            );
        }
        return nodes;
    };

    /** 把一段范围 [sliceFrom, sliceTo) 按当前激活的字符选区（sentenceMenu）与荧光笔/划线渲染为片段，
     *  让选区底色精确按字生效（拖动手柄缩小或扩大范围时只高亮选中的字，不再整句高亮）。 */
    const renderRangeWithActiveSelection = (
        lineText: string,
        lineStart: number,
        sliceFrom: number,
        sliceTo: number,
        paragraphMarks: ReadingMark[],
        activeRange: { start: number; end: number } | null,
        keyPrefix: string,
    ): React.ReactNode => {
        if (!activeRange || activeRange.start >= sliceTo || activeRange.end <= sliceFrom) {
            return renderRangeWithMarks(lineText, lineStart, sliceFrom, sliceTo, paragraphMarks, keyPrefix);
        }
        const selFrom = Math.max(sliceFrom, activeRange.start);
        const selTo = Math.min(sliceTo, activeRange.end);
        const parts: React.ReactNode[] = [];
        if (selFrom > sliceFrom) {
            parts.push(
                renderRangeWithMarks(lineText, lineStart, sliceFrom, selFrom, paragraphMarks, `${keyPrefix}-pre`),
            );
        }
        if (selTo > selFrom) {
            parts.push(
                <span key={`${keyPrefix}-sel`} className="reading-sentence is-selected">
                    {renderRangeWithMarks(lineText, lineStart, selFrom, selTo, paragraphMarks, `${keyPrefix}-in`)}
                </span>,
            );
        }
        if (selTo < sliceTo) {
            parts.push(
                renderRangeWithMarks(lineText, lineStart, selTo, sliceTo, paragraphMarks, `${keyPrefix}-post`),
            );
        }
        return parts;
    };

    /** 按「。」「？」「！」拆分出的句子包裹每行正文，并把落在本行区间内的荧光笔/划线渲染为片段 */
    const renderLineContent = (item: Extract<TxtPageItem, { kind: "line" }>) => {
        const lineStart = item.charStart ?? 0;
        const lineEnd = lineStart + item.text.length;
        const pKey = `${item.chapterIndex}:${item.paragraphIndex}`;
        const paragraphMarks = marksByParagraph.get(pKey) || [];
        const activeRange =
            sentenceMenu !== null &&
            sentenceMenu.chapterIndex === item.chapterIndex &&
            sentenceMenu.paragraphIndex === item.paragraphIndex
                ? { start: sentenceMenu.start, end: sentenceMenu.end }
                : null;
        const sentenceSpans = (sentencesByParagraph.get(pKey) || []).filter(
            (span) => span.start < lineEnd && span.end > lineStart,
        );
        if (sentenceSpans.length === 0) {
            return renderRangeWithActiveSelection(item.text, lineStart, lineStart, lineEnd, paragraphMarks, activeRange, `L${lineStart}`);
        }

        const nodes: React.ReactNode[] = [];
        let cursor = lineStart;
        sentenceSpans.forEach((span, idx) => {
            const from = Math.max(cursor, span.start);
            const to = Math.min(lineEnd, span.end);
            if (from > cursor) {
                nodes.push(
                    renderRangeWithActiveSelection(
                        item.text,
                        lineStart,
                        cursor,
                        from,
                        paragraphMarks,
                        activeRange,
                        `L${lineStart}-gap-${idx}`,
                    ),
                );
            }
            if (to > from) {
                nodes.push(
                    <span
                        key={`sent-${span.start}-${idx}`}
                        className="reading-sentence"
                        data-sentence-chapter={item.chapterIndex}
                        data-sentence-paragraph={item.paragraphIndex}
                        data-sentence-start={span.start}
                        data-sentence-end={span.end}
                        data-no-nav="true"
                    >
                        {renderRangeWithActiveSelection(
                            item.text,
                            lineStart,
                            from,
                            to,
                            paragraphMarks,
                            activeRange,
                            `L${lineStart}-s-${idx}`,
                        )}
                    </span>,
                );
                cursor = to;
            }
        });
        if (cursor < lineEnd) {
            nodes.push(
                renderRangeWithActiveSelection(
                    item.text,
                    lineStart,
                    cursor,
                    lineEnd,
                    paragraphMarks,
                    activeRange,
                    `L${lineStart}-end`,
                ),
            );
        }
        return nodes;
    };

    const renderLine = (item: Extract<TxtPageItem, { kind: "line" }>, key: number | string) => {
        const bubbleCount = item.annotationCount ?? 0;
        const isModalOpen =
            activeParagraphCommentModal !== null &&
            activeParagraphCommentModal.chapterIndex === item.chapterIndex &&
            activeParagraphCommentModal.paragraphIndex === item.paragraphIndex;
        // 刚从批注列表跳过来的那一段：界面上闪一下作为落点提示
        const isJumpFlash =
            jumpFlash !== null &&
            jumpFlash.chapterIndex === item.chapterIndex &&
            jumpFlash.paragraphIndex === item.paragraphIndex;
        return (
            <p
                key={key}
                className={`reading-line${item.indent ? " reading-line-indent" : ""}${item.segEnd ? " reading-line-seg-end" : ""}${isJumpFlash ? " is-jump-flash" : ""}`}
                // 落点提示直接写在行内：这里只有一行要变色，不值得为它加一条全局样式。
                // 2 秒后状态清掉，靠 transition 淡出，不会「啪」一下消失。
                style={{
                    backgroundColor: isJumpFlash ? "rgba(255, 206, 84, 0.34)" : "transparent",
                    borderRadius: 4,
                    transition: "background-color 700ms ease",
                }}
                data-chapter={item.chapterIndex}
                data-paragraph={item.paragraphIndex}
                data-charstart={item.charStart ?? 0}
            >
                {renderLineContent(item)}
                {bubbleCount > 0 && (
                    <button
                        type="button"
                        className="reading-annotation-bubble"
                        data-count={bubbleCount}
                        data-open={isModalOpen ? "" : undefined}
                        data-no-nav="true"
                        aria-label={`查看${bubbleCount}条段评`}
                        aria-expanded={isModalOpen}
                        style={{ ["--bubble-count" as "--bubble-count"]: `"${bubbleCount}"` } as CSSProperties}
                        onPointerDown={(e) => e.stopPropagation()}
                        onPointerUp={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            openParagraphCommentDialog(item.chapterIndex, item.paragraphIndex);
                        }}
                    >
                        <svg viewBox="3 2 29 22" aria-hidden="true">
                            <path d="M6.74 18.11A13.4 9.2 0 1 1 10.3 20.17L4.6 22.2Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round" />
                        </svg>
                    </button>
                )}
            </p>
        );
    };

    /** 一张正文插图。图还没读出来时先占住位置（有原始尺寸就按比例占，且不放大超过原图尺寸），
     *  否则图片加载完会把正文顶得一跳一跳。 */
    const renderImageItem = (image: ReadingImageRef, key: number | string) => {
        const url = inlineImageUrls[image.index];
        const hasSize = image.width > 0 && image.height > 0;
        const ratio = hasSize ? `${image.width} / ${image.height}` : "5 / 3";
        return (
            <div
                key={key}
                className="reading-inline-image"
                style={{
                    aspectRatio: ratio,
                    ...(hasSize ? { maxWidth: `${image.width}px` } : {}),
                }}
            >
                {url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={url} alt="" />
                    : <span className="reading-inline-image-hint">插图</span>}
            </div>
        );
    };

    const renderStaticPage = (items: TxtPageItem[]) => (
        <div className="reading-page-content">
            {items.map((item, i) =>
                item.kind === "gap"
                    ? <div key={i} className="reading-line-gap" />
                    : item.kind === "annotation"
                        ? <div key={i} className="reading-annotation" data-author={item.annotation.authorType === "user" ? "user" : "character"}>
                            <span className="reading-annotation-name">
                                {item.annotation.authorType === "user" ? userDisplayName : item.annotation.characterName}
                            </span>
                            <span className="reading-annotation-text">{item.annotation.content}</span>
                        </div>
                        : item.kind === "image"
                            ? renderImageItem(item.image, i)
                            : renderLine(item, i)
            )}
        </div>
    );

    const totalParagraphs = useMemo(
        () => chapters.reduce((sum, chapter) => sum + chapter.paragraphs.length, 0),
        [chapters],
    );
    const charPickerBottom = showChat ? (chatExpanded ? 284 : 76) : 64;
    const paragraphRefs = useMemo(() => buildParagraphRefsFromChapters(chapters), [chapters]);
    const pdfRenderAnnotations = useMemo(() => {
        if (!isPdf) return annotations;
        const absoluteIndexMap = new Map(
            paragraphRefs.map((item) => [`${item.chapterIndex}:${item.paragraphIndex}`, item.absoluteIndex] as const),
        );
        return annotations
            .map((annotation) => {
                const absoluteIndex = absoluteIndexMap.get(`${annotation.chapterIndex}:${annotation.paragraphIndex}`);
                if (absoluteIndex === undefined) return null;
                return {
                    ...annotation,
                    paragraphIndex: absoluteIndex,
                };
            })
            .filter((annotation): annotation is ReadingAnnotation => annotation !== null);
    }, [annotations, isPdf, paragraphRefs]);

    const pdfAnnotationChapter: BookChapter | undefined = useMemo(() => {
        if (!isPdf || chapters.length === 0) return undefined;
        return {
            id: `${book.id}_pdf_all`,
            bookId: book.id,
            index: 0,
            title: book.title,
            paragraphs: paragraphRefs.map((item) => item.text),
            paragraphPages: paragraphRefs.map((item) => item.pageNum ?? 1),
            paragraphYPositions: paragraphRefs.map((item) => item.yRatio ?? 0.5),
        };
    }, [book.id, book.title, chapters.length, isPdf, paragraphRefs]);

    const clampBatchSize = useCallback((value: number) => {
        const fallback = isPdf ? 5 : 50;
        if (!Number.isFinite(value)) return fallback;
        const min = 1;
        const max = isPdf ? 30 : 200;
        return Math.min(max, Math.max(min, Math.round(value)));
    }, [isPdf]);

    const isAnnotationTranslationExpanded = useCallback((annotationId: string) => {
        return annotationTranslationOverrides[annotationId] ?? defaultTranslationExpanded;
    }, [annotationTranslationOverrides, defaultTranslationExpanded]);

    const handleAnnotationTranslationToggle = useCallback((annotationId: string) => {
        setAnnotationTranslationOverrides((prev) => {
            const current = prev[annotationId] ?? defaultTranslationExpanded;
            return { ...prev, [annotationId]: !current };
        });
        if (!isPdf) {
            setTxtLayoutVersion((version) => version + 1);
        }
    }, [defaultTranslationExpanded, isPdf]);

    // Find or create chat session for companion
    const getSession = useCallback((): ChatSession | null => {
        if (!companionId) return null;
        // 找不到与角色的一对一会话时自动创建（否则发送会静默无响应）
        return createOrGetSession(companionId);
    }, [companionId]);


    // Load book data
    useEffect(() => {
        // 清空上一本书遗留的滚动定位状态
        initialScrollFractionRef.current = null;
        pendingScrollFractionRef.current = null;
        pendingScrollActionRef.current = null;
        shiftCooldownRef.current = false;
        scrollPositionedKeyRef.current = "";
        setChaptersLoaded(false);
        setLoadFailed(false);
        (async () => {
          try {
            // 后台待久了书库连接可能坏了：先探一下，坏了就重连
            await ensureReadingDbAlive();
            let chs = await loadChapters(book.id);
            if (!isPdf && chs.length === 0) {
                const rawFile = await loadRawFileBlob(book.id);
                if (rawFile && rawFile.size > 0) {
                    try {
                        const parsed = book.format === "txt"
                            ? parseTxtContent(decodeTxtArrayBuffer(await rawFile.arrayBuffer(), loadReadingInteractionConfig().txtEncoding).text, book.title)
                            : book.format === "mobi"
                                ? await parseMobiFile(await rawFile.arrayBuffer(), book.title)
                                : await parseEpubFile(await rawFile.arrayBuffer(), book.title);
                        const rebuiltChapters: BookChapter[] = parsed.chapters.map((chapter, index) => ({
                            id: `${book.id}_ch${index}`,
                            bookId: book.id,
                            index,
                            title: chapter.title,
                            paragraphs: chapter.paragraphs,
                        }));
                        if (rebuiltChapters.length > 0) {
                            await saveChapters(book.id, rebuiltChapters);
                            await updateBook({
                                ...book,
                                title: parsed.title || book.title,
                                author: parsed.author,
                                totalChapters: rebuiltChapters.length,
                            });
                            chs = rebuiltChapters;
                        }
                    } catch (err) {
                        console.error("[Reading] Failed to rebuild text chapters from raw file:", err);
                    }
                }
            }
            setChapters(chs);
            const progress = await loadProgress(book.id);
            if (progress) {
                const safeChapterIndex = chs.length > 0
                    ? Math.max(0, Math.min(chs.length - 1, progress.chapterIndex))
                    : 0;
                setChapterIndex(safeChapterIndex);
                setCompanionId(progress.companionCharacterId || null);
                if (isPdf) {
                    // PDF 恢复：scrollPosition 存的是「当前页 - 1」。
                    // 同时设置 pdfCurrentPage（避免跳转前保存逻辑把它覆盖回第 1 页）
                    // 与 pdfJumpPage（让 PdfPageRenderer 渲染完成后滚到该页）。
                    const restoredPage = Math.max(1, Math.round((progress.scrollPosition ?? 0) + 1));
                    setPdfCurrentPage(restoredPage);
                    setPdfJumpPage(restoredPage);
                } else if (progress.readingMode === "scroll") {
                    // 滚动模式：scrollPosition 存的是章节内滚动比例(0-1)
                    initialScrollFractionRef.current = Math.max(0, Math.min(1, progress.scrollPosition || 0));
                } else {
                    setTxtPage(Math.max(0, progress.scrollPosition || 0));
                }
            }
            // Default companion: first contact
            if (!progress?.companionCharacterId && enrichedContacts.length > 0) {
                setCompanionId(enrichedContacts[0].characterId);
            }
            if (!progress && !isPdf) setTxtPage(0);
            setBookmarks(await loadBookmarks(book.id).catch(() => []));
            setChaptersLoaded(true);
          } catch (error) {
            console.error("[Reading] 打开书失败：", error);
            setLoadFailed(true);
          }
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [book.id, loadAttempt]);

    useEffect(() => {
        if (chapters.length === 0) return;
        if (chapterIndex >= 0 && chapterIndex < chapters.length) return;
        setChapterIndex(Math.max(0, Math.min(chapters.length - 1, chapterIndex)));
    }, [chapterIndex, chapters.length]);

    useEffect(() => {
        if (!isPdf || pdfTotalPages <= 0 || chapters.length === 0) return;
        const expectedCount = Math.max(1, Math.ceil(pdfTotalPages / PDF_PAGES_PER_CHAPTER));
        const needsSkeletonRefresh =
            chapters.length !== expectedCount ||
            chapters.some((chapter, index) => {
                const startPage = index * PDF_PAGES_PER_CHAPTER + 1;
                const endPage = Math.min(startPage + PDF_PAGES_PER_CHAPTER - 1, pdfTotalPages);
                return chapter.pageStart !== startPage || chapter.pageEnd !== endPage;
            });
        if (!needsSkeletonRefresh) return;

        const nextChapters: BookChapter[] = Array.from({ length: expectedCount }, (_, index) => {
            const startPage = index * PDF_PAGES_PER_CHAPTER + 1;
            const endPage = Math.min(startPage + PDF_PAGES_PER_CHAPTER - 1, pdfTotalPages);
            const existing = chapters.find((chapter) => chapter.index === index);
            return {
                id: existing?.id || `${book.id}_ch${index}`,
                bookId: book.id,
                index,
                title: buildPdfChunkTitle(startPage, endPage),
                paragraphs: existing?.paragraphs || [],
                paragraphPages: existing?.paragraphPages,
                paragraphYPositions: existing?.paragraphYPositions,
                pageStart: startPage,
                pageEnd: endPage,
            };
        });

        void saveChapters(book.id, nextChapters).then(() => {
            setChapters(nextChapters);
        }).catch((err) => {
            console.error("[Reading] PDF chapter skeleton error:", err);
        });
    }, [book.id, chapters, isPdf, pdfTotalPages]);

    // Load annotations for current scope
    useEffect(() => {
        (async () => {
            if (isPdf) {
                const groups = await Promise.all(chapters.map((chapter) => loadAnnotations(book.id, chapter.index)));
                setAnnotations(groups.flat());
                return;
            }
            // 滚动模式：加载窗口内所有章节（上一章+当前章+下一章）的批注，
            // 否则交界处批注缺失，且窗口平移时整组替换导致批注「时有时无」
            const chapterIndexes = isScrollMode
                ? [...new Set(windowChapters.map((c) => c.index))]
                : [chapterIndex];
            const groups = await Promise.all(chapterIndexes.map((idx) => loadAnnotations(book.id, idx)));
            setAnnotations(groups.flat());
        })();
    }, [book.id, isPdf, isScrollMode, windowChapters]);

    // Load reading-discuss chat messages
    const refreshChatMessages = useCallback(() => {
        const session = getSession();
        if (!session) { setChatMessages([]); return; }
        const msgs = loadChatMessages(session.id)
            .filter(isReadingDiscussMessage)
            .slice(-30);
        setChatMessages(msgs);
    }, [getSession]);

    useEffect(() => { refreshChatMessages(); }, [refreshChatMessages, companionId]);

    const [annotationError, setAnnotationError] = useState<string | null>(null);
    const loadExistingAnnotationsForItems = useCallback(async (items: ParagraphRef[]) => {
        const chapterIndexes = [...new Set(items.map((item) => item.chapterIndex))];
        const itemKeys = new Set(items.map((item) => `${item.chapterIndex}:${item.paragraphIndex}`));
        const groups = await Promise.all(chapterIndexes.map((idx) => loadAnnotations(book.id, idx)));
        return groups
            .flat()
            .filter((annotation) => itemKeys.has(`${annotation.chapterIndex}:${annotation.paragraphIndex}`))
            // 只把「批注」当已有批注给模型看。段评是段落下面那一串评论（还能互相回复），
            // 混进批注历史里模型会以为「这段已经批注过了」，写出来的就不是批注。
            .filter((annotation) => !isCommentAnnotation(annotation));
    }, [book.id]);

    const ensurePdfPageRangeParsed = useCallback(async (startPage: number, endPage: number): Promise<BookChapter[]> => {
        if (!isPdf || chapters.length === 0) return chapters;

        const targetStart = Math.max(1, startPage);
        const targetEnd = Math.max(targetStart, endPage);
        const missing = chapters.filter((chapter) => {
            const chapterStart = chapter.pageStart ?? (chapter.index * PDF_PAGES_PER_CHAPTER + 1);
            const chapterEnd = chapter.pageEnd ?? (chapterStart + PDF_PAGES_PER_CHAPTER - 1);
            return chapter.paragraphs.length === 0 && chapterEnd >= targetStart && chapterStart <= targetEnd;
        });
        if (missing.length === 0) return chapters;

        const rawData = await loadRawFileBlob(book.id);
        if (!rawData || rawData.size === 0) {
            throw new Error("PDF 文件未找到或为空");
        }

        const parseStart = Math.min(...missing.map((chapter) => chapter.pageStart ?? (chapter.index * PDF_PAGES_PER_CHAPTER + 1)));
        const parseEnd = Math.max(...missing.map((chapter) => chapter.pageEnd ?? ((chapter.index + 1) * PDF_PAGES_PER_CHAPTER)));
        const parsed = await parsePdfPageRange(rawData, {
            startPage: parseStart,
            endPage: parseEnd,
            fileName: book.title,
        });

        const updates: BookChapter[] = parsed.chunks.map((chunk) => {
            const chunkIndex = Math.floor((chunk.startPage - 1) / PDF_PAGES_PER_CHAPTER);
            const existing = chapters[chunkIndex];
            return {
                id: existing?.id || `${book.id}_ch${chunkIndex}`,
                bookId: book.id,
                index: chunkIndex,
                title: chunk.title,
                paragraphs: chunk.paragraphs,
                paragraphPages: chunk.pdfMeta.map((item) => item.pageNum),
                paragraphYPositions: chunk.pdfMeta.map((item) => item.yRatio),
                pageStart: chunk.startPage,
                pageEnd: chunk.endPage,
            };
        });

        await saveChapters(book.id, updates);
        const merged = chapters.map((chapter) => {
            const replacement = updates.find((item) => item.index === chapter.index);
            return replacement || chapter;
        });
        setChapters(merged);
        return merged;
    }, [book.id, chapters, isPdf]);

    const buildTxtBatchRequest = useCallback((size: number, mode: AnnotationBatchMode): AnnotationBatchRequest | null => {
        let minParagraphIndex: number;
        let maxParagraphIndex: number;

        if (isScrollMode) {
            // 滚动模式没有分页：以当前滚动比例估算「正在阅读」的段落窗口
            const total = currentChapter?.paragraphs.length || 0;
            if (total === 0) return null;
            const center = Math.round(Math.max(0, Math.min(1, scrollFraction)) * (total - 1));
            const half = Math.max(1, Math.ceil(size / 2));
            minParagraphIndex = Math.max(0, center - half);
            maxParagraphIndex = Math.min(total - 1, center + half);
        } else {
            const pageItems = txtPages[txtPage] || [];
            const visibleParagraphIndexes = [...new Set(
                pageItems
                    .filter((item): item is Extract<TxtPageItem, { kind: "line" | "annotation" }> => item.kind === "line" || item.kind === "annotation")
                    .map((item) => item.paragraphIndex),
            )].sort((a, b) => a - b);
            if (visibleParagraphIndexes.length === 0) return null;
            minParagraphIndex = visibleParagraphIndexes[0];
            maxParagraphIndex = visibleParagraphIndexes[visibleParagraphIndexes.length - 1];
        }

        const visibleRefs = paragraphRefs.filter((item) => item.chapterIndex === chapterIndex && item.paragraphIndex >= minParagraphIndex && item.paragraphIndex <= maxParagraphIndex);
        if (visibleRefs.length === 0) return null;

        const startCandidates: number[] = [];
        if (mode === "manual") {
            startCandidates.push(visibleRefs[0].absoluteIndex);
        } else if (mode === "auto-current") {
            startCandidates.push(Math.floor(visibleRefs[0].absoluteIndex / size) * size);
        } else {
            for (let start = Math.floor(visibleRefs[0].absoluteIndex / size) * size; start <= visibleRefs[visibleRefs.length - 1].absoluteIndex; start += size) {
                if (start >= visibleRefs[0].absoluteIndex && start <= visibleRefs[visibleRefs.length - 1].absoluteIndex) {
                    startCandidates.push(start);
                    break;
                }
            }
        }

        const startAbsoluteIndex = startCandidates[0];
        if (startAbsoluteIndex === undefined) return null;
        const items = paragraphRefs.slice(startAbsoluteIndex, startAbsoluteIndex + size).filter((item) => item.text.trim());
        if (items.length === 0) return null;

        return {
            key: `txt:${startAbsoluteIndex}:${size}`,
            title: `第${items[0].absoluteIndex + 1}-${items[items.length - 1].absoluteIndex + 1}段`,
            size,
            items,
        };
    }, [chapterIndex, currentChapter, isScrollMode, paragraphRefs, scrollFraction, txtPage, txtPages]);

    const getPdfBatchWindow = useCallback((size: number, mode: AnnotationBatchMode) => {
        const chapterMaxPage = Math.max(0, ...chapters.map((chapter) => chapter.pageEnd ?? 0));
        const refMaxPage = Math.max(0, ...paragraphRefs.map((item) => item.pageNum || 0));
        const maxPage = pdfTotalPages || chapterMaxPage || refMaxPage;
        if (maxPage <= 0) return null;
        const startPage = mode === "manual" ? pdfCurrentPage : Math.floor((pdfCurrentPage - 1) / size) * size + 1;
        if (mode === "auto" && pdfCurrentPage !== startPage) return null;
        const endPage = Math.min(maxPage, startPage + size - 1);
        return {
            key: `pdf:${startPage}:${size}`,
            title: `第${startPage}-${endPage}页`,
            size,
            startPage,
            endPage,
        };
    }, [chapters, paragraphRefs, pdfCurrentPage, pdfTotalPages]);

    const buildPdfBatchRequest = useCallback((size: number, mode: AnnotationBatchMode, refs: ParagraphRef[] = paragraphRefs): AnnotationBatchRequest | null => {
        const windowInfo = getPdfBatchWindow(size, mode);
        if (!windowInfo) return null;
        const items = refs.filter((item) => (item.pageNum || 0) >= windowInfo.startPage && (item.pageNum || 0) <= windowInfo.endPage && item.text.trim());
        if (items.length === 0) return null;

        return {
            key: windowInfo.key,
            title: windowInfo.title,
            size: windowInfo.size,
            items,
        };
    }, [getPdfBatchWindow, paragraphRefs]);

    const materializeBatchRequest = useCallback(async (size: number, mode: AnnotationBatchMode): Promise<AnnotationBatchRequest | null> => {
        if (!isPdf) return buildTxtBatchRequest(size, mode);

        const windowInfo = getPdfBatchWindow(size, mode);
        if (!windowInfo) return null;

        const mergedChapters = await ensurePdfPageRangeParsed(windowInfo.startPage, windowInfo.endPage);
        const refs = buildParagraphRefsFromChapters(mergedChapters);
        return buildPdfBatchRequest(size, mode, refs);
    }, [buildPdfBatchRequest, buildTxtBatchRequest, ensurePdfPageRangeParsed, getPdfBatchWindow, isPdf]);

    /** 对话框里那行「本次范围」。用的就是真正生成时的那套算法（buildTxtBatchRequest /
     *  getPdfBatchWindow），不是另算一遍，免得显示的范围和实际批注的范围对不上。 */
    const annotationRangePreview = useMemo(() => {
        if (!annotationDialogMode) return "";
        const size = clampBatchSize(Number(annotationBatchInput));
        const mode: AnnotationBatchMode = annotationDialogMode === "manual" ? "manual" : "auto-current";
        if (isPdf) {
            const window = getPdfBatchWindow(size, mode);
            return window ? window.title : "";
        }
        const request = buildTxtBatchRequest(size, mode);
        if (!request) return "";
        const startChapter = chapters[request.items[0].chapterIndex]?.title;
        const endChapter = chapters[request.items[request.items.length - 1].chapterIndex]?.title;
        const chapterHint = startChapter && endChapter && startChapter !== endChapter
            ? `（${startChapter} → ${endChapter}）`
            : startChapter ? `（${startChapter}）` : "";
        return `${request.title}${chapterHint}`;
    }, [annotationBatchInput, annotationDialogMode, buildTxtBatchRequest, chapters, clampBatchSize, getPdfBatchWindow, isPdf]);

    const executeBatchAnnotation = useCallback(async (request: AnnotationBatchRequest, options?: { force?: boolean }): Promise<boolean> => {
        if (!companionId) return false;
        const batchKey = `${book.id}:${companionId}:${request.key}`;
        if (!options?.force && generatedBatchesRef.current.has(batchKey)) return false;
        // 同步锁：同一时间只允许一个批注生成任务（auto/prefetch 竞态时后面的请求直接跳过，
        // 避免闭包里的 generating 旧值放行并发请求，导致同一批被重复生成）
        if (annotationInFlightRef.current) return false;
        // 同一批已在生成中：跳过（生成完成前 generatedBatchesRef 尚未写入，需用 in-flight 集合兜底）
        if (!options?.force && inFlightBatchesRef.current.has(batchKey)) return false;
        annotationInFlightRef.current = true;
        inFlightBatchesRef.current.add(batchKey);
        setGenerating(true);
        setAnnotationError(null);

        try {
            // 历史已有批注仅作为生成参考传入（generateAnnotationBatch 接收 existingAnnotations），
            // 不用于跳过：重新开启自动批注/重读书籍时，用户期望生成新的批注。
            // 「本次阅读体验内不重复」由 generatedBatchesRef（内存）保证。
            const existing = await loadExistingAnnotationsForItems(request.items);

            const { annotations: newAnnotations, marks: newMarks } = await withAnnotationRetry(
                () => generateAnnotationBatch(
                    book,
                    request.title,
                    request.items.map((item) => ({
                        chapterIndex: item.chapterIndex,
                        paragraphIndex: item.paragraphIndex,
                        text: item.text,
                    })),
                    existing,
                    companionId,
                ),
                readingConfig.annotationRetryCount > 0 ? readingConfig.annotationRetryCount : 0,
            );

            generatedBatchesRef.current.add(batchKey);

            // 角色顺手划的重点：只划线不写批注也算这一批有产出
            if (newMarks.length > 0) {
                newMarks.forEach(saveReadingMark);
                setMarks((prev) => {
                    const seen = new Set(prev.map(mark => mark.id));
                    return [...prev, ...newMarks.filter(mark => !seen.has(mark.id))];
                });
            }

            if (newAnnotations.length > 0) {
                await saveAnnotations(newAnnotations);
                appendReadingAnnotationMemos(toAnnotationMemos(newAnnotations));
                setAnnotations((prev) => {
                    const merged = new Map(prev.map((annotation) => [annotation.id, annotation]));
                    for (const annotation of newAnnotations) merged.set(annotation.id, annotation);
                    return [...merged.values()];
                });
            } else if (newMarks.length === 0) {
                // 解析失败、预设缺条目、接口报错现在都会抛出带原因的错误（见 generateAnnotationBatch），
                // 能走到这里就只剩一种情况：模型看完了，但这一批它没什么想说的。
                setAnnotationError(`${companion?.name || "AI"}这一批没有想写的批注（模型返回了「无批注」），可以换个范围再试`);
            }
            return true;
        } catch (err) {
            console.error("[Reading] Annotation error:", err);
            setAnnotationError(`批注失败: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        } finally {
            inFlightBatchesRef.current.delete(batchKey);
            annotationInFlightRef.current = false;
            setGenerating(false);
        }
    }, [book, companionId, loadExistingAnnotationsForItems, readingConfig.annotationRetryCount]);

    const openAnnotationDialog = (mode: AnnotationDialogMode) => {
        const nextSize = annotationBatchSize || (isPdf ? 5 : 50);
        setAnnotationBatchInput(String(nextSize));
        setAnnotationDialogMode(mode);
    };

    const handleAnnotationDialogConfirm = async () => {
        if (!annotationDialogMode) return;
        const size = clampBatchSize(Number(annotationBatchInput));
        setAnnotationBatchSize(size);
        setAnnotationBatchInput(String(size));

        if (annotationDialogMode === "auto") {
            setAnnotationDialogMode(null);
            if (autoAnnotate) {
                setAutoAnnotate(false);
                return;
            }
            setAutoAnnotate(true);
            generatedBatchesRef.current.clear();
            prefetchedBatchStartRef.current = -1; // 新的阅读体验：预生成触发标记一并重置
            const request = await materializeBatchRequest(size, "auto-current");
            if (request) await executeBatchAnnotation(request);
            return;
        }

        const request = await materializeBatchRequest(size, "manual");
        setAnnotationDialogMode(null);
        if (!request) return;
        generatedBatchesRef.current.delete(`${book.id}:${companionId || ""}:${request.key}`);
        await executeBatchAnnotation(request, { force: true });
    };

    /** 打开手动预批注对话框：默认预生成「当前页起一个批次」的范围 */
    const openPdfPrefetchDialog = () => {
        const start = Math.max(1, pdfCurrentPage || 1);
        const batch = Math.max(1, annotationBatchSize || 5);
        const end = Math.min(pdfTotalPages || (start + batch - 1), start + batch - 1);
        setAnnotationError(null);
        setPdfPrefetchStartInput(String(start));
        setPdfPrefetchEndInput(String(end));
        setPdfPrefetchDialogOpen(true);
    };

    /** 手动预批注：按用户自定义的页码范围，预解析文本层并立即生成批注 */
    const handlePdfManualPrefetch = async () => {
        if (!companionId) {
            setAnnotationError("请先选择共读角色");
            return;
        }
        const total = Math.max(1, pdfTotalPages || 1);
        const start = Math.max(1, Math.min(total, Math.round(Number(pdfPrefetchStartInput) || 1)));
        const end = Math.max(start, Math.min(total, Math.round(Number(pdfPrefetchEndInput) || start)));
        if (end - start + 1 > MAX_MANUAL_PDF_PREFETCH_PAGES) {
            setAnnotationError(`一次最多预批注 ${MAX_MANUAL_PDF_PREFETCH_PAGES} 页，请缩小页码范围`);
            return;
        }
        setAnnotationError(null);
        setPdfPrefetchDialogOpen(false);
        try {
            // 预解析指定范围的文本层（渲染已解耦，不会重建页面）
            const merged = await ensurePdfPageRangeParsed(start, end);
            const refs = buildParagraphRefsFromChapters(merged);
            const items = refs.filter((item) => (item.pageNum || 0) >= start && (item.pageNum || 0) <= end && item.text.trim());
            if (items.length === 0) {
                setAnnotationError("所选范围没有可批注的文本");
                return;
            }
            const request: AnnotationBatchRequest = {
                key: `pdf:${start}:${end}:manual`,
                title: `第${start}-${end}页`,
                size: end - start + 1,
                items,
            };
            await executeBatchAnnotation(request, { force: true });
        } catch (err) {
            console.error("[Reading] PDF manual prefetch error:", err);
            setAnnotationError(`预批注失败: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    const openNavigationDialog = () => {
        setShowNavigationDialog(true);
    };

    const copyToClipboard = useCallback((text: string) => {
        const fallbackCopy = () => {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            try { document.execCommand("copy"); } catch {}
            document.body.removeChild(ta);
        };
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(fallbackCopy);
        } else {
            fallbackCopy();
        }
    }, []);

    const closeReadingMessageMenu = useCallback(() => {
        setReadingMessageMenu(null);
        setActiveMessageId(null);
    }, []);

    const cancelReadingMessageLongPress = useCallback(() => {
        readingMessagePressStartRef.current = null;
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = undefined;
        }
    }, []);

    const handleReadingMessagePointerDown = useCallback((event: React.PointerEvent<HTMLElement>, msg: ChatMessage) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        readingMessagePressStartRef.current = { x: event.clientX, y: event.clientY };
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
        longPressTimer.current = setTimeout(() => {
            setActiveAnnotationId(null);
            setActiveMessageId(msg.id);
            setReadingMessageMenu({ messageId: msg.id, x: event.clientX, y: event.clientY });
            longPressTimer.current = undefined;
        }, 500);
    }, []);

    const handleReadingMessagePointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const start = readingMessagePressStartRef.current;
        if (!start) return;
        const dx = Math.abs(event.clientX - start.x);
        const dy = Math.abs(event.clientY - start.y);
        if (dx > 10 || dy > 10) cancelReadingMessageLongPress();
    }, [cancelReadingMessageLongPress]);

    const getReadingMessageMenuStyle = useCallback((menu: { x: number; y: number }): React.CSSProperties => {
        const margin = 12;
        const estimatedWidth = 168;
        const estimatedHeight = 42;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const left = Math.min(
            Math.max(menu.x - estimatedWidth / 2, margin),
            Math.max(margin, viewportWidth - estimatedWidth - margin),
        );
        const top = menu.y > viewportHeight - estimatedHeight - 24
            ? Math.max(margin, menu.y - estimatedHeight - 12)
            : Math.min(menu.y + 12, viewportHeight - estimatedHeight - margin);

        return {
            left,
            top,
        };
    }, []);

    const handleEditDiscussMessageStart = useCallback((msg: ChatMessage) => {
        setEditingDiscussMessage(msg);
        setEditingDiscussContent(msg.content);
        closeReadingMessageMenu();
    }, [closeReadingMessageMenu]);

    const handleSaveDiscussMessageEdit = useCallback(() => {
        if (!editingDiscussMessage) return;
        const nextContent = editingDiscussContent.trim();
        if (!nextContent) return;
        editChatMessage(editingDiscussMessage.id, nextContent);
        setChatMessages((prev) => prev.map((msg) => msg.id === editingDiscussMessage.id ? { ...msg, content: nextContent } : msg));
        setEditingDiscussMessage(null);
        setEditingDiscussContent("");
    }, [editingDiscussContent, editingDiscussMessage]);

    useEffect(() => {
        if (!showChat || !chatExpanded) {
            setReadingMessageMenu(null);
            setActiveMessageId(null);
        }
    }, [showChat, chatExpanded]);

    // 共读讨论悬浮窗展开时自动滚动到最新消息。
    // 仅在「打开」时滚动一次、无持续吸附——用户随后自由滑动即可打断，不会被拉回。
    useEffect(() => {
        if (!showChat || !chatExpanded) return;
        if (readingConfig.chatAutoScrollOnOpen === false) return;
        const el = chatListRef.current;
        if (!el) return;
        let raf1 = 0;
        let raf2 = 0;
        // 等展开动画与内容渲染稳定后再滚到底
        raf1 = window.requestAnimationFrame(() => {
            raf2 = window.requestAnimationFrame(() => {
                el.scrollTop = el.scrollHeight;
            });
        });
        return () => {
            window.cancelAnimationFrame(raf1);
            window.cancelAnimationFrame(raf2);
        };
    }, [showChat, chatExpanded, readingConfig.chatAutoScrollOnOpen]);

    const handleDeleteReadingAnnotation = useCallback(async (annotationId: string) => {
        // 级联收集：删除一条段评时，其下挂着的所有子回复（含多级回复）必须一并删除，
        // 避免残留成孤儿回复隐藏起来或串到新段评下方
        const toDeleteIds = new Set<string>([annotationId]);
        let added = true;
        while (added) {
            added = false;
            for (const item of annotations) {
                if (item.parentId && toDeleteIds.has(item.parentId) && !toDeleteIds.has(item.id)) {
                    toDeleteIds.add(item.id);
                    added = true;
                }
            }
        }
        await Promise.all([...toDeleteIds].map((id) => deleteAnnotation(id)));
        toDeleteIds.forEach((id) => deleteReadingAnnotationMemo(id));
        setAnnotations((prev) => prev.filter((annotation) => !toDeleteIds.has(annotation.id)));
        setPanelAnnotations((prev) => prev.filter((annotation) => !toDeleteIds.has(annotation.id)));
        setParagraphCommentReplyTarget((prev) => (
            prev && (toDeleteIds.has(prev.id) || toDeleteIds.has(prev.parentId)) ? null : prev
        ));
        setActiveAnnotationId(null);
    }, [annotations]);

    const handlePdfJumpComplete = useCallback(() => {
        setPdfJumpPage(undefined);
    }, []);

    const handleNavChapterClick = (index: number) => {
        if (isPdf) {
            const chapter = chapters[index];
            const firstPage = chapter?.pageStart ?? chapter?.paragraphPages?.[0] ?? 1;
            setChapterIndex(index);
            setPdfJumpPage(firstPage);
        } else {
            goToChapter(index);
        }
        setShowNavigationDialog(false);
    };

    const handleNavPageSlider = (value: number) => {
        if (isPdf) {
            setPdfJumpPage(value);
        } else {
            if (chapters.length === 0) return;

            const maxSliderValue = chapters.length + 1;
            const boundedValue = Math.max(1, Math.min(maxSliderValue, value));
            const rawPosition = boundedValue - 1;
            const targetChapterIndex = Math.min(chapters.length - 1, Math.floor(rawPosition));
            const pageFraction = Math.max(0, Math.min(1, rawPosition - targetChapterIndex));

            if (targetChapterIndex === chapterIndex) {
                if (isScrollMode) {
                    scrollToChapterFraction(pageFraction, chapterIndex);
                } else {
                    pendingTxtPageFractionRef.current = null;
                    setTxtPage(Math.round(pageFraction * Math.max(0, txtTotalPages - 1)));
                }
            } else {
                pendingTxtPageFractionRef.current = pageFraction;
                pendingScrollFractionRef.current = pageFraction;
                setChapterIndex(targetChapterIndex);
                setTxtPage(0);
            }
        }
    };

    const handleReadingSurfaceClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest("button, input, select, textarea, a, [data-no-nav='true']")) return;
        if (activeMessageId || activeAnnotationId) {
            setActiveMessageId(null);
            setActiveAnnotationId(null);
            return;
        }

        if (!isPdf && !isScrollMode && currentChapter) {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            const w = rect.width;
            if (x < w * 0.3) { navigateWithFlip('backward'); return; }
            if (x > w * 0.7) { navigateWithFlip('forward'); return; }
        }

        setImmersive(prev => !prev);
    };

    useEffect(() => {
        // 自动批注：跟随阅读位置推进，为当前批生成批注。
        // 与开启时的 bootstrap 并发时由 executeBatchAnnotation 的同步锁去重；
        // 若 bootstrap 未拿到批次（书刚打开数据未就绪），本 effect 会随阅读位置变化持续兜底触发。
        if (!autoAnnotate || generating || !companionId) return;
        void (async () => {
            const request = await materializeBatchRequest(annotationBatchSize, "auto");
            if (!request) return;
            await executeBatchAnnotation(request);
        })();
    }, [annotationBatchSize, autoAnnotate, companionId, executeBatchAnnotation, generating, materializeBatchRequest]);

    // 批注预生成：当前批注批读到用户设置的阈值时，提前生成下一批，
    // 把生成时间差放在用户读上一批批注的时间里，避免用户读到下一批时批注还没生成完。不会重复批注（批次按 key 去重）。
    // TXT 按「段落」分批次（autoAnnotatePrefetch 控制）；PDF 按「页数」分批次（autoAnnotatePrefetchPdf 控制），
    // 两者各自独立开关，批次大小统一跟随自动批注的 annotationBatchSize。
    const prefetchedBatchStartRef = useRef(-1);
    useEffect(() => {
        if (!autoAnnotate) { prefetchedBatchStartRef.current = -1; return; }
        if (!companionId || generating) return;
        const size = Math.max(1, annotationBatchSize || (isPdf ? 5 : 50));
        const threshold = Math.max(0, Math.min(1, readingConfig.annotationPrefetchThreshold ?? 2 / 3));

        if (isPdf) {
            // PDF 预批注开关：关闭时不预生成
            if (!readingConfig.autoAnnotatePrefetchPdf) { prefetchedBatchStartRef.current = -1; return; }
            // PDF：按页分批次。当前页所在批次读到阈值时，预解析并预生成下一批批注。
            if (pdfTotalPages <= 0) return;
            const batchStartPage = Math.floor((pdfCurrentPage - 1) / size) * size + 1;
            const offsetInBatch = pdfCurrentPage - batchStartPage; // 0-based
            if ((offsetInBatch + 1) / size < threshold) return; // 本批还没读到阈值
            if (prefetchedBatchStartRef.current === batchStartPage) return;
            prefetchedBatchStartRef.current = batchStartPage;

            const nextStartPage = batchStartPage + size;
            if (nextStartPage > pdfTotalPages) return;
            const nextEndPage = Math.min(nextStartPage + size - 1, pdfTotalPages);
            void (async () => {
                try {
                    // 预解析下一批文本层（解析后 setChapters，但渲染已与文本层解耦，不会重建页面）
                    const merged = await ensurePdfPageRangeParsed(nextStartPage, nextEndPage);
                    const refs = buildParagraphRefsFromChapters(merged);
                    const items = refs.filter((item) => (item.pageNum || 0) >= nextStartPage && (item.pageNum || 0) <= nextEndPage && item.text.trim());
                    if (items.length === 0) { prefetchedBatchStartRef.current = -1; return; }
                    const request: AnnotationBatchRequest = {
                        key: `pdf:${nextStartPage}:${size}`,
                        title: `第${nextStartPage}-${nextEndPage}页`,
                        size,
                        items,
                    };
                    // 若被跳过，重置标记让下一轮滚动再试，避免预生成丢失
                    void executeBatchAnnotation(request).then((started) => {
                        if (!started) prefetchedBatchStartRef.current = -1;
                    });
                } catch (err) {
                    console.error("[Reading] PDF prefetch error:", err);
                    prefetchedBatchStartRef.current = -1;
                }
            })();
            return;
        }

        // TXT 预批注开关：关闭时不预生成
        if (!readingConfig.autoAnnotatePrefetch) { prefetchedBatchStartRef.current = -1; return; }

        // TXT：当前阅读位置 → 全书记绝对段落索引
        if (paragraphRefs.length === 0) return;
        let currentAbs = -1;
        if (isScrollMode) {
            const chapterRefs = paragraphRefs.filter((item) => item.chapterIndex === chapterIndex && item.text.trim());
            if (chapterRefs.length > 0) {
                const center = Math.round(Math.max(0, Math.min(1, scrollFraction)) * (chapterRefs.length - 1));
                currentAbs = chapterRefs[center].absoluteIndex;
            }
        } else {
            const pageItems = txtPages[txtPage] || [];
            const firstLine = pageItems.find((item): item is Extract<TxtPageItem, { kind: "line" }> => item.kind === "line");
            if (firstLine) {
                const ref = paragraphRefs.find((r) => r.chapterIndex === firstLine.chapterIndex && r.paragraphIndex === firstLine.paragraphIndex);
                if (ref) currentAbs = ref.absoluteIndex;
            }
        }
        if (currentAbs < 0) return;

        const batchStart = Math.floor(currentAbs / size) * size;
        if ((currentAbs - batchStart + 1) / size < threshold) return; // 本批还没读到用户设置的阈值
        if (prefetchedBatchStartRef.current === batchStart) return;       // 本批已触发过预生成
        prefetchedBatchStartRef.current = batchStart;

        const nextStart = batchStart + size;
        if (nextStart >= paragraphRefs.length) return;
        const items = paragraphRefs.slice(nextStart, nextStart + size).filter((item) => item.text.trim());
        if (items.length === 0) return;

        const request: AnnotationBatchRequest = {
            key: `txt:${nextStart}:${size}`,
            title: `第${items[0].absoluteIndex + 1}-${items[items.length - 1].absoluteIndex + 1}段`,
            size,
            items,
        };
        // 若被跳过（自动批注正在生成/该批已生成），重置标记让下一轮滚动再试，避免预生成丢失
        void executeBatchAnnotation(request).then((started) => {
            if (!started) prefetchedBatchStartRef.current = -1;
        });
    }, [annotationBatchSize, autoAnnotate, chapterIndex, companionId, ensurePdfPageRangeParsed, executeBatchAnnotation, generating, isPdf, isScrollMode, paragraphRefs, pdfCurrentPage, pdfTotalPages, readingConfig.autoAnnotatePrefetch, readingConfig.autoAnnotatePrefetchPdf, readingConfig.annotationPrefetchThreshold, scrollFraction, txtPage, txtPages]);

    useEffect(() => {
        // 自动批注开启时，随滚动把当前 5 页的文本层预先解析好，让批注生成请求不用临时等待解析。
        // 手动写批注 / 共读讨论内部会自行 ensurePdfPageRangeParsed，关闭自动批注时纯阅读不预解析。
        // 渲染已与文本层解耦：此处 setChapters 只会触发批注钉局部更新，不会重建页面，无闪烁。
        if (!isPdf || !autoAnnotate || pdfCurrentPage <= 0 || chapters.length === 0) return;
        const chunkStart = Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + 1;
        const chunkEnd = Math.min(chunkStart + PDF_PAGES_PER_CHAPTER - 1, pdfTotalPages || chunkStart + PDF_PAGES_PER_CHAPTER - 1);
        void ensurePdfPageRangeParsed(chunkStart, chunkEnd).catch((err) => {
            console.error("[Reading] PDF lazy parse error:", err);
        });
    }, [autoAnnotate, chapters.length, ensurePdfPageRangeParsed, isPdf, pdfCurrentPage, pdfTotalPages]);

    // Chapter navigation
    const goToChapter = (idx: number, startFromEnd = false) => {
        if (idx < 0 || idx >= chapters.length) return;
        pendingTxtPageFractionRef.current = startFromEnd ? 1 : null;
        // 滚动模式：显式跳章后定位到新章节的起点（0）或终点（1），而非窗口顶部（可能是上一章）
        // 实际滚动位置由渲染后的 useLayoutEffect 依据章节块度量换算
        pendingScrollFractionRef.current = startFromEnd ? 1 : 0;
        setChapterIndex(idx);
        setTxtPage(0);
    };

    // ── 书签 ──
    // 位置统一折成章节内 0-1 的比例：翻页/滚动/PDF 三种模式都能用同一个数还原。
    const currentFraction = (): number => {
        if (isPdf) return pdfTotalPages > 0 ? Math.min(1, Math.max(0, pdfCurrentPage / pdfTotalPages)) : 0;
        if (isScrollMode) return Math.max(0, Math.min(1, scrollFraction));
        return txtTotalPages > 1 ? txtPage / (txtTotalPages - 1) : 0;
    };

    /** 当前位置附近的一句正文，列表里靠它认出是哪儿 */
    const bookmarkExcerpt = (chapterIdx: number, fraction: number): string => {
        const paragraphs = (chapters[chapterIdx]?.paragraphs || []).filter((text) => text.trim());
        if (paragraphs.length === 0) return "";
        const index = Math.min(paragraphs.length - 1, Math.floor(fraction * paragraphs.length));
        return paragraphs[index].trim().replace(/\s+/g, " ").slice(0, 40);
    };

    /** 同一页上已经有书签就算「这里有」，再点一下是取消 */
    const bookmarkHere = (): ReadingBookmark | undefined => {
        const fraction = currentFraction();
        return bookmarks.find((item) => {
            if (item.chapterIndex !== chapterIndex) return false;
            if (isPdf) return item.pdfPage === pdfCurrentPage;
            // 一页的宽度就是容差：翻页模式按页算，滚动模式给 2%
            const tolerance = isScrollMode ? 0.02 : 1 / Math.max(1, txtTotalPages) / 2;
            return Math.abs(item.fraction - fraction) <= tolerance;
        });
    };

    const toggleBookmark = async () => {
        const existing = bookmarkHere();
        if (existing) {
            await deleteBookmark(existing.id);
            setBookmarks(await loadBookmarks(book.id));
            return;
        }
        const fraction = currentFraction();
        const bookmark: ReadingBookmark = {
            id: `bm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            bookId: book.id,
            chapterIndex,
            chapterTitle: chapters[chapterIndex]?.title || `第${chapterIndex + 1}章`,
            fraction,
            pdfPage: isPdf ? pdfCurrentPage : undefined,
            excerpt: bookmarkExcerpt(chapterIndex, fraction),
            createdAt: new Date().toISOString(),
        };
        await saveBookmark(bookmark);
        setBookmarks(await loadBookmarks(book.id));
    };

    const jumpToBookmark = (bookmark: ReadingBookmark) => {
        setShowBookmarks(false);
        setShowReadingSettings(false);
        if (isPdf) {
            setChapterIndex(Math.min(Math.max(0, bookmark.chapterIndex), Math.max(0, chapters.length - 1)));
            setPdfJumpPage(Math.max(1, bookmark.pdfPage || 1));
            return;
        }
        const target = Math.min(Math.max(0, bookmark.chapterIndex), Math.max(0, chapters.length - 1));
        const fraction = Math.max(0, Math.min(1, bookmark.fraction));
        if (target === chapterIndex) {
            // 同章内：直接定位，不走换章那条路（换章会重置到章首）
            if (isScrollMode) scrollToChapterFraction(fraction, chapterIndex);
            else {
                pendingTxtPageFractionRef.current = null;
                setTxtPage(Math.round(fraction * Math.max(0, txtTotalPages - 1)));
            }
            return;
        }
        pendingTxtPageFractionRef.current = fraction;
        pendingScrollFractionRef.current = fraction;
        setChapterIndex(target);
        setTxtPage(0);
    };

    const removeBookmark = async (bookmarkId: string) => {
        await deleteBookmark(bookmarkId);
        setBookmarks(await loadBookmarks(book.id));
    };

    /** 跳过去以后把落点闪一下，免得翻到那一页还找不到是哪一段。
     *  2 秒后自动收掉，和 .reading-line.is-jump-flash 的动画时长对应。 */
    const flashJumpTarget = (chapterIdx: number, paragraphIdx: number) => {
        if (jumpFlashTimerRef.current) clearTimeout(jumpFlashTimerRef.current);
        setJumpFlash({ chapterIndex: chapterIdx, paragraphIndex: paragraphIdx });
        jumpFlashTimerRef.current = setTimeout(() => {
            setJumpFlash(null);
            jumpFlashTimerRef.current = undefined;
        }, 2000);
    };

    /** 批注列表里点了那句原文：跳回它在正文里的位置，并把批注面板收起来。
     *  和书签不一样，这里知道「第几段」，所以优先精确落到那一段所在的页；
     *  跨章时先切章，等目标章的排版算完再定位（见后面两个 effect）。 */
    const jumpToSavedLine = (targetChapterIndex: number, targetParagraphIndex: number) => {
        if (chapters.length === 0) return;
        const target = Math.min(Math.max(0, targetChapterIndex), Math.max(0, chapters.length - 1));
        const chapter = chapters[target];
        const paragraphIndex = Math.max(0, Math.min(
            Math.max(0, (chapter?.paragraphs.length || 1) - 1),
            targetParagraphIndex,
        ));

        setShowCharAnnotationMenu(false);
        setShowMyMarksPanel(false);
        flashJumpTarget(target, paragraphIndex);

        if (isPdf) {
            // PDF 每段都记了自己在哪一页，直接翻到那一页
            const page = chapter?.paragraphPages?.[paragraphIndex]
                ?? chapter?.pageStart
                ?? 1;
            setChapterIndex(target);
            setPdfJumpPage(Math.max(1, Math.round(page)));
            return;
        }

        const paragraphCount = Math.max(1, chapter?.paragraphs.length || 1);
        // 章内比例：和书签存的是同一套口径，两种阅读模式都能还原
        const fraction = Math.max(0, Math.min(1, paragraphIndex / paragraphCount));

        if (target === chapterIndex) {
            if (isScrollMode) {
                scrollToChapterFraction(fraction, chapterIndex);
                // 比例只到「附近」，滚动模式下再按段落精确对一次
                pendingParagraphJumpRef.current = { chapterIndex: target, paragraphIndex };
            } else {
                // 翻页模式能直接查出这一段落在第几页，不用按比例估
                const pageIndex = txtPages.findIndex(page => page.some(item => (
                    (item.kind === "line" || item.kind === "annotation")
                    && item.paragraphIndex === paragraphIndex
                )));
                pendingTxtPageFractionRef.current = null;
                setTxtPage(pageIndex >= 0 ? pageIndex : Math.round(fraction * Math.max(0, txtTotalPages - 1)));
            }
            return;
        }

        // 换章：先把比例交给现有那套 pending 机制，等目标章排版好再精确对到段落
        pendingTxtPageFractionRef.current = fraction;
        pendingScrollFractionRef.current = fraction;
        pendingParagraphJumpRef.current = { chapterIndex: target, paragraphIndex };
        setChapterIndex(target);
        setTxtPage(0);
    };

    const buildDiscussContext = useCallback((sourceChapters: BookChapter[] = chapters): ReadingDiscussContext | null => {
        const sourceParagraphRefs = buildParagraphRefsFromChapters(sourceChapters);
        if (sourceParagraphRefs.length === 0) return null;

        let focusChapterIndex = chapterIndex;
        let focusParagraphIndexes: number[] = [];

        if (isPdf) {
            let focusRefs = sourceParagraphRefs.filter((item) => item.text.trim() && (item.pageNum || 0) === pdfCurrentPage);
            if (focusRefs.length === 0) {
                let nearestDistance = Number.POSITIVE_INFINITY;
                for (const item of sourceParagraphRefs) {
                    if (!item.text.trim() || !item.pageNum) continue;
                    nearestDistance = Math.min(nearestDistance, Math.abs(item.pageNum - pdfCurrentPage));
                }
                if (Number.isFinite(nearestDistance)) {
                    focusRefs = sourceParagraphRefs.filter((item) => item.text.trim() && item.pageNum && Math.abs(item.pageNum - pdfCurrentPage) === nearestDistance);
                }
            }
            if (focusRefs.length === 0) return null;

            const chapterCounts = new Map<number, number>();
            for (const item of focusRefs) {
                chapterCounts.set(item.chapterIndex, (chapterCounts.get(item.chapterIndex) || 0) + 1);
            }
            focusChapterIndex = [...chapterCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? chapterIndex;
            focusParagraphIndexes = [...new Set(
                focusRefs
                    .filter((item) => item.chapterIndex === focusChapterIndex)
                    .map((item) => item.paragraphIndex),
            )].sort((a, b) => a - b);
        } else if (isScrollMode) {
            // 滚动模式没有分页：以当前滚动比例估算正在阅读的段落窗口
            const chapterRefs0 = sourceParagraphRefs.filter((item) => item.chapterIndex === focusChapterIndex && item.text.trim());
            if (chapterRefs0.length === 0) return null;
            const center = Math.round(Math.max(0, Math.min(1, scrollFraction)) * (chapterRefs0.length - 1));
            const half = Math.max(1, Math.ceil(DISCUSS_MAX_PARAGRAPHS / 3));
            focusParagraphIndexes = chapterRefs0
                .slice(Math.max(0, center - half), Math.min(chapterRefs0.length, center + half + 1))
                .map((item) => item.paragraphIndex);
        } else {
            const pageItems = txtPages[txtPage] || [];
            focusParagraphIndexes = [...new Set(
                pageItems
                    .filter((item): item is Extract<TxtPageItem, { kind: "line" | "annotation" }> => item.kind === "line" || item.kind === "annotation")
                    .map((item) => item.paragraphIndex),
            )].sort((a, b) => a - b);
        }

        if (focusParagraphIndexes.length === 0) return null;

        const chapterRefs = sourceParagraphRefs.filter((item) => item.chapterIndex === focusChapterIndex && item.text.trim());
        if (chapterRefs.length === 0) return null;

        const focusStartParagraph = focusParagraphIndexes[0];
        const focusEndParagraph = focusParagraphIndexes[focusParagraphIndexes.length - 1];
        let startPos = chapterRefs.findIndex((item) => item.paragraphIndex === focusStartParagraph);
        let endPos = chapterRefs.findIndex((item) => item.paragraphIndex === focusEndParagraph);
        if (startPos === -1 || endPos === -1) return null;

        let usedChars = chapterRefs.slice(startPos, endPos + 1).reduce((sum, item) => sum + getParagraphLength(item.text), 0);
        while ((usedChars < DISCUSS_TARGET_CHARS || usedChars < DISCUSS_MIN_CHARS) && (startPos > 0 || endPos < chapterRefs.length - 1)) {
            if (endPos - startPos + 1 >= DISCUSS_MAX_PARAGRAPHS) break;

            const prevRef = startPos > 0 ? chapterRefs[startPos - 1] : null;
            const nextRef = endPos < chapterRefs.length - 1 ? chapterRefs[endPos + 1] : null;
            if (!prevRef && !nextRef) break;

            const prevChars = prevRef ? getParagraphLength(prevRef.text) : Number.POSITIVE_INFINITY;
            const nextChars = nextRef ? getParagraphLength(nextRef.text) : Number.POSITIVE_INFINITY;
            const pickPrev = prevRef && (!nextRef || prevChars <= nextChars);
            const candidate = pickPrev ? prevRef : nextRef;
            if (!candidate) break;

            const nextUsedChars = usedChars + getParagraphLength(candidate.text);
            if (usedChars >= DISCUSS_TARGET_CHARS && usedChars >= DISCUSS_MIN_CHARS && nextUsedChars > DISCUSS_MAX_CHARS) break;

            if (pickPrev) startPos -= 1;
            else endPos += 1;
            usedChars = nextUsedChars;
        }

        const contextRefs = chapterRefs.slice(startPos, endPos + 1);
        if (contextRefs.length === 0) return null;

        const contextStartParagraph = contextRefs[0].paragraphIndex;
        const contextEndParagraph = contextRefs[contextRefs.length - 1].paragraphIndex;
        const paragraphSet = new Set(contextRefs.map((item) => item.paragraphIndex));
        const contextAnnotations = annotations.filter(
            (annotation) => annotation.chapterIndex === focusChapterIndex && paragraphSet.has(annotation.paragraphIndex),
        );
        const chapterTitleText = chapters[focusChapterIndex]?.title || currentChapter?.title || book.title;
        const chapterContent = [
            `当前阅读中心：${formatParagraphRangeLabel(focusStartParagraph, focusEndParagraph)}`,
            `本次上下文范围：${formatParagraphRangeLabel(contextStartParagraph, contextEndParagraph)}`,
            "",
            contextRefs.map((item) => `[${item.paragraphIndex + 1}] ${item.text}`).join("\n\n"),
        ].join("\n");

        return {
            chapterTitle: chapterTitleText,
            chapterContent,
            annotations: contextAnnotations,
        };
    }, [annotations, book.title, chapterIndex, chapters, currentChapter?.title, isPdf, isScrollMode, pdfCurrentPage, scrollFraction, txtPage, txtPages]);

    // Chat send — parse AI response like chat-room does
    const handleSend = async () => {
        if (!chatInput.trim() || !companionId || chatting) return;
        const text = chatInput.trim();
        setChatInput("");

        const session = getSession();
        if (!session) return;

        // Save user message
        const userMsg = pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: text,
            origin: "reading_discuss",
            mediaData: { readingBookTitle: book.title },
        });
        setChatMessages(prev => [...prev, userMsg]);

        setChatting(true);
        try {
            const sourceChapters = isPdf
                ? await ensurePdfPageRangeParsed(
                    Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + 1,
                    Math.min(
                        Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + PDF_PAGES_PER_CHAPTER,
                        pdfTotalPages || Math.floor((pdfCurrentPage - 1) / PDF_PAGES_PER_CHAPTER) * PDF_PAGES_PER_CHAPTER + PDF_PAGES_PER_CHAPTER,
                    ) - 1,
                )
                : chapters;
            const discussContext = buildDiscussContext(sourceChapters);
            if (!discussContext) return;
            const rawReply = await generateReadingChat(session, book, discussContext, companionId);
            if (rawReply) {
                const { reply, actions } = parseReadingDiscussResponse(rawReply);
                // Parse like chat: split into parts, extract inner monologue, state values, media
                if (reply) {
                    const { parts, statusPanel, innerMonologue, stateValues, freshStateValues } = parseAIResponse(reply, []);
                    const newMsgs: ChatMessage[] = [];
                    const saveParts: typeof parts = parts.length > 0 || !(statusPanel || innerMonologue) ? parts : [{ content: "" }];
                    for (let i = 0; i < saveParts.length; i++) {
                        const msg = pushChatMessage({
                            sessionId: session.id,
                            role: "assistant",
                            content: saveParts[i].content,
                            mediaType: saveParts[i].mediaType,
                            origin: "reading_discuss",
                            mediaData: { ...saveParts[i].mediaData, readingBookTitle: book.title },
                            statusPanel: i === 0 && statusPanel ? statusPanel : undefined,
                            innerMonologue: i === 0 && innerMonologue ? innerMonologue : undefined,
                            stateValues: i === 0 && stateValues.length > 0 ? stateValues : undefined,
                            freshStateValues: i === 0 ? freshStateValues : undefined,
                        });
                        newMsgs.push(msg);
                    }
                    setChatMessages(prev => [...prev, ...newMsgs]);
                }
                if (actions.length > 0) {
                    await applyDiscussActions(actions);
                }
            }
        } catch (err) {
            console.error("[Reading] Chat error:", err);
        } finally {
            setChatting(false);
        }
    };

    const applyDiscussActions = useCallback(async (actions: ReadingDiscussAction[]) => {
        if (!currentChapter || !companionId || !companion) return;

        let nextAnnotations = annotations;

        for (const action of actions) {
            if (action.type === "add_annotation") {
                if (action.paragraphIndex < 0 || action.paragraphIndex >= currentChapter.paragraphs.length) continue;
                const annotation: ReadingAnnotation = {
                    id: `ra_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    bookId: book.id,
                    chapterIndex,
                    paragraphIndex: action.paragraphIndex,
                    characterId: companionId,
                    characterName: companion.name,
                    content: action.content,
                    createdAt: new Date().toISOString(),
                    // 讨论里「新增批注」写的是批注，不是段评
                    annotationKind: "note",
                };
                await saveAnnotation(annotation);
                nextAnnotations = [...nextAnnotations, annotation];
                continue;
            }

            // 讨论只能改 / 删批注。段评是评论区的东西，不能让模型从这个入口动手，
            // 否则「删掉那条批注」会连带把段落下面的评论删掉。
            const target = nextAnnotations.find(
                (annotation) => annotation.id === action.annotationId
                    && annotation.chapterIndex === chapterIndex
                    && isNoteAnnotation(annotation),
            );
            if (!target) continue;

            if (action.type === "delete_annotation") {
                await deleteAnnotation(action.annotationId);
                nextAnnotations = nextAnnotations.filter((annotation) => annotation.id !== action.annotationId);
                continue;
            }

            const updated: ReadingAnnotation = {
                ...target,
                content: action.content,
            };
            await saveAnnotation(updated);
            nextAnnotations = nextAnnotations.map((annotation) => annotation.id === updated.id ? updated : annotation);
        }

        setAnnotations(nextAnnotations);
    }, [annotations, book.id, chapterIndex, companion, companionId, currentChapter]);

    const handleOpenChat = () => {
        setShowChat(true);
        setChatExpanded(false);
        closeCharPicker();
    };

    const [chatClosing, setChatClosing] = useState(false);
    const handleCloseChat = () => {
        if (chatClosing) return;
        setChatClosing(true);
        setTimeout(() => {
            setShowChat(false);
            setChatExpanded(false);
            setChatClosing(false);
        }, 200);
    };

    const shouldIgnoreChatAction = () => {
        if (!chatMovedRef.current) return false;
        chatMovedRef.current = false;
        return true;
    };

    const handleChatDragStart = (e: React.PointerEvent<HTMLElement>) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        // 悬浮球自身就是一个 button，点击与拖拽靠 chatMovedRef 区分，必须允许拖拽；
        // 悬浮条/窗内部的交互元素（按钮/输入框/正文滚动区等）不参与拖拽，避免抢占点击。
        const target = e.target as HTMLElement;
        if (!target.closest(".reading-chat-launch") && target.closest("button, input, textarea, select, a, .reading-chat-float-body, .reading-char-picker")) return;
        setIsDragging(true);
        chatDragRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            originX: chatOffset.x,
            originY: chatOffset.y,
        };
        chatMovedRef.current = false;
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };

    const handleChatDragMove = (e: React.PointerEvent<HTMLElement>) => {
        const drag = chatDragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        const nextX = drag.originX + (e.clientX - drag.startX);
        const nextY = drag.originY + (e.clientY - drag.startY);
        const dragThreshold = e.pointerType === "touch" ? 12 : 6;
        if (!chatMovedRef.current && (Math.abs(nextX - drag.originX) > dragThreshold || Math.abs(nextY - drag.originY) > dragThreshold)) {
            chatMovedRef.current = true;
        }
        if (chatMovedRef.current) {
            // 拖拽过程中就约束在屏幕内，悬浮元素永不滑出屏幕外
            setChatOffset(clampChatOffset({ x: nextX, y: nextY }));
        }
    };

    // 悬浮元素尺寸（按当前形态估算，用于边界约束/贴边吸附）
    const getChatFloatSize = () => {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (!showChat) return { width: 56, height: 56 };                                    // 悬浮球
        if (!chatExpanded) return { width: Math.min(280, w - CHAT_FLOAT_MARGIN * 2), height: 56 }; // 悬浮条
        return { width: Math.min(300, w - CHAT_FLOAT_MARGIN * 2), height: Math.min(380, h * 0.55) }; // 悬浮窗
    };

    // 把偏移量约束在可视范围内。CSS 基础位置为 left:12px / bottom:12px，
    // 偏移是相对该基础位置的 translate3d，正 Y 向下。
    const clampChatOffset = (offset: { x: number; y: number }): { x: number; y: number } => {
        const { width, height } = getChatFloatSize();
        const w = window.innerWidth;
        const h = window.innerHeight;
        const maxX = w - CHAT_FLOAT_MARGIN * 2 - width;
        const maxY = height + CHAT_FLOAT_MARGIN * 2 - h; // 允许向上拖到接近顶边（负值表示可上移）
        return {
            x: Math.max(0, Math.min(maxX, offset.x)),
            y: Math.max(maxY, Math.min(0, offset.y)),
        };
    };

    const persistChatFloatPos = (offset: { x: number; y: number }) => {
        try {
            localStorage.setItem(CHAT_FLOAT_POS_KEY, JSON.stringify(clampChatOffset(offset)));
        } catch {
            // ignore storage errors
        }
    };

    // 悬浮形态切换（球→条→窗 / 收起）后把位置约束回可视范围，防止越界丢失
    useEffect(() => {
        setChatOffset((prev) => {
            const clamped = clampChatOffset(prev);
            return clamped.x === prev.x && clamped.y === prev.y ? prev : clamped;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showChat, chatExpanded]);

    // 始终指向最新版本的 clampChatOffset（供一次性挂载的监听器使用）
    const clampChatOffsetRef = useRef(clampChatOffset);
    clampChatOffsetRef.current = clampChatOffset;

    // 窗口尺寸变化（旋转/分屏）后把悬浮元素约束回屏幕内；书架设置里的「重置位置」事件
    useEffect(() => {
        const onResize = () => {
            setChatOffset((prev) => {
                const clamped = clampChatOffsetRef.current(prev);
                return clamped.x === prev.x && clamped.y === prev.y ? prev : clamped;
            });
        };
        const onResetPos = () => {
            setChatOffset({ x: 0, y: 0 });
            try {
                localStorage.setItem(CHAT_FLOAT_POS_KEY, JSON.stringify({ x: 0, y: 0 }));
            } catch {
                // ignore storage errors
            }
        };
        window.addEventListener("resize", onResize);
        window.addEventListener("reading-chat-float-reset", onResetPos);
        return () => {
            window.removeEventListener("resize", onResize);
            window.removeEventListener("reading-chat-float-reset", onResetPos);
        };
    }, []);

    const handleChatDragEnd = (e: React.PointerEvent<HTMLElement>) => {
        const drag = chatDragRef.current;
        if (!drag || drag.pointerId !== e.pointerId) return;
        chatDragRef.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        setIsDragging(false);

        // 纯点击（没拖动）不吸附、不改位置
        if (!chatMovedRef.current) {
            chatMovedRef.current = false;
            return;
        }
        chatMovedRef.current = false;

        let target = clampChatOffset({ x: chatOffset.x, y: chatOffset.y });
        if (!chatExpanded) {
            // 悬浮球/悬浮条：横向吸附到最近的边缘（贴左或贴右）
            const { width } = getChatFloatSize();
            const maxX = window.innerWidth - CHAT_FLOAT_MARGIN * 2 - width;
            const leftDist = target.x;
            const rightDist = maxX - target.x;
            target = { x: leftDist <= rightDist ? 0 : maxX, y: target.y };
        }
        setChatOffset(target);
        persistChatFloatPos(target);
    };

    const handleChatLaunchClick = () => {
        if (chatMovedRef.current) {
            chatMovedRef.current = false;
            return;
        }
        handleOpenChat();
    };

    const chatFloatingStyle = {
        transform: `translate3d(${chatOffset.x}px, ${chatOffset.y}px, 0)`,
        transition: isDragging ? 'none' : 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), width 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), height 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), border-radius 0.3s ease-out',
    };

    useEffect(() => {
        if (isPdf || !scrollRef.current) return;

        const body = scrollRef.current;
        const onResize = () => setTxtLayoutVersion((v) => v + 1);
        const resizeObserver = new ResizeObserver(onResize);
        resizeObserver.observe(body);

        const fontsReady = (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
        fontsReady?.then(onResize).catch(() => {});

        return () => resizeObserver.disconnect();
    }, [isPdf]);

    useEffect(() => {
        if (isPdf || !currentChapter) return;
        const rafId = window.requestAnimationFrame(() => {
            setTxtLayoutVersion((v) => v + 1);
        });
        return () => window.cancelAnimationFrame(rafId);
    }, [annotations, chapterIndex, currentChapter, isPdf]);

    // TXT pagination — split by actual rendered width/height so each page fits one screen.
    // 滚动模式下不参与分页，直接渲染整章内容。
    useEffect(() => {
        if (isPdf || isScrollMode || !currentChapter || !scrollRef.current || !txtMeasureLineRef.current || !txtMeasureGapRef.current || !txtMeasureAnnotationRef.current) {
            setTxtPages([]);
            return;
        }

        const body = scrollRef.current;
        const bodyStyle = window.getComputedStyle(body);
        const bodyPaddingX = parseFloat(bodyStyle.paddingLeft || "0") + parseFloat(bodyStyle.paddingRight || "0");
        const bodyPaddingY = parseFloat(bodyStyle.paddingTop || "0") + parseFloat(bodyStyle.paddingBottom || "0");
        const surface = body.querySelector('.reading-page-surface') as HTMLElement | null;
        const surfacePadX = surface
            ? parseFloat(getComputedStyle(surface).paddingLeft || "0") + parseFloat(getComputedStyle(surface).paddingRight || "0")
            : 0;
        const maxWidth = Math.max(1, body.clientWidth - bodyPaddingX - surfacePadX);
        const bottomOverlayReserve = 40;
        const maxHeight = Math.max(1, body.clientHeight - bodyPaddingY - bottomOverlayReserve);

        const lineStyle = window.getComputedStyle(txtMeasureLineRef.current);
        const gapStyle = window.getComputedStyle(txtMeasureGapRef.current);
        const lineHeight = parseFloat(lineStyle.lineHeight || "0") || 30.4;
        const gapHeight = parseFloat(gapStyle.height || "0") || 20;
        const fontSize = parseFloat(lineStyle.fontSize || "0") || 16;
        const indentWidth = fontSize * 2;
        const annotationMeasure = txtMeasureAnnotationRef.current;
        const annotationNameEl = annotationMeasure.querySelector(".reading-annotation-name") as HTMLElement | null;
        const annotationTextEl = annotationMeasure.querySelector(".reading-annotation-text") as HTMLElement | null;
        const annotationMeasureStyle = window.getComputedStyle(annotationMeasure);
        const annotationMarginY =
            parseFloat(annotationMeasureStyle.marginTop || "0") +
            parseFloat(annotationMeasureStyle.marginBottom || "0");
        const chapterAnnotations = annotations.filter((annotation) => annotation.chapterIndex === chapterIndex);
        const annotationSignature = chapterAnnotations
            .map((annotation) => `${annotation.id}:${annotation.content.length}:${isAnnotationTranslationExpanded(annotation.id) ? 1 : 0}`)
            .join("|");
        const openParagraphSignature = Object.entries(openAnnotationParagraphs)
            .filter(([key, open]) => open && key.startsWith(`${chapterIndex}:`))
            .map(([key]) => key)
            .sort()
            .join(",");
        const paragraphCharCount = currentChapter.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
        const paginationSignature = [
            currentChapter.id,
            chapterIndex,
            currentChapter.paragraphs.length,
            paragraphCharCount,
            annotationSignature,
            openParagraphSignature,
            bilingualTranslationEnabled ? 1 : 0,
            Math.round(maxWidth),
            Math.round(maxHeight),
            lineHeight,
            gapHeight,
            fontSize,
            lineStyle.fontFamily,
            lineStyle.fontWeight,
            lineStyle.fontStyle,
        ].join("::");

        if (lastTxtPaginationSignatureRef.current === paginationSignature) return;

        const measureAnnotationHeight = (annotation: ReadingAnnotation) => {
            if (!annotationNameEl || !annotationTextEl) return lineHeight * 2;
            annotationNameEl.textContent = annotation.characterName;
            const bilingual = bilingualTranslationEnabled ? splitBilingualText(annotation.content) : null;
            if (!bilingual) {
                annotationTextEl.textContent = annotation.content;
            } else {
                const expanded = isAnnotationTranslationExpanded(annotation.id);
                annotationTextEl.textContent = expanded
                    ? `${bilingual.original}\n收起中文\n${bilingual.translated}`
                    : `${bilingual.original}\n中文`;
            }
            const blockHeight = annotationMeasure.offsetHeight || lineHeight * 2;
            return blockHeight + annotationMarginY;
        };

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
            setTxtPages([[{ kind: "line", text: currentChapter.paragraphs.join(" "), chapterIndex, paragraphIndex: 0, indent: true }]]);
            return;
        }
        ctx.font = toCanvasFont(lineStyle);

        const tokens: TxtPageItem[] = [];
        const annotationMap = new Map<number, ReadingAnnotation[]>();
        for (const annotation of chapterAnnotations) {
            const list = annotationMap.get(annotation.paragraphIndex) || [];
            list.push(annotation);
            annotationMap.set(annotation.paragraphIndex, list);
        }

        currentChapter.paragraphs.forEach((paragraph, index) => {
            const imageMarker = parseReadingImageMarker(paragraph);
            if (imageMarker) {
                tokens.push({ kind: "image", image: imageMarker, chapterIndex, paragraphIndex: index });
                if (index < currentChapter.paragraphs.length - 1) tokens.push({ kind: "gap", chapterIndex, paragraphIndex: index });
                return;
            }
            const paragraphAnnotations = annotationMap.get(index) || [];
            // 句子批注（显示在被高亮/划线句子末字所在行下方）与段评（显示在段末💬气泡弹窗内）拆分
            const sentenceNotes = paragraphAnnotations.filter(isNoteAnnotation);
            const paragraphComments = paragraphAnnotations.filter((a) => !isNoteAnnotation(a));
            const insertedNoteIds = new Set<string>();
            const segments = paragraph.split("\n");
            // 段落内的字符游标：wrapTextToLines 不裁剪字符，各行拼接等于原段落，
            // 所以逐行累加长度就能得到每行在段落中的起始偏移（荧光笔/划线按此定位）。
            let charCursor = 0;
            segments.forEach((segment, segmentIndex) => {
                const shouldIndent = segmentIndex === 0;
                const isLastSegment = segmentIndex === segments.length - 1;
                const wrappedLines = wrapTextToLines(segment, maxWidth, ctx, shouldIndent ? indentWidth : 0);
                wrappedLines.forEach((line, lineIndex) => {
                    const isLastLine = isLastSegment && lineIndex === wrappedLines.length - 1;
                    const lineStart = charCursor;
                    const lineEnd = lineStart + line.length;
                    tokens.push({
                        kind: "line",
                        text: line,
                        chapterIndex,
                        paragraphIndex: index,
                        indent: shouldIndent && lineIndex === 0,
                        segEnd: lineIndex === wrappedLines.length - 1,
                        charStart: lineStart,
                        ...(isLastLine && paragraphComments.length > 0 ? { annotationCount: paragraphComments.length } : {}),
                    });
                    // 找出被高亮/划线句子最末字落在当前行的批注，紧贴本行正下方渲染
                    for (const note of sentenceNotes) {
                        const targetEnd = typeof note.quoteEnd === "number" ? note.quoteEnd : paragraph.length;
                        if (
                            !insertedNoteIds.has(note.id) &&
                            ((targetEnd > lineStart && targetEnd <= lineEnd) || (isLastLine && targetEnd > lineEnd))
                        ) {
                            insertedNoteIds.add(note.id);
                            tokens.push({ kind: "annotation", annotation: note, chapterIndex, paragraphIndex: index });
                        }
                    }
                    charCursor += line.length;
                });
                if (segmentIndex < segments.length - 1) charCursor += 1; // 被 split 掉的 \n
                if (segmentIndex < segments.length - 1) tokens.push({ kind: "gap", chapterIndex, paragraphIndex: index });
            });
            for (const note of sentenceNotes) {
                if (!insertedNoteIds.has(note.id)) {
                    tokens.push({ kind: "annotation", annotation: note, chapterIndex, paragraphIndex: index });
                }
            }
            if (index < currentChapter.paragraphs.length - 1) tokens.push({ kind: "gap", chapterIndex, paragraphIndex: index });
        });

        const pages: TxtPageItem[][] = [];
        let currentPage: TxtPageItem[] = [];
        let usedHeight = 0;

        /** 插图占多高：按原图比例缩放，但不超过原图自身的像素尺寸（避免小插图被强行放大铺满整行），
         *  最高也不超过一页能放下的高度。CSS 里用同一个约束，排版和实际渲染才对得上。 */
        const measureImageHeight = (image: ReadingImageRef) => {
            if (image.width > 0 && image.height > 0) {
                const displayWidth = Math.min(maxWidth, image.width);
                return Math.min(maxHeight, Math.round((displayWidth * image.height) / image.width));
            }
            // 量不出原始尺寸（SVG 等）：留一块适中的位置
            return Math.min(maxHeight, Math.round(maxWidth * 0.6));
        };

        for (const token of tokens) {
            const tokenHeight = token.kind === "gap"
                ? gapHeight
                : token.kind === "annotation"
                    ? measureAnnotationHeight(token.annotation)
                    : token.kind === "image"
                        ? measureImageHeight(token.image)
                        : lineHeight;
            if (token.kind === "gap" && currentPage.length === 0) continue;

            if (currentPage.length > 0 && usedHeight + tokenHeight > maxHeight) {
                pages.push(trimTrailingGaps(currentPage));
                currentPage = [];
                usedHeight = 0;
                if (token.kind === "gap") continue;
            }

            currentPage.push(token);
            usedHeight += tokenHeight;
        }

        const lastPage = trimTrailingGaps(currentPage);
        if (lastPage.length > 0) pages.push(lastPage);
        if (pages.length === 0) pages.push([{ kind: "line", text: "", chapterIndex, paragraphIndex: 0 }]);

        lastTxtPaginationSignatureRef.current = paginationSignature;
        setImageMaxHeight((prev) => (prev === maxHeight ? prev : maxHeight));
        setTxtPages(pages);
    }, [annotations, bilingualTranslationEnabled, chapterIndex, currentChapter, isAnnotationTranslationExpanded, isPdf, isScrollMode, openAnnotationParagraphs, txtLayoutVersion]);

    const txtTotalPages = txtPagesReadyForCurrentChapter ? txtPages.length : 1;

    // 全书进度按字数加权：章节长度差距很大（几十字的版权页 vs 一万多字的正文章），
    // 用「第几章 / 总章数」会让进度条和实际读了多少完全对不上。
    const chapterCharStats = useMemo(() => {
        const lengths = chapters.map(ch => ch.paragraphs.reduce((sum, p) => sum + p.length, 0));
        const offsets: number[] = [];
        let acc = 0;
        for (const len of lengths) {
            offsets.push(acc);
            acc += len;
        }
        return { lengths, offsets, total: acc };
    }, [chapters]);

    /** 章内比例 → 全书比例。字数统计不可用时回退到按章数平均，保持旧行为。 */
    const toBookFraction = useCallback((targetChapterIndex: number, withinChapter: number) => {
        const within = Math.min(1, Math.max(0, withinChapter));
        const { lengths, offsets, total } = chapterCharStats;
        const chapterLength = lengths[targetChapterIndex];
        if (total > 0 && chapterLength !== undefined) {
            const read = (offsets[targetChapterIndex] ?? 0) + chapterLength * within;
            return Math.min(1, Math.max(0, read / total));
        }
        return Math.min(1, Math.max(0, (targetChapterIndex + within) / Math.max(1, chapters.length)));
    }, [chapterCharStats, chapters.length]);

    const navigateWithFlip = useCallback((direction: 'forward' | 'backward') => {
        if (flipAnim || isPdf) return;
        // 正在选字时不要翻页，否则一松手就跳走
        if (selectionInfo) return;
        const sel = typeof window !== "undefined" ? window.getSelection() : null;
        if (sel && !sel.isCollapsed) return;
        // 拿不到当前页（分页尚未算完、或 txtPage 暂时越界）只说明没法放翻页动画，
        // 不该把跳章也一起吞掉——否则读到章末会「翻不动」，只能手动点下一章。
        const currentItems = txtPages[txtPage];

        const canForward = txtPage < txtTotalPages - 1 || chapterIndex < chapters.length - 1;
        const canBackward = txtPage > 0 || chapterIndex > 0;
        if (direction === 'forward' && !canForward) return;
        if (direction === 'backward' && !canBackward) return;

        // 关掉动画就直接切页：flipAnim 是那层翻页覆盖物，不设它就没有动画
        if (flipAnimationEnabled && currentItems && currentItems.length > 0) {
            setFlipAnim({ direction, items: currentItems });
        }

        if (direction === 'forward') {
            if (txtPage < txtTotalPages - 1) setTxtPage(p => p + 1);
            else goToChapter(chapterIndex + 1);
        } else {
            if (txtPage > 0) setTxtPage(p => p - 1);
            else goToChapter(chapterIndex - 1, true);
        }
    }, [flipAnim, flipAnimationEnabled, isPdf, txtPages, txtPage, txtTotalPages, chapterIndex, chapters.length, selectionInfo]);

    const txtDisplayedPage = Math.min(txtPage + 1, txtTotalPages);
    const currentPageCount = isPdf ? Math.max(1, pdfTotalPages || 1) : Math.max(1, txtTotalPages);
    const txtBookSliderMax = chapters.length > 0 ? chapters.length + 1 : 1;
    const txtBookSliderValue = (() => {
        if (chapters.length === 0) return 1;
        const boundedChapterIndex = Math.max(0, Math.min(chapters.length - 1, chapterIndex));
        const pageFraction = isScrollMode
            ? Math.max(0, Math.min(1, scrollFraction))
            : (txtTotalPages > 1 ? Math.max(0, Math.min(txtPage, txtTotalPages - 1)) / (txtTotalPages - 1) : 0);
        return Math.max(1, Math.min(txtBookSliderMax, boundedChapterIndex + 1 + pageFraction));
    })();
    useEffect(() => {
        if (isPdf || isScrollMode) return;
        if (txtPagesChapterIndex !== chapterIndex) return;

        // 从批注列表点过来的：本章排版算完之后，按「这一段落在第几页」精确落位，
        // 比按比例估算准（一章里段落长短差很多时，比例会偏出好几页）
        const paragraphJump = pendingParagraphJumpRef.current;
        if (paragraphJump && paragraphJump.chapterIndex === chapterIndex) {
            const pageIndex = txtPages.findIndex(page => page.some(item => (
                (item.kind === "line" || item.kind === "annotation")
                && item.paragraphIndex === paragraphJump.paragraphIndex
            )));
            if (pageIndex >= 0) {
                pendingParagraphJumpRef.current = null;
                pendingTxtPageFractionRef.current = null;
                setTxtPage(pageIndex);
                return;
            }
        }

        const pendingFraction = pendingTxtPageFractionRef.current;
        if (pendingFraction === null) return;

        setTxtPage(Math.round(pendingFraction * Math.max(0, txtTotalPages - 1)));
        pendingTxtPageFractionRef.current = null;
    }, [chapterIndex, isPdf, isScrollMode, txtPagesChapterIndex, txtPages, txtTotalPages]);

    // 滚动模式：从批注列表点过来，等目标段落真正渲染进 DOM 再把它滚进视野。
    // 比例定位只能到「附近」，这里按段落元素精确对一次。
    useEffect(() => {
        if (isPdf || !isScrollMode || !chaptersLoaded) return;
        const jump = pendingParagraphJumpRef.current;
        if (!jump || jump.chapterIndex !== chapterIndex) return;
        const body = scrollRef.current;
        const surface = surfaceRef.current;
        if (!body || !surface) return;
        const el = surface.querySelector<HTMLElement>(
            `[data-chapter="${jump.chapterIndex}"][data-paragraph="${jump.paragraphIndex}"]`,
        );
        if (!el) return;
        pendingParagraphJumpRef.current = null;
        const bodyRect = body.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        // 留一点上边距，正好把这一行露在顶部附近而不是贴着边缘
        body.scrollTop = Math.max(0, body.scrollTop + (elRect.top - bodyRect.top) - 16);
    }, [annotations, chapterIndex, chaptersLoaded, isPdf, isScrollMode, txtLayoutVersion]);

    useEffect(() => {
        if (!chaptersLoaded || chapters.length === 0) return;

        let scrollPosition: number;
        let progressFraction: number;
        let progressCurrent: number;
        let progressTotal: number;
        let progressScope: "book" | "chapter";
        if (isPdf) {
            scrollPosition = Math.max(0, pdfCurrentPage - 1);
            progressFraction = pdfTotalPages > 0 ? Math.min(1, Math.max(0, pdfCurrentPage / pdfTotalPages)) : 0;
            progressCurrent = Math.max(1, pdfCurrentPage);
            progressTotal = Math.max(1, pdfTotalPages || 1);
            progressScope = "book";
        } else if (isScrollMode) {
            const fraction = Math.max(0, Math.min(1, scrollFraction));
            scrollPosition = fraction;
            progressFraction = toBookFraction(chapterIndex, fraction);
            progressCurrent = Math.max(1, Math.round(fraction * 100));
            progressTotal = 100;
            progressScope = "chapter";
        } else {
            const chapterPageCurrent = Math.max(1, txtPage + 1);
            const chapterPageTotal = Math.max(1, txtTotalPages);
            scrollPosition = txtPage;
            progressFraction = toBookFraction(chapterIndex, chapterPageCurrent / chapterPageTotal);
            progressCurrent = chapterPageCurrent;
            progressTotal = chapterPageTotal;
            progressScope = "chapter";
        }

        const progress: ReadingProgress = {
            bookId: book.id,
            chapterIndex,
            scrollPosition,
            companionCharacterId: companionId || undefined,
            progressFraction,
            progressCurrent,
            progressTotal,
            progressScope,
            readingMode: isPdf ? undefined : (isScrollMode ? "scroll" : "page"),
            lastReadAt: new Date().toISOString(),
        };
        saveProgress(progress);
    }, [book.id, chapterIndex, chapters.length, chaptersLoaded, companionId, isPdf, isScrollMode, pdfCurrentPage, pdfTotalPages, scrollFraction, toBookFraction, txtPage, txtTotalPages]);

    useEffect(() => {
        setTxtPage((prev) => Math.min(prev, Math.max(0, txtTotalPages - 1)));
    }, [txtTotalPages]);

    // Scroll to top when page changes (仅翻页模式；滚动模式的位置由 useLayoutEffect 统一管理)
    useEffect(() => {
        if (isScrollMode) return;
        scrollRef.current?.scrollTo(0, 0);
    }, [txtPage, isScrollMode]);

    // 展开/收起段末批注气泡后，滚动模式下重新测量章节块高度
    useLayoutEffect(() => {
        if (!isScrollMode || !chaptersLoaded) return;
        const content = scrollContentRef.current;
        const body = scrollRef.current;
        if (!content || !body) return;
        const bodyRect = body.getBoundingClientRect();
        const metrics = new Map<number, { top: number; height: number }>();
        for (const chunk of content.querySelectorAll<HTMLElement>("[data-chapter-index]")) {
            const idx = Number(chunk.getAttribute("data-chapter-index"));
            if (!Number.isFinite(idx)) continue;
            const rect = chunk.getBoundingClientRect();
            metrics.set(idx, { top: rect.top - bodyRect.top + body.scrollTop, height: rect.height });
        }
        chapterMetricsRef.current = metrics;
    }, [isScrollMode, chaptersLoaded, openAnnotationParagraphs]);

    // 滚动模式：监听滚动 —— 更新章节内滚动比例；无缝衔接（多章窗口平移，保持视觉连续）
    // 前向：当前章内容读完（章底滚到视口顶部/底部）→ 移除顶部章块 + 补偿滚动位置，自然过渡到下一章
    // 后向：滚到窗口顶部 → 顶部前插上一章块 + 补偿滚动位置，自然回到上一章（无需「上一章」按钮）
    useEffect(() => {
        if (!isScrollMode) return;
        const body = scrollRef.current;
        if (!body) return;
        let rafId = 0;
        const onScroll = () => {
            if (rafId) return;
            rafId = window.requestAnimationFrame(() => {
                rafId = 0;
                const ci = chapterIndexRef.current;
                const len = chaptersLenRef.current;
                const viewport = body.clientHeight;
                const maxScroll = Math.max(0, body.scrollHeight - viewport);
                const metrics = chapterMetricsRef.current.get(ci);
                let fraction = 0;
                if (metrics) {
                    const span = Math.max(1, metrics.height - viewport);
                    fraction = Math.min(1, Math.max(0, (body.scrollTop - metrics.top) / span));
                } else {
                    fraction = maxScroll > 0 ? Math.min(1, Math.max(0, body.scrollTop / maxScroll)) : 0;
                }
                scrollFractionRef.current = fraction;
                setScrollFraction(fraction);
                if (!metrics) return;

                // 离开顶部后解除平移冷却
                if (body.scrollTop > 2) shiftCooldownRef.current = false;

                const bottom = metrics.top + metrics.height;
                // 高章节（超一屏）：章底滚到视口底部即衔接下一章，header 同步更新；
                // 矮章节（不足一屏）：等章底滚到视口顶部再衔接，避免移除顶部章块后滚动位置为负导致跳动
                const triggerAt = metrics.height >= viewport ? bottom - viewport - 2 : bottom - 2;
                // 前向：当前章已读完 → 移除顶部章块，窗口后移
                if (!shiftCooldownRef.current && ci < len - 1 && body.scrollTop >= triggerAt) {
                    shiftCooldownRef.current = true;
                    const prevMetrics = chapterMetricsRef.current.get(ci - 1);
                    pendingScrollActionRef.current = {
                        kind: "shift-forward",
                        oldScrollTop: body.scrollTop,
                        removedHeight: prevMetrics ? prevMetrics.height : 0,
                    };
                    setChapterIndex(ci + 1);
                    return;
                }
                // 后向：已滚到窗口顶部 → 顶部前插上一章块，窗口前移
                if (!shiftCooldownRef.current && ci > 0 && body.scrollTop <= 2) {
                    shiftCooldownRef.current = true;
                    pendingScrollActionRef.current = { kind: "shift-backward", oldScrollTop: body.scrollTop };
                    setChapterIndex(ci - 1);
                    return;
                }
            });
        };
        body.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            body.removeEventListener("scroll", onScroll);
            if (rafId) window.cancelAnimationFrame(rafId);
        };
    }, [isScrollMode]);

    // 滚动模式：渲染后测量各章块位置，并应用窗口平移补偿 / 显式定位（useLayoutEffect 保证在绘制前执行，无闪跳）
    useLayoutEffect(() => {
        if (!isScrollMode || !chaptersLoaded) return;
        const content = scrollContentRef.current;
        const body = scrollRef.current;
        if (!content || !body || windowChapters.length === 0) return;

        // 1. 测量窗口内各章块在滚动坐标系中的位置（top 与 body.scrollTop 同坐标系）
        const bodyRect = body.getBoundingClientRect();
        const metrics = new Map<number, { top: number; height: number }>();
        for (const chunk of content.querySelectorAll<HTMLElement>("[data-chapter-index]")) {
            const idx = Number(chunk.getAttribute("data-chapter-index"));
            if (!Number.isFinite(idx)) continue;
            const rect = chunk.getBoundingClientRect();
            metrics.set(idx, { top: rect.top - bodyRect.top + body.scrollTop, height: rect.height });
        }
        chapterMetricsRef.current = metrics;

        // 2. 窗口平移补偿（保持视觉位置不动，实现无缝衔接）
        const action = pendingScrollActionRef.current;
        if (action) {
            pendingScrollActionRef.current = null;
            if (action.kind === "shift-forward") {
                body.scrollTop = Math.max(0, action.oldScrollTop - action.removedHeight);
            } else {
                const newPrev = metrics.get(chapterIndex - 1);
                body.scrollTop = Math.max(0, action.oldScrollTop + (newPrev ? newPrev.height : 0));
            }
            return;
        }

        // 3. 显式跳章 / 打开恢复 / 默认定位到当前章起点
        const positionKey = `${book.id}:${isScrollMode}`;
        const pendingFraction = pendingScrollFractionRef.current;
        const initialFraction = initialScrollFractionRef.current;
        if (pendingFraction !== null) {
            pendingScrollFractionRef.current = null;
            scrollPositionedKeyRef.current = positionKey;
            scrollToChapterFraction(pendingFraction, chapterIndex);
        } else if (initialFraction !== null) {
            initialScrollFractionRef.current = null;
            scrollPositionedKeyRef.current = positionKey;
            scrollToChapterFraction(initialFraction, chapterIndex);
        } else if (scrollPositionedKeyRef.current !== positionKey) {
            scrollPositionedKeyRef.current = positionKey;
            scrollToChapterFraction(0, chapterIndex);
        }
    }, [isScrollMode, chapterIndex, windowChapters, chaptersLoaded, annotations, txtLayoutVersion, book.id]);

    // Swipe handlers for TXT
    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        // 拖动选区手柄同样会走到这里：有活动选区就别翻页，否则刚选好就被翻走
        const sel = typeof window !== "undefined" ? window.getSelection() : null;
        if (sel && !sel.isCollapsed) return;
        const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
        const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            navigateWithFlip(dx < 0 ? 'forward' : 'backward');
        }
    };

    const activeReadingMenuMessage = readingMessageMenu
        ? chatMessages.find((msg) => msg.id === readingMessageMenu.messageId) || null
        : null;

    /** PDF 渲染设置先在弹窗内暂存，确认时只重建一次，避免拖动滑块期间连续重渲染整本 PDF。 */
    const openRangeSummary = () => {
        setSummaryMemos(loadReadingSummaryMemos(book.id, book.title));
        setSummaryRange({ start: chapterIndex, end: chapterIndex });
        setSummaryDraft("");
        setSummaryLabel("");
        setSummaryNote("");
        setShowRangeSummary(true);
    };

    const runRangeSummary = async () => {
        const from = Math.min(summaryRange.start, summaryRange.end);
        const to = Math.max(summaryRange.start, summaryRange.end);
        const picked = chapters.filter(chapter => chapter.index >= from && chapter.index <= to);
        if (picked.length === 0) { setSummaryNote("这个范围里没有章节"); return; }
        setSummaryBusy(true);
        setSummaryNote("");
        try {
            const result = await summarizeReadingRange(book, picked);
            setSummaryDraft(result.summary);
            setSummaryLabel(result.rangeLabel);
            // 截断是真会漏内容的（只总结了前面一部分），不能不说，但要说清楚是怎么回事
            setSummaryNote(result.truncated ? "选的范围太长，只总结了前面一部分，建议分几次总结" : "");
        } catch (err) {
            setSummaryNote(err instanceof Error ? err.message : "总结失败");
        } finally {
            setSummaryBusy(false);
        }
    };

    const loadPanelAnnotations = async () => {
        const groups = await Promise.all(chapters.map(chapter => loadAnnotations(book.id, chapter.index)));
        setPanelAnnotations(groups.flat());
    };

    const openMyAnnotationsPanel = () => {
        setExportNote("");
        setShowMyMarksPanel(true);
        void loadPanelAnnotations();
    };

    const openCharAnnotationsPanel = () => {
        setShowCharAnnotationMenu(true);
        void loadPanelAnnotations();
    };

    const removeAnnotationEverywhere = async (annotationId: string) => {
        const pool = [...annotations, ...panelAnnotations];
        const toDeleteIds = new Set<string>([annotationId]);
        let added = true;
        while (added) {
            added = false;
            for (const item of pool) {
                if (item.parentId && toDeleteIds.has(item.parentId) && !toDeleteIds.has(item.id)) {
                    toDeleteIds.add(item.id);
                    added = true;
                }
            }
        }
        await Promise.all([...toDeleteIds].map((id) => deleteAnnotation(id)));
        toDeleteIds.forEach((id) => deleteReadingAnnotationMemo(id));
        setAnnotations(prev => prev.filter(item => !toDeleteIds.has(item.id)));
        setPanelAnnotations(prev => prev.filter(item => !toDeleteIds.has(item.id)));
    };

    const saveRangeSummary = () => {
        const content = summaryDraft.trim();
        if (!content || !companionId) return;
        const from = Math.min(summaryRange.start, summaryRange.end);
        appendReadingAnnotationMemos([{
            id: `rsum_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId: companionId,
            bookId: book.id,
            bookTitle: book.title,
            chapterIndex: from,
            chapterTitle: chapters.find(chapter => chapter.index === from)?.title || "",
            authorType: "character",
            content,
            createdAt: new Date().toISOString(),
            kind: "summary",
            rangeLabel: summaryLabel,
        }]);
        setSummaryDraft("");
        setSummaryMemos(loadReadingSummaryMemos(book.id, book.title));
    };

    const openReadingSettings = () => {
        setPdfRenderDraft({
            pdfZoom: readingConfig.pdfZoom ?? 1,
            pdfPreloadRadius: readingConfig.pdfPreloadRadius ?? 3,
            pdfPreloadEnabled: readingConfig.pdfPreloadEnabled !== false,
        });
        setShowReadingSettings(true);
    };

    const handleReadingSettingsConfirm = () => {
        if (isPdf) {
            setReadingConfig((prev) => {
                const next = { ...prev, ...pdfRenderDraft };
                saveReadingInteractionConfig(next);
                return next;
            });
        }
        setShowReadingSettings(false);
    };

    return (
        <div ref={surfaceRef} className="reading-app-surface absolute inset-0 z-[100] flex flex-col bg-[var(--c-page-body-bg)]" data-immersive={immersive} style={{
            paddingTop: "var(--page-header-safe-top, 48px)",
            // 插图最高不超过一页能放下的高度，和分页算出来的那个数是同一个
            ...(imageMaxHeight > 0 ? { ["--reading-image-max-height" as "--reading-image-max-height"]: `${imageMaxHeight}px` } : {}),
        } as CSSProperties}
            onClick={handleSurfaceClick}
            onPointerDown={handleSurfacePointerDown}
            onPointerMove={handleSurfacePointerMove}
            onPointerUp={handleSurfacePointerEnd}
            onPointerCancel={handleSurfacePointerEnd}
            onPointerLeave={handleSurfacePointerEnd}
            onContextMenu={handleSurfaceContextMenu}
        >
            {/* Page flip overlay */}
            {flipAnim && (
                <>
                    <div
                        className={`reading-flip-overlay reading-flip-overlay--${flipAnim.direction}`}
                        onAnimationEnd={() => setFlipAnim(null)}
                    >
                        <div className="reading-flip-overlay-body">
                            {renderStaticPage(flipAnim.items)}
                        </div>
                    </div>
                    <div className={`reading-flip-shadow reading-flip-shadow--${flipAnim.direction}`} />
                </>
            )}

            {/* Header — chapter name + page info */}
            <header ref={headerRef} className={`reading-header ${immersive ? "reading-header--immersive" : "reading-header--revealed"}`} data-ui="header">
                <div className="reading-header-top">
                    <button onClick={onBack} className="page-back-btn reading-header-back">
                        <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                    <span className="reading-header-title">{isPdf ? book.title : (currentChapter?.title || book.title)}</span>
                    <div className="reading-header-right-group">
                        <button
                            type="button"
                            className="page-back-btn"
                            onClick={() => { void toggleBookmark(); }}
                            aria-label={bookmarkHere() ? "取消书签" : "加书签"}
                            aria-pressed={Boolean(bookmarkHere())}
                        >
                            <span className="reading-bookmark-icon" data-on={bookmarkHere() ? "" : undefined} aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            className="page-back-btn"
                            onClick={openNavigationDialog}
                            aria-label="目录"
                        >
                            <Menu size={18} strokeWidth={1.7} />
                        </button>
                    </div>
                </div>
                {annotationError && (
                    <div className="reading-header-status" style={{ color: "var(--c-danger)" }}>{annotationError}</div>
                )}
            </header>

            {generating && (
                <div className="reading-status-float" aria-live="polite">
                    {companion?.name || "AI"} 正在批注中...
                </div>
            )}

            {/* Character picker dropdown — above bottom avatar */}
            {showCharPicker && (
                <div className="absolute inset-0 z-40" onClick={closeCharPicker} />
            )}
            {showCharPicker && (
                <div
                    className={`absolute left-3 z-50 g-card reading-char-picker ${charPickerClosing ? "reading-char-picker--closing" : ""}`}
                    style={{ minWidth: 160, bottom: `${charPickerBottom}px`, ...chatFloatingStyle, padding: "16px 16px 16px 24px" }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="chat-contact-list" style={{ padding: "4px 6px" }}>
                        {enrichedContacts.map(c => (
                            <div
                                key={c.characterId}
                                className="chat-contact-item"
                                onClick={() => { setCompanionId(c.characterId); closeCharPicker(); generatedBatchesRef.current.clear(); prefetchedBatchStartRef.current = -1; }}
                            >
                                <div className="chat-contact-avatar"
                                    style={companionId === c.characterId ? { outline: "3px solid var(--c-success)", outlineOffset: "2px" } : undefined}
                                >
                                    {c.char.avatar ? <img src={c.char.avatar} alt="" /> : <span className="chat-contact-avatar-fallback">{c.char.name[0]}</span>}
                                </div>
                                <span className="chat-contact-name">{c.char.name}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Reading content */}
            <div
                ref={scrollRef}
                className={`relative flex-1 min-h-0 px-4 pt-1 pb-3 ${(isPdf || isScrollMode) ? "overflow-auto" : "overflow-hidden"}`}
                data-ui="body"
                onClick={handleReadingSurfaceClick}
            >
                {isPdf ? (
                    <>
                        {/* PDF native rendering */}
                        <PdfPageRenderer
                            bookId={book.id}
                            chapter={pdfAnnotationChapter}
                            annotations={pdfRenderAnnotations}
                            bilingualTranslationEnabled={bilingualTranslationEnabled}
                            collapseBilingualTranslation={readingConfig.collapseBilingualTranslation === true}
                            onTotalPages={setPdfTotalPages}
                            onCurrentPage={setPdfCurrentPage}
                            jumpToPage={pdfJumpPage}
                            onJumpComplete={handlePdfJumpComplete}
                            onCopyAnnotation={copyToClipboard}
                            onDeleteAnnotation={handleDeleteReadingAnnotation}
                            zoom={readingConfig.pdfZoom ?? 1}
                            preloadRadius={readingConfig.pdfPreloadRadius ?? 3}
                            preloadEnabled={readingConfig.pdfPreloadEnabled !== false}
                        />
                    </>
                ) : !chaptersLoaded ? (
                    null
                ) : chapters.length === 0 ? (
                    <div className="reading-debug-card">
                        <div className="reading-debug-title">TXT 数据自检</div>
                        <div className="reading-debug-line">本地章节数：0</div>
                        <div className="reading-debug-line">总段落数：0</div>
                        <div className="reading-debug-line">当前章节索引：{chapterIndex}</div>
                        <div className="reading-debug-line">当前页进度：{txtPage + 1}</div>
                        <div className="reading-debug-hint">这更像是这本书在本地 IndexedDB 里的章节数据已经空了，不是单纯分页卡住。</div>
                    </div>
                ) : !currentChapter ? (
                    <div className="reading-debug-card">
                        <div className="reading-debug-title">TXT 数据自检</div>
                        <div className="reading-debug-line">本地章节数：{chapters.length}</div>
                        <div className="reading-debug-line">总段落数：{totalParagraphs}</div>
                        <div className="reading-debug-line">当前章节索引：{chapterIndex}</div>
                        <div className="reading-debug-line">当前页进度：{txtPage + 1}/{txtTotalPages}</div>
                        <div className="reading-debug-hint">章节数据存在，但当前索引取不到正文。这个状态不是“正在加载”，而是本地章节数据和进度状态不一致。</div>
                    </div>
                ) : isScrollMode ? (
                    <div ref={scrollContentRef} className="reading-scroll-content">
                        {windowChapters.map((chapter) => (
                            <div key={chapter.id} data-chapter-index={chapter.index}>
                                {chapter.paragraphs.map((paragraph, pIndex) => {
                                    const imageMarker = parseReadingImageMarker(paragraph);
                                    if (imageMarker) {
                                        return (
                                            <div key={pIndex} className="reading-scroll-block">
                                                {renderImageItem(imageMarker, `img-${chapter.index}-${pIndex}`)}
                                            </div>
                                        );
                                    }
                                    const segmentCount = paragraph.split("\n").length;
                                    const paragraphAnnotations = annotations.filter(
                                        (annotation) => annotation.chapterIndex === chapter.index && annotation.paragraphIndex === pIndex
                                    );
                                    const sentenceNotes = paragraphAnnotations.filter(isNoteAnnotation);
                                    const paragraphComments = paragraphAnnotations.filter((a) => !isNoteAnnotation(a));
                                    return (
                                        <div key={pIndex} className="reading-scroll-block">
                                            {(() => {
                                                let charCursor = 0;
                                                const insertedNoteIds = new Set<string>();
                                                return paragraph.split("\n").map((segment, sIndex) => {
                                                    const charStart = charCursor;
                                                    const segEndOffset = charStart + segment.length;
                                                    charCursor += segment.length + 1; // 被拆掉的 \n 也占一个字符
                                                    const isLastSeg = sIndex === segmentCount - 1;
                                                    const matchingNotes = sentenceNotes.filter((note) => {
                                                        if (insertedNoteIds.has(note.id)) return false;
                                                        const targetEnd = typeof note.quoteEnd === "number" ? note.quoteEnd : paragraph.length;
                                                        if ((targetEnd > charStart && targetEnd <= segEndOffset) || (isLastSeg && targetEnd > segEndOffset)) {
                                                            insertedNoteIds.add(note.id);
                                                            return true;
                                                        }
                                                        return false;
                                                    });
                                                    return (
                                                        <div key={sIndex} className="reading-scroll-segment">
                                                            {renderLine({
                                                                kind: "line",
                                                                text: segment,
                                                                chapterIndex: chapter.index,
                                                                paragraphIndex: pIndex,
                                                                indent: true,
                                                                segEnd: isLastSeg,
                                                                charStart,
                                                                ...(isLastSeg && paragraphComments.length > 0 ? { annotationCount: paragraphComments.length } : {}),
                                                            }, sIndex)}
                                                            {matchingNotes.map((note) => renderAnnotationItem(note))}
                                                        </div>
                                                    );
                                                });
                                            })()}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                        <div className="h-[72px]" aria-hidden="true" />
                    </div>
                ) : (
                    <>
                        <div
                            className="reading-page-stage"
                            onTouchStart={handleTouchStart}
                            onTouchEnd={handleTouchEnd}
                        >
                            <div className="reading-page-surface">
                                {txtPagesReadyForCurrentChapter ? renderTxtPage(txtPage) : null}
                            </div>
                        </div>

                        <div className="reading-page-measure" aria-hidden="true">
                            <p ref={txtMeasureLineRef} className="reading-line">测</p>
                            <div ref={txtMeasureGapRef} className="reading-line-gap" />
                            <div ref={txtMeasureAnnotationRef} className="reading-annotation">
                                <span className="reading-annotation-name">角色</span>
                                <span className="reading-annotation-text">批注内容</span>
                            </div>
                        </div>
                    </>
                )}

                {loadFailed ? (
                    <div className="reading-loading-view reading-loading-view--overlay" data-no-nav="true">
                        <div className="reading-loading-copy">
                            <span className="reading-loading-title">这本书没打开</span>
                            <span className="reading-loading-subtitle">读书库的时候出错了，可能是 App 在后台待太久</span>
                        </div>
                        <button type="button" className="ui-btn ui-btn-primary" onClick={() => setLoadAttempt((n) => n + 1)}>再试一次</button>
                    </div>
                ) : showTxtLoading && (
                    <ReadingLoadingView title="正在打开书页" subtitle="正在读取并排版当前章节" overlay />
                )}

                {isPdf && <div className="h-[88px]" />}
            </div>

            {/* Immersive Page Number */}
            <span className={`reading-immersive-page ${immersive ? 'opacity-35' : 'opacity-0'}`}>
                {isPdf ? `${pdfCurrentPage}/${pdfTotalPages || "?"}` : isScrollMode ? `${Math.round(Math.max(0, Math.min(1, scrollFraction)) * 100)}%` : `${txtDisplayedPage}/${txtTotalPages}`}
            </span>

            {/* Bottom bar — mirrors header style */}
            <footer className="reading-footer" ref={footerRef}>
                <div className="reading-footer-inner">
                    <div className="reading-footer-slider-row">
                        <button
                            className="reading-footer-text-btn"
                            onClick={() => handleNavChapterClick(Math.max(0, chapterIndex - 1))}
                            disabled={chapterIndex <= 0}
                        >
                            上一章
                        </button>
                        <div className="reading-footer-slider">
                            {(() => {
                                const currentVal = isPdf ? pdfCurrentPage : txtBookSliderValue;
                                const maxVal = isPdf ? Math.max(1, currentPageCount) : txtBookSliderMax;
                                const progressPct = maxVal > 1 ? ((currentVal - 1) / (maxVal - 1)) * 100 : 0;
                                return (
                                    <input
                                        type="range"
                                        className="reading-custom-slider"
                                        min={1}
                                        max={maxVal}
                                        step={isPdf ? 1 : 0.001}
                                        value={currentVal}
                                        onChange={(e) => handleNavPageSlider(Number(e.target.value))}
                                        aria-label={isPdf ? "跳转页码" : "跳转阅读进度"}
                                        style={{ '--slider-progress': `${progressPct}%` } as React.CSSProperties}
                                    />
                                );
                            })()}
                        </div>
                        <button
                            className="reading-footer-text-btn"
                            onClick={() => handleNavChapterClick(Math.min(chapters.length - 1, chapterIndex + 1))}
                            disabled={chapterIndex >= chapters.length - 1}
                        >
                            下一章
                        </button>
                    </div>
                    <div className="reading-footer-actions">
                        <button
                            type="button"
                            className={`reading-footer-icon-btn ${autoAnnotate ? "is-active" : ""}`}
                            onClick={openCharAnnotationsPanel}
                        >
                            <Highlighter size={22} strokeWidth={1.7} />
                            <span>TA的批注</span>
                        </button>
                        <button
                            type="button"
                            className="reading-footer-icon-btn"
                            onClick={openMyAnnotationsPanel}
                        >
                            <Highlighter size={22} strokeWidth={1.7} />
                            <span>我的批注</span>
                        </button>
                        {isPdf && (
                            <button
                                type="button"
                                className="reading-footer-icon-btn"
                                onClick={openPdfPrefetchDialog}
                                disabled={generating || !companionId}
                            >
                                <Rocket size={22} strokeWidth={1.7} />
                                <span>预批注</span>
                            </button>
                        )}
                        <button
                            type="button"
                            className="reading-footer-icon-btn"
                            onClick={openReadingSettings}
                        >
                            <Languages size={22} strokeWidth={1.7} />
                            <span>设置</span>
                        </button>
                    </div>
                </div>
            </footer>

            {!showChat && (
                <button
                    onClick={handleChatLaunchClick}
                    className="reading-chat-launch"
                    aria-label="打开聊天悬浮窗"
                    title="打开聊天悬浮窗"
                    style={chatFloatingStyle}
                    onPointerDown={handleChatDragStart}
                    onPointerMove={handleChatDragMove}
                    onPointerUp={handleChatDragEnd}
                    onPointerCancel={handleChatDragEnd}
                >
                    {companion?.avatar ? (
                        <img src={companion.avatar} alt="" className="w-full h-full object-cover rounded-full" />
                    ) : (
                        <span className="ts-13">{companion?.name?.[0] || "?"}</span>
                    )}
                </button>
            )}

            {showChat && (
                <div
                    className={`reading-chat-float ${chatExpanded ? "reading-chat-float-expanded" : ""}${chatClosing ? " reading-chat-float--closing" : ""}`}
                    style={chatFloatingStyle}
                    onPointerDown={handleChatDragStart}
                    onPointerMove={handleChatDragMove}
                    onPointerUp={handleChatDragEnd}
                    onPointerCancel={handleChatDragEnd}
                >
                    {!chatExpanded ? (
                        <div className="reading-chat-float-compact">
                            <button
                                type="button"
                                onClick={() => { if (shouldIgnoreChatAction()) return; setShowCharPicker(!showCharPicker); }}
                                className="reading-bottom-avatar"
                            >
                                {companion?.avatar ? (
                                    <img src={companion.avatar} alt="" className="w-full h-full object-cover rounded-full" />
                                ) : (
                                    <span className="ts-12">{companion?.name?.[0] || "?"}</span>
                                )}
                            </button>
                            <button
                                type="button"
                                className="reading-chat-float-trigger"
                                onClick={() => { if (shouldIgnoreChatAction()) return; setChatExpanded(true); closeCharPicker(); }}
                                disabled={!companionId}
                            >
                                {companion ? `和${companion.name}讨论该章节...` : "选择陪读角色"}
                                {chatMessages.length > 0 && <span className="ml-1 ts-11 text-[var(--c-icon-active)]">({chatMessages.length})</span>}
                            </button>
                            <button type="button" onClick={() => { if (shouldIgnoreChatAction()) return; handleCloseChat(); }} className="reading-chat-float-close" aria-label="关闭聊天悬浮窗"><ChevronRight size={16} strokeWidth={2} /></button>
                        </div>
                    ) : (
                        <>
                            <div className="reading-chat-float-header">
                                <div className="reading-bottom-avatar">
                                    {companion?.avatar ? (
                                        <img src={companion.avatar} alt="" className="w-full h-full object-cover rounded-full" />
                                    ) : (
                                        <span className="ts-12">{companion?.name?.[0] || "?"}</span>
                                    )}
                                </div>
                                <div className="reading-chat-float-header-copy">
                                    <span className="reading-chat-float-title">和{companion?.name || "AI"}讨论该章节</span>
                                    <span className="reading-chat-float-subtitle">拖拽任意位置移动</span>
                                </div>
                                <button type="button" onClick={() => { if (shouldIgnoreChatAction()) return; setChatExpanded(false); }} className="reading-chat-float-close" aria-label="收起聊天窗口"><ChevronDown size={18} strokeWidth={2} /></button>
                                <button type="button" onClick={() => { if (shouldIgnoreChatAction()) return; handleCloseChat(); }} className="reading-chat-float-close" aria-label="关闭聊天悬浮窗"><Minus size={18} strokeWidth={2} /></button>
                            </div>
                            <div ref={chatListRef} className="reading-chat-float-body" onClick={() => {
                                if (activeMessageId || readingMessageMenu) closeReadingMessageMenu();
                                if (activeAnnotationId) setActiveAnnotationId(null);
                            }} onScroll={() => {
                                if (readingMessageMenu) closeReadingMessageMenu();
                            }}>
                                {chatMessages.length === 0 && (
                                    <div className="text-center ts-13 text-[var(--c-icon)] py-6">和{companion?.name}聊聊这章内容吧</div>
                                )}
                                {chatMessages.map(msg => (
                                    <div key={msg.id} className="chat-msg-wrapper" data-role={msg.role}
                                        onPointerDown={(e) => { e.stopPropagation(); handleReadingMessagePointerDown(e, msg); }}
                                        onPointerUp={(e) => { e.stopPropagation(); cancelReadingMessageLongPress(); }}
                                        onPointerCancel={cancelReadingMessageLongPress}
                                        onPointerLeave={cancelReadingMessageLongPress}
                                        onPointerMove={handleReadingMessagePointerMove}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            cancelReadingMessageLongPress();
                                            setActiveAnnotationId(null);
                                            setActiveMessageId(msg.id);
                                            setReadingMessageMenu({ messageId: msg.id, x: e.clientX, y: e.clientY });
                                        }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (readingMessageMenu && readingMessageMenu.messageId !== msg.id) closeReadingMessageMenu();
                                        }}
                                    >
                                        <div className={`chat-bubble-role-${msg.role} rounded-lg ${msg.mediaType && ["sticker", "red_packet", "transfer", "image", "location", "music_share", "xiaohongshu_note_share"].includes(msg.mediaType) ? "chat-bubble-media" : "max-w-[80%]"} break-words relative`}
                                            data-ui={msg.role === "user" ? "bubble-user" : "bubble-bot"}
                                            {...(activeMessageId === msg.id ? { "data-active": "" } : {})}>
                                            <MessageBubble
                                                msg={msg}
                                                charName={companion?.name}
                                                userName=""
                                                characterId={companionId || undefined}
                                                onUpdate={m => setChatMessages(prev => prev.map(p => p.id === m.id ? m : p))}
                                                defaultTranslationExpanded={defaultTranslationExpanded}
                                            />
                                        </div>
                                    </div>
                                ))}
                                {chatting && <div className="ts-13 text-[var(--c-icon)] py-1">{companion?.name} 正在思考...</div>}
                            </div>
                            <div className="reading-chat-float-input">
                                <input
                                    value={chatInput}
                                    onChange={e => setChatInput(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                                    placeholder="输入消息..."
                                    className="ui-input flex-1"
                                    disabled={chatting}
                                />
                                <button
                                    onClick={handleSend}
                                    disabled={!chatInput.trim() || chatting}
                                    className="reading-chat-send-btn"
                                    aria-label="发送"
                                ><SendHorizontal size={18} strokeWidth={1.8} /></button>
                            </div>
                        </>
                    )}
                </div>
            )}

            {activeReadingMenuMessage && readingMessageMenu && (
                <div
                    className="ctx-menu chat-floating-ctx-menu reading-chat-context-menu flex py-[6px] px-0"
                    data-role={activeReadingMenuMessage.role}
                    style={getReadingMessageMenuStyle(readingMessageMenu)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={() => {
                            copyToClipboard(activeReadingMenuMessage.content);
                            closeReadingMessageMenu();
                        }}
                        className="ctx-menu-btn"
                    >复制</button>
                    <button
                        type="button"
                        onClick={() => handleEditDiscussMessageStart(activeReadingMenuMessage)}
                        className="ctx-menu-btn"
                    >编辑</button>
                    <button
                        type="button"
                        onClick={() => {
                            deleteChatMessage(activeReadingMenuMessage.id);
                            setChatMessages((prev) => prev.filter((msg) => msg.id !== activeReadingMenuMessage.id));
                            closeReadingMessageMenu();
                        }}
                        className="ctx-menu-btn ctx-menu-btn-danger"
                    >删除</button>
                </div>
            )}

            {editingDiscussMessage && (
                <ContentDialog
                    title="编辑共读消息"
                    confirmLabel="保存"
                    cancelLabel="取消"
                    onConfirm={handleSaveDiscussMessageEdit}
                    onCancel={() => {
                        setEditingDiscussMessage(null);
                        setEditingDiscussContent("");
                    }}
                >
                    <div className="reading-discuss-edit">
                        <textarea
                            className="ui-textarea reading-discuss-edit-textarea"
                            value={editingDiscussContent}
                            onChange={(event) => setEditingDiscussContent(event.target.value)}
                            rows={6}
                        />
                    </div>
                </ContentDialog>
            )}

            {annotationDialogMode && (
                <ContentDialog
                    title={annotationDialogMode === "manual" ? "生成批注" : autoAnnotate ? "关闭自动批注" : "开启自动批注"}
                    confirmLabel={annotationDialogMode === "manual" ? "生成" : autoAnnotate ? "关闭" : "开启"}
                    cancelLabel="取消"
                    onConfirm={() => { void handleAnnotationDialogConfirm(); }}
                    onCancel={() => setAnnotationDialogMode(null)}
                >
                    <div className="reading-settings-grid">
                        {annotationDialogMode === "auto" && autoAnnotate ? (
                            <>
                                <div className="reading-settings-inline-note">
                                    <span>当前状态</span>
                                    <span>自动批注已开启</span>
                                </div>
                                <div className="reading-settings-inline-note">
                                    <span>批注单位</span>
                                    <span>{annotationBatchSize}{isPdf ? " 页" : " 段"}</span>
                                </div>
                            </>
                        ) : (
                            <>
                                <label className="reading-settings-label">
                                    <span>
                                        {annotationDialogMode === "manual"
                                            ? (isPdf
                                                ? `从当前页开始，往后几页交给${companion?.name || "AI"}批注`
                                                : `从这一屏的第一段开始，往后几段交给${companion?.name || "AI"}批注（读完本章会接着下一章）`)
                                            : (isPdf
                                                ? `每批几页。开启后先生成当前页所在的一批，之后翻到新一批的第一页时自动生成`
                                                : `每批几段。开启后先生成当前段落所在的一批，之后读到新一批时自动生成`)}
                                    </span>
                                    <input
                                        value={annotationBatchInput}
                                        onChange={(e) => setAnnotationBatchInput(e.target.value.replace(/[^\d]/g, ""))}
                                        className="ui-input"
                                        inputMode="numeric"
                                    />
                                </label>
                                <div className="reading-settings-inline-note">
                                    <span>本次范围</span>
                                    <span>{annotationRangePreview || "（翻到正文页后才能算范围）"}</span>
                                </div>
                                <div className="reading-settings-inline-note">
                                    <span>默认值</span>
                                    <span>{isPdf ? "5 页" : "50 段"}</span>
                                </div>
                            </>
                        )}
                    </div>
                </ContentDialog>
            )}
            {pdfPrefetchDialogOpen && (
                <ContentDialog
                    title="PDF 预批注"
                    confirmLabel="开始预批注"
                    cancelLabel="取消"
                    onConfirm={() => { void handlePdfManualPrefetch(); }}
                    onCancel={() => setPdfPrefetchDialogOpen(false)}
                >
                    <div className="reading-settings-grid">
                        <p className="reading-settings-inline-note">
                            <span>为指定页码范围提前生成批注（先解析文本层再生成，翻到那里就是现成的）。</span>
                        </p>
                        <div className="reading-settings-inline-note">
                            <span>起始页</span>
                            <input
                                value={pdfPrefetchStartInput}
                                onChange={(e) => setPdfPrefetchStartInput(e.target.value.replace(/[^\d]/g, ""))}
                                className="ui-input"
                                inputMode="numeric"
                            />
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>结束页</span>
                            <input
                                value={pdfPrefetchEndInput}
                                onChange={(e) => setPdfPrefetchEndInput(e.target.value.replace(/[^\d]/g, ""))}
                                className="ui-input"
                                inputMode="numeric"
                            />
                        </div>
                        <p className="reading-settings-inline-note">
                            <span>当前第 {Math.max(1, pdfCurrentPage)} / {Math.max(1, pdfTotalPages)} 页。一次最多 {MAX_MANUAL_PDF_PREFETCH_PAGES} 页。</span>
                        </p>
                        {annotationError && (
                            <p className="reading-settings-inline-note" style={{ color: "var(--c-danger)" }}>
                                <span>{annotationError}</span>
                            </p>
                        )}
                    </div>
                </ContentDialog>
            )}
            {/* 选中句子后两端的拖动把手：往左 / 往右拖就能扩大划线范围 */}
            {sentenceMenu && sentenceHandles && (
                <>
                    {(["start", "end"] as const).map((side) => (
                        <button
                            key={side}
                            type="button"
                            className="reading-sentence-handle"
                            data-side={side}
                            data-no-nav="true"
                            aria-label={side === "start" ? "拖动改变起点" : "拖动改变终点"}
                            style={{ left: sentenceHandles[side].x, top: sentenceHandles[side].y }}
                            onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                sentenceDragRef.current = { side, pointerId: e.pointerId };
                            }}
                            onClick={(e) => e.stopPropagation()}
                        />
                    ))}
                </>
            )}
            {selectionInfo && (
                <div
                    className="reading-selection-menu"
                    style={selectionMenuStyle(selectionInfo.placeAtTop, selectionInfo.topOffset, footerHeight)}
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    <button type="button" onClick={() => addMark("highlight")}>高亮</button>
                    <button type="button" onClick={() => addMark("underline")}>划线</button>
                    <button type="button" onClick={clearSelection}>取消</button>
                </div>
            )}
            {sentenceMenu && (() => {
                const { chapterIndex: cIdx, paragraphIndex: pIdx, start, end, text } = sentenceMenu;
                const hasHighlight = marks.some(
                    (m) =>
                        m.chapterIndex === cIdx &&
                        m.paragraphIndex === pIdx &&
                        m.style === "highlight" &&
                        m.start < end &&
                        m.end > start,
                );
                const hasUnderline = marks.some(
                    (m) =>
                        m.chapterIndex === cIdx &&
                        m.paragraphIndex === pIdx &&
                        m.style === "underline" &&
                        m.start < end &&
                        m.end > start,
                );
                const isMarked = hasHighlight || hasUnderline;
                return (
                    <div
                        className={`reading-sentence-menu${sentenceMenu.placeAbove ? " reading-sentence-menu--above" : ""}`}
                        style={{
                            left: sentenceMenu.x,
                            top: sentenceMenu.y,
                        }}
                        data-no-nav="true"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            type="button"
                            className="reading-sentence-menu-btn"
                            onClick={() => openParagraphCommentDialog(cIdx, pIdx)}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                            </svg>
                            <span>发段评</span>
                        </button>
                        <button
                            type="button"
                            className="reading-sentence-menu-btn"
                            onClick={() => {
                                copyToClipboard(text);
                                setSentenceMenu(null);
                            }}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                            <span>复制</span>
                        </button>
                        <button
                            type="button"
                            className={`reading-sentence-menu-btn${hasHighlight ? " is-active" : ""}`}
                            onClick={() => toggleSentenceMark("highlight")}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="m9 11-6 6v3h9l3-3" />
                                <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
                            </svg>
                            <span>{hasHighlight ? "取消高亮" : "高亮"}</span>
                        </button>
                        <button
                            type="button"
                            className={`reading-sentence-menu-btn${hasUnderline ? " is-active" : ""}`}
                            onClick={() => toggleSentenceMark("underline")}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <path d="M6 4v6a6 6 0 0 0 12 0V4" />
                                <line x1="4" y1="20" x2="20" y2="20" />
                            </svg>
                            <span>{hasUnderline ? "取消划线" : "划线"}</span>
                        </button>
                        {isMarked && (
                            <button
                                type="button"
                                className="reading-sentence-menu-btn"
                                onClick={() => {
                                    setPendingQuote({
                                        text,
                                        chapterIndex: cIdx,
                                        paragraphIndex: pIdx,
                                        start,
                                        end,
                                    });
                                    setMyAnnotationText("");
                                    setSentenceMenu(null);
                                    setShowMyAnnotation(true);
                                }}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M12 20h9" />
                                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                </svg>
                                <span>批注</span>
                            </button>
                        )}
                        <button
                            type="button"
                            className="reading-sentence-menu-btn"
                            onClick={() => {
                                const existingMark = marks.find(
                                    (m) =>
                                        m.chapterIndex === cIdx &&
                                        m.paragraphIndex === pIdx &&
                                        m.start < end &&
                                        m.end > start,
                                );
                                if (existingMark) {
                                    openShareDialog(existingMark);
                                } else {
                                    setShareTarget([{
                                        id: `temp_share_${Date.now()}`,
                                        bookId: book.id,
                                        chapterIndex: cIdx,
                                        paragraphIndex: pIdx,
                                        start,
                                        end,
                                        text,
                                        style: "highlight",
                                        createdAt: new Date().toISOString(),
                                        authorType: "user",
                                    }]);
                                    setSentenceMenu(null);
                                }
                            }}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="18" cy="5" r="3" />
                                <circle cx="6" cy="12" r="3" />
                                <circle cx="18" cy="19" r="3" />
                                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                            </svg>
                            <span>分享</span>
                        </button>
                        <button
                            type="button"
                            className="reading-sentence-menu-btn"
                            onClick={() => setSentenceMenu(null)}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                            <span>取消</span>
                        </button>
                    </div>
                );
            })()}
            {activeParagraphCommentModal && (() => {
                const { chapterIndex: cIdx, paragraphIndex: pIdx } = activeParagraphCommentModal;
                const allComments = annotations
                    .filter(
                        (a) =>
                            a.chapterIndex === cIdx &&
                            a.paragraphIndex === pIdx &&
                            !isNoteAnnotation(a),
                    )
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
                const topLevelComments = allComments.filter((c) => !c.parentId);
                const repliesByParent = new Map<string, ReadingAnnotation[]>();
                const topIds = new Set(topLevelComments.map((c) => c.id));
                for (const c of allComments) {
                    if (!c.parentId) continue;
                    // 若 parentId 指向二级回复，则向上追溯到所属主评论；若主评论已不存在则不再强行挂到别的顶层评论下
                    let rootId: string | undefined = c.parentId;
                    const visited = new Set<string>();
                    while (rootId && !topIds.has(rootId) && !visited.has(rootId)) {
                        visited.add(rootId);
                        rootId = allComments.find((item) => item.id === rootId)?.parentId;
                    }
                    if (!rootId || !topIds.has(rootId)) continue;
                    const list = repliesByParent.get(rootId) || [];
                    list.push(c);
                    repliesByParent.set(rootId, list);
                }

                const resolveCommentAuthor = (item: ReadingAnnotation) => {
                    if (isUserAnnotation(item)) {
                        return {
                            name: userDisplayName || "我",
                            avatar: userAvatarUrl,
                        };
                    }
                    const char = (item.characterId && characterById.get(item.characterId)) || companion;
                    return {
                        name: item.characterName || char?.name || "TA",
                        avatar: char?.avatar || "",
                    };
                };

                /** 每条段评 / 回复右上角的「⋯」。编辑、删除原来直接摆在外面，
                 *  手指一滑就误删，改成点开菜单再选。 */
                const renderCommentActions = (item: ReadingAnnotation, label: string) => {
                    const open = commentActionMenuId === item.id;
                    return (
                        <div className="reading-comment-head-actions" style={{ position: "relative" }}>
                            <button
                                type="button"
                                className="reading-comment-more-btn"
                                aria-label={`${label}操作`}
                                aria-haspopup="menu"
                                aria-expanded={open}
                                // 内联样式：阅读区没有单独的样式文件承接这个新按钮，
                                // 不写就会退回浏览器默认的灰底方块
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: 28,
                                    height: 28,
                                    padding: 0,
                                    border: "none",
                                    borderRadius: 6,
                                    background: open ? "var(--c-panel-border)" : "transparent",
                                    color: "var(--c-icon)",
                                    cursor: "pointer",
                                }}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setCommentActionMenuId(open ? null : item.id);
                                }}
                            >
                                <MoreHorizontal size={18} strokeWidth={2} />
                            </button>
                            {open && (
                                <>
                                    {/* 铺一层透明遮罩接点击：点别处就收起，也免得点空时落到下面的评论上 */}
                                    <div
                                        style={{ position: "fixed", inset: 0, zIndex: 40 }}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setCommentActionMenuId(null);
                                        }}
                                    />
                                    <div
                                        className="ctx-menu"
                                        role="menu"
                                        style={{
                                            position: "absolute",
                                            top: "calc(100% + 4px)",
                                            right: 0,
                                            zIndex: 41,
                                            minWidth: 104,
                                            // 纵向排列：左边图标、右边文字，一行一项
                                            display: "flex",
                                            flexDirection: "column",
                                            padding: 4,
                                            gap: 2,
                                        }}
                                        onClick={(event) => event.stopPropagation()}
                                    >
                                        <button
                                            type="button"
                                            className="ctx-menu-btn"
                                            role="menuitem"
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 8,
                                                width: "100%",
                                                padding: "8px 10px",
                                                border: "none",
                                                borderRadius: 6,
                                                background: "transparent",
                                                color: "inherit",
                                                textAlign: "left",
                                                cursor: "pointer",
                                            }}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                setCommentActionMenuId(null);
                                                setEditingAnnotation(item);
                                                setEditingText(item.content);
                                            }}
                                        >
                                            <PenLine size={15} strokeWidth={1.8} aria-hidden="true" />
                                            <span>编辑</span>
                                        </button>
                                        <button
                                            type="button"
                                            className="ctx-menu-btn ctx-menu-btn-danger"
                                            role="menuitem"
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 8,
                                                width: "100%",
                                                padding: "8px 10px",
                                                border: "none",
                                                borderRadius: 6,
                                                background: "transparent",
                                                color: "var(--c-danger)",
                                                textAlign: "left",
                                                cursor: "pointer",
                                            }}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                setCommentActionMenuId(null);
                                                void handleDeleteReadingAnnotation(item.id);
                                            }}
                                        >
                                            <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                                            <span>删除</span>
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    );
                };

                return (
                    <div
                        className="reading-comment-modal-backdrop"
                        data-no-nav="true"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            setActiveParagraphCommentModal(null);
                            setParagraphCommentReplyTarget(null);
                            setCommentActionMenuId(null);
                        }}
                    >
                        <div
                            className="reading-comment-modal"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="reading-comment-modal-header">
                                <span className="reading-comment-modal-header-spacer" aria-hidden="true" />
                                <span className="reading-comment-modal-title">{allComments.length}条评论</span>
                                <button
                                    type="button"
                                    className={`reading-comment-modal-refresh${generatingParagraphComment ? " is-spinning" : ""}`}
                                    onClick={() => { void handleRefreshCompanionParagraphComment(); }}
                                    disabled={generatingParagraphComment || !companionId}
                                    title={companion ? `让${companion.name}发段评` : "请先选择陪读角色"}
                                    aria-label="刷新触发陪读角色发送段评"
                                >
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                                        <path d="M3 3v5h5" />
                                        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                                        <path d="M16 16h5v5" />
                                    </svg>
                                </button>
                            </div>
                            <div className="reading-comment-modal-list">
                                {topLevelComments.length === 0 ? (
                                    <div className="reading-comment-modal-empty">
                                        还没有段评，发一条开启互动，或点击右上角刷新让{companion?.name || "陪读角色"}发段评吧
                                    </div>
                                ) : (
                                    topLevelComments.map((comment) => {
                                        const author = resolveCommentAuthor(comment);
                                        const replies = repliesByParent.get(comment.id) || [];
                                        return (
                                            <div key={comment.id} className="reading-comment-thread">
                                                <div className="reading-comment-item">
                                                    <div className="reading-comment-avatar">
                                                        {author.avatar ? (
                                                            // eslint-disable-next-line @next/next/no-img-element
                                                            <img src={author.avatar} alt="" />
                                                        ) : (
                                                            <span>{author.name.slice(0, 1)}</span>
                                                        )}
                                                    </div>
                                                    <div className="reading-comment-main">
                                                        <div className="reading-comment-name-row">
                                                            <span className="reading-comment-name">{author.name}</span>
                                                            {renderCommentActions(comment, "段评")}
                                                        </div>
                                                        <div className="reading-comment-content">{comment.content}</div>
                                                        <div className="reading-comment-meta">
                                                            <span className="reading-comment-time">{formatCommentTimestamp(comment.createdAt)}</span>
                                                            <button
                                                                type="button"
                                                                className="reading-comment-reply-btn"
                                                                onClick={() => {
                                                                    setParagraphCommentReplyTarget({
                                                                        id: comment.id,
                                                                        parentId: comment.id,
                                                                        authorName: author.name,
                                                                        content: comment.content,
                                                                    });
                                                                }}
                                                            >
                                                                回复
                                                            </button>
                                                        </div>
                                                        {replies.length > 0 && (
                                                            <div className="reading-comment-replies">
                                                                {replies.map((reply) => {
                                                                    const replyAuthor = resolveCommentAuthor(reply);
                                                                    return (
                                                                        <div key={reply.id} className="reading-comment-reply-item">
                                                                            <div className="reading-comment-avatar reading-comment-avatar--small">
                                                                                {replyAuthor.avatar ? (
                                                                                    // eslint-disable-next-line @next/next/no-img-element
                                                                                    <img src={replyAuthor.avatar} alt="" />
                                                                                ) : (
                                                                                    <span>{replyAuthor.name.slice(0, 1)}</span>
                                                                                )}
                                                                            </div>
                                                                            <div className="reading-comment-main">
                                                                                <div className="reading-comment-name-row">
                                                                                    <span className="reading-comment-name">
                                                                                        {replyAuthor.name}
                                                                                        {reply.replyToName ? (
                                                                                            <span className="reading-comment-reply-to"> 回复 {reply.replyToName}</span>
                                                                                        ) : null}
                                                                                    </span>
                                                                                    {renderCommentActions(reply, "回复")}
                                                                                </div>
                                                                                <div className="reading-comment-content">{reply.content}</div>
                                                                                <div className="reading-comment-meta">
                                                                                    <span className="reading-comment-time">{formatCommentTimestamp(reply.createdAt)}</span>
                                                                                    <button
                                                                                        type="button"
                                                                                        className="reading-comment-reply-btn"
                                                                                        onClick={() => {
                                                                                            setParagraphCommentReplyTarget({
                                                                                                id: reply.id,
                                                                                                parentId: comment.id,
                                                                                                authorName: replyAuthor.name,
                                                                                                content: reply.content,
                                                                                            });
                                                                                        }}
                                                                                    >
                                                                                        回复
                                                                                    </button>
                                                                                </div>
                                                                            </div>
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                            <div className="reading-comment-modal-footer">
                                {paragraphCommentReplyTarget && (
                                    <div className="reading-comment-reply-banner">
                                        <span>回复 @{paragraphCommentReplyTarget.authorName}</span>
                                        <button
                                            type="button"
                                            onClick={() => setParagraphCommentReplyTarget(null)}
                                            aria-label="取消回复"
                                        >
                                            取消
                                        </button>
                                    </div>
                                )}
                                <div className="reading-comment-input-row">
                                    <input
                                        type="text"
                                        className="reading-comment-input"
                                        value={paragraphCommentDraft}
                                        onChange={(e) => setParagraphCommentDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" && !e.shiftKey) {
                                                e.preventDefault();
                                                void handleSendParagraphComment();
                                            }
                                        }}
                                        placeholder={
                                            paragraphCommentReplyTarget
                                                ? `回复 ${paragraphCommentReplyTarget.authorName}...`
                                                : "发一条段评..."
                                        }
                                    />
                                    <button
                                        type="button"
                                        className="reading-comment-send-btn"
                                        disabled={!paragraphCommentDraft.trim()}
                                        onClick={() => { void handleSendParagraphComment(); }}
                                    >
                                        发送
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })()}
            {shareTarget && shareTarget.length > 0 && (() => {
                const first = shareTarget[0];
                const chapter = chapters[first.chapterIndex];
                // 这段话在全书的位置：章内按「这一段之前有多少字」算，再换算到全书
                const charsBefore = (chapter?.paragraphs || [])
                    .slice(0, first.paragraphIndex)
                    .reduce((sum, paragraph) => sum + paragraph.length, 0) + first.start;
                const chapterChars = chapterCharStats.lengths[first.chapterIndex] || 0;
                const withinChapter = chapterChars > 0 ? charsBefore / chapterChars : 0;
                // 这几段上已有的批注也能一起带进图里。
                // 段评（段落下面那一串评论和回复）不进摘抄图：分享的是这段话和批注心得，
                // 不是评论区。
                const markedParagraphs = new Set(shareTarget.map(item => `${item.chapterIndex}:${item.paragraphIndex}`));
                const relatedAnnotations = annotations
                    .filter(annotation => markedParagraphs.has(`${annotation.chapterIndex}:${annotation.paragraphIndex}`))
                    .filter(annotation => isNoteAnnotation(annotation))
                    .sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.createdAt.localeCompare(b.createdAt))
                    .map(annotation => ({
                        name: isUserAnnotation(annotation) ? (userDisplayName || "我") : (annotation.characterName || "TA"),
                        content: annotation.content,
                        authorType: (isUserAnnotation(annotation) ? "user" : "character") as "user" | "character",
                    }));
                return (
                    <ReadingShareDialog
                        quoteParagraphs={shareTarget.map(item => item.text)}
                        bookTitle={book.title}
                        bookAuthor={book.author || ""}
                        chapterTitle={chapter?.title || ""}
                        progressPercent={toBookFraction(first.chapterIndex, withinChapter) * 100}
                        annotations={relatedAnnotations}
                        onClose={() => setShareTarget(null)}
                    />
                );
            })()}
            {showCharAnnotationMenu && (
                <ContentDialog
                    title="TA的批注"
                    confirmLabel="关闭"
                    cancelLabel=""
                    onConfirm={() => setShowCharAnnotationMenu(false)}
                    onCancel={() => setShowCharAnnotationMenu(false)}
                >
                    <div className="reading-settings-grid">
                        {(() => {
                            // 这里是「批注」列表：只列写在句子旁边的批注。
                            // 段评是段落下面那串评论与回复，只在段末 💬 弹窗里出现，不进这里。
                            const theirs = panelAnnotations.filter(a => !isUserAnnotation(a) && isNoteAnnotation(a));
                            const indexes = Array.from(new Set(theirs.map(a => a.chapterIndex))).sort((a, b) => a - b);
                            const sections = indexes.map(index => {
                                const rows = theirs
                                    .filter(a => a.chapterIndex === index)
                                    .sort((a, b) => a.paragraphIndex - b.paragraphIndex);
                                return {
                                    index,
                                    count: rows.length,
                                    rows: (
                                        <>
                                            {rows.map(annotation => renderAnnotationRow(
                                                annotation,
                                                () => { void removeAnnotationEverywhere(annotation.id); },
                                            ))}
                                        </>
                                    ),
                                };
                            });
                            return renderChapterFoldList(sections, "TA 还没有在这本书上写批注");
                        })()}
                    </div>
                </ContentDialog>
            )}
            {showMyMarksPanel && (
                <ContentDialog
                    title="我的批注"
                    confirmLabel="关闭"
                    cancelLabel=""
                    onConfirm={() => setShowMyMarksPanel(false)}
                    onCancel={() => setShowMyMarksPanel(false)}
                >
                    <div className="reading-settings-grid">
                        {(() => {
                            const indexes = Array.from(new Set([
                                ...panelAnnotations.filter(a => isUserAnnotation(a) && isNoteAnnotation(a)).map(a => a.chapterIndex),
                                ...marks.map(m => m.chapterIndex),
                            ])).sort((a, b) => a - b);

                            const sections = indexes.map(index => {
                                // 同上：段评不进批注列表，只留写在句子旁边的批注
                                const mine = panelAnnotations
                                    .filter(a => a.chapterIndex === index && isUserAnnotation(a) && isNoteAnnotation(a))
                                    .sort((a, b) => a.paragraphIndex - b.paragraphIndex);
                                // 跨段划选出来的几条是一次划选，这里按组合成一行，
                                // 否则一次跨三段的高亮会在列表里排成三条，看着像划了三次
                                const groupedMarks = new Map<string, ReadingMark[]>();
                                for (const mark of marks.filter(m => m.chapterIndex === index)) {
                                    const key = readingMarkGroupId(mark);
                                    const bucket = groupedMarks.get(key);
                                    if (bucket) bucket.push(mark);
                                    else groupedMarks.set(key, [mark]);
                                }
                                // 已经写了批注的标记不再单独列一条：批注那条里就带着这段原文
                                const annotatedQuotes = new Set(mine.map(a => (a.quote ?? "").replace(/\s+/g, "")));
                                const chapterMarks = [...groupedMarks.values()]
                                    .map(group => group.sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.start - b.start))
                                    .filter(group => !annotatedQuotes.has(group.map(m => m.text).join("").replace(/\s+/g, "")))
                                    .sort((a, b) => a[0].paragraphIndex - b[0].paragraphIndex || a[0].start - b[0].start);
                                return {
                                    index,
                                    count: mine.length + chapterMarks.length,
                                    rows: (
                                        <>
                                            {mine.map(annotation => renderAnnotationRow(
                                                annotation,
                                                () => { void removeAnnotationEverywhere(annotation.id); },
                                            ))}
                                            {chapterMarks.map(group => (
                                                <div key={group[0].id} className="reading-mark-row">
                                                    {renderJumpableQuote(
                                                        group.map(mark => mark.text).join("").slice(0, 40),
                                                        group[0].chapterIndex,
                                                        group[0].paragraphIndex,
                                                        "reading-mark",
                                                        group[0].style,
                                                    )}
                                                    <button type="button" onClick={() => {
                                                        const ids = new Set(group.map(mark => mark.id));
                                                        group.forEach(mark => deleteReadingMark(book.id, mark.id));
                                                        setMarks(prev => prev.filter(item => !ids.has(item.id)));
                                                    }}>删除</button>
                                                </div>
                                            ))}
                                        </>
                                    ),
                                };
                            }).filter(section => section.count > 0);

                            return renderChapterFoldList(sections, "这本书还没有你的批注或标记");
                                                })()}
                    </div>
                </ContentDialog>
            )}
            {editingAnnotation && (
                <ContentDialog
                    title={isUserAnnotation(editingAnnotation) ? "编辑我的批注" : `编辑${editingAnnotation.characterName || "TA"}的批注`}
                    confirmLabel="保存"
                    cancelLabel="取消"
                    onConfirm={() => { void saveEditedAnnotation(); }}
                    onCancel={() => { setEditingAnnotation(null); setEditingText(""); }}
                >
                    <div className="reading-settings-grid">
                        {editingAnnotation.quote && (
                            <div className="reading-my-annotation-quote">{editingAnnotation.quote}</div>
                        )}
                        <textarea
                            className="reading-my-annotation-input"
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                            rows={5}
                            autoFocus
                        />
                        <div className="reading-settings-inline-note">
                            <span>说明</span>
                            <span>改完之后记忆区里那条也会跟着改。</span>
                        </div>
                    </div>
                </ContentDialog>
            )}
            {showMyAnnotation && pendingQuote && (
                <ContentDialog
                    title="我的批注"
                    confirmLabel="保存"
                    cancelLabel="取消"
                    onConfirm={() => { void saveMyAnnotation(); }}
                    onCancel={() => { setShowMyAnnotation(false); setPendingQuote(null); }}
                >
                    <div className="reading-settings-grid">
                        <div className="reading-my-annotation-quote">{pendingQuote.text}</div>
                        <textarea
                            className="reading-my-annotation-input"
                            value={myAnnotationText}
                            onChange={(e) => setMyAnnotationText(e.target.value)}
                            placeholder="写下你对这一段的想法……"
                            rows={4}
                        />
                    </div>
                </ContentDialog>
            )}
            {showRangeSummary && (
                <ContentDialog
                    title="总结内容"
                    confirmLabel={summaryDraft.trim() ? "存进记忆" : "关闭"}
                    cancelLabel="取消"
                    onConfirm={() => { if (summaryDraft.trim()) saveRangeSummary(); else setShowRangeSummary(false); }}
                    onCancel={() => setShowRangeSummary(false)}
                >
                    <div className="reading-settings-grid">
                        <label className="reading-settings-label">
                            <span>从</span>
                            <Select
                                value={String(summaryRange.start)}
                                onChange={(e) => setSummaryRange(prev => ({ ...prev, start: Number(e.target.value) }))}
                            >
                                {chapters.map(chapter => (
                                    <option key={chapter.id} value={chapter.index}>
                                        {chapter.title?.trim() || `第${chapter.index + 1}章`}
                                    </option>
                                ))}
                            </Select>
                        </label>
                        <label className="reading-settings-label">
                            <span>到</span>
                            <Select
                                value={String(summaryRange.end)}
                                onChange={(e) => setSummaryRange(prev => ({ ...prev, end: Number(e.target.value) }))}
                            >
                                {chapters.map(chapter => (
                                    <option key={chapter.id} value={chapter.index}>
                                        {chapter.title?.trim() || `第${chapter.index + 1}章`}
                                    </option>
                                ))}
                            </Select>
                        </label>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { void runRangeSummary(); }}
                            disabled={summaryBusy || !companionId}
                        >
                            {summaryBusy ? "总结中…" : summaryDraft ? "重新总结" : "生成总结"}
                        </button>
                        {summaryDraft && (
                            <textarea
                                className="reading-my-annotation-input"
                                value={summaryDraft}
                                onChange={(e) => setSummaryDraft(e.target.value)}
                                rows={4}
                            />
                        )}
                        {summaryNote && (
                            <div className="reading-settings-inline-note"><span>{summaryNote}</span></div>
                        )}
                        {summaryMemos.length > 0 && (
                            <>
                                <div className="reading-settings-inline-note">
                                    <span>已存的摘要</span>
                                </div>
                                {summaryMemos.map(memo => (
                                    <div key={memo.id} className="reading-mark-row">
                                        <span className="reading-my-annotation-row-body">
                                            <span className="reading-my-annotation-row-quote">{memo.rangeLabel || memo.chapterTitle}</span>
                                            <span>{memo.content}</span>
                                        </span>
                                        <button type="button" onClick={() => {
                                            deleteReadingAnnotationMemo(memo.id);
                                            setSummaryMemos(prev => prev.filter(item => item.id !== memo.id));
                                        }}>删除</button>
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                </ContentDialog>
            )}
            {showTranslationDialog && (
                <ContentDialog
                    title="批注翻译"
                    confirmLabel="完成"
                    cancelLabel="关闭"
                    onConfirm={() => setShowTranslationDialog(false)}
                    onCancel={() => setShowTranslationDialog(false)}
                >
                    <div className="reading-settings-grid">
                        <div className="reading-settings-inline-note">
                            <span>启用阅读双语翻译</span>
                            <Toggle
                                checked={bilingualTranslationEnabled}
                                onChange={(checked) => {
                                    const next = { ...readingConfig, bilingualTranslationEnabled: checked };
                                    setReadingConfig(next);
                                    saveReadingInteractionConfig(next);
                                }}
                            />
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>折叠中文译文</span>
                            <Toggle
                                checked={readingConfig.collapseBilingualTranslation === true}
                                onChange={(checked) => {
                                    const next = { ...readingConfig, collapseBilingualTranslation: checked };
                                    setReadingConfig(next);
                                    saveReadingInteractionConfig(next);
                                }}
                            />
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>说明</span>
                            <span>只翻译 AI 讨论消息和 AI 批注，不翻书正文</span>
                        </div>
                        {bilingualTranslationEnabled && (
                            <div className="reading-settings-prompt">
                                <div className="reading-settings-prompt-head">
                                    <span>双语提示词</span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const next = {
                                                ...readingConfig,
                                                bilingualTranslationPrompt: DEFAULT_READING_INTERACTION_CONFIG.bilingualTranslationPrompt,
                                            };
                                            setReadingConfig(next);
                                            saveReadingInteractionConfig(next);
                                        }}
                                    >
                                        恢复默认
                                    </button>
                                </div>
                                <textarea
                                    className="ui-input"
                                    rows={7}
                                    value={readingConfig.bilingualTranslationPrompt}
                                    onChange={(event) => {
                                        const next = { ...readingConfig, bilingualTranslationPrompt: event.target.value };
                                        setReadingConfig(next);
                                        saveReadingInteractionConfig(next);
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </ContentDialog>
            )}
            {showReadingSettings && (
                <ContentDialog
                    title="阅读设置"
                    confirmLabel="完成"
                    cancelLabel="关闭"
                    onConfirm={handleReadingSettingsConfirm}
                    onCancel={() => setShowReadingSettings(false)}
                >
                    <div className="reading-settings-grid">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { setShowReadingSettings(false); openAnnotationDialog("manual"); }}
                            disabled={generating || !companionId}
                        >
                            现在批注
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { setShowReadingSettings(false); openAnnotationDialog("auto"); }}
                        >
                            {autoAnnotate ? "自动批注：已开启" : "自动批注：已关闭"}
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { setShowReadingSettings(false); openRangeSummary(); }}
                            disabled={!companionId}
                        >
                            总结内容
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => setShowBookmarks(true)}
                        >
                            书签{bookmarks.length > 0 ? `（${bookmarks.length}）` : ""}
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { void exportAnnotations(); }}
                        >
                            导出全书批注（Markdown）
                        </button>
                        {exportNote && (
                            <div className="reading-settings-inline-note"><span>{exportNote}</span></div>
                        )}
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => { setShowReadingSettings(false); setShowTranslationDialog(true); }}
                        >
                            批注翻译
                        </button>
                        <div className="reading-settings-inline-note">
                            <span>批注密度</span>
                            <span className="reading-interval-row">
                                每
                                <input
                                    className="reading-interval-input"
                                    type="number"
                                    min={0}
                                    max={999}
                                    step={1}
                                    inputMode="numeric"
                                    value={readingConfig.annotationInterval}
                                    onChange={(e) => {
                                        const parsed = Math.floor(Number(e.target.value));
                                        const next = {
                                            ...readingConfig,
                                            annotationInterval: Number.isFinite(parsed) ? Math.min(999, Math.max(0, parsed)) : 0,
                                        };
                                        setReadingConfig(next);
                                        saveReadingInteractionConfig(next);
                                    }}
                                />
                                段 1 条
                            </span>
                        </div>
                        <div className="reading-settings-inline-note">
                            <span>说明</span>
                            <span>批注密度填 0 表示不限，由角色自己决定写多少</span>
                        </div>
                        {isPdf && (
                            <section className="reading-settings-group">
                                <div className="reading-settings-heading">
                                    <ZoomIn size={15} />
                                    <span>PDF 渲染</span>
                                </div>
                                <div className="reading-settings-toggle-row">
                                    <span className="reading-settings-toggle-label">预加载后续页</span>
                                    <Toggle
                                        checked={pdfRenderDraft.pdfPreloadEnabled}
                                        onChange={(next) => setPdfRenderDraft((prev) => ({ ...prev, pdfPreloadEnabled: next }))}
                                    />
                                </div>
                                <p className="reading-settings-inline-note">
                                    <span>开启后阅读时会提前渲染当前页之后的页面，滚动更平滑；关闭则只渲染屏幕内的页。</span>
                                </p>
                                <div className="reading-settings-inline-note">
                                    <span>页面缩放率</span>
                                    <span>{Math.round(pdfRenderDraft.pdfZoom * 100)}%</span>
                                </div>
                                <input
                                    type="range"
                                    className="w-full my-1"
                                    min={0.5}
                                    max={2}
                                    step={0.05}
                                    value={pdfRenderDraft.pdfZoom}
                                    onChange={(e) => setPdfRenderDraft((prev) => ({ ...prev, pdfZoom: Number(e.target.value) }))}
                                />
                                <div className="reading-settings-inline-note">
                                    <span>一次渲染页数（当前页前后各几页）</span>
                                    <span>{pdfRenderDraft.pdfPreloadRadius} 页</span>
                                </div>
                                <input
                                    type="range"
                                    className="w-full my-1"
                                    min={1}
                                    max={8}
                                    step={1}
                                    value={pdfRenderDraft.pdfPreloadRadius}
                                    onChange={(e) => setPdfRenderDraft((prev) => ({ ...prev, pdfPreloadRadius: Number(e.target.value) }))}
                                />
                                <p className="reading-settings-inline-note">
                                    <span>提示：一次渲染页数过少时，滑动到未渲染的页会反复渲染，造成闪烁卡顿；调大并开启预加载可缓解。缩放率调大后一页更接近一屏。</span>
                                </p>
                            </section>
                        )}
                    </div>
                </ContentDialog>
            )}
            {showBookmarks && (
                <ContentDialog
                    title="书签"
                    confirmLabel=""
                    cancelLabel="关闭"
                    onConfirm={() => setShowBookmarks(false)}
                    onCancel={() => setShowBookmarks(false)}
                >
                    {bookmarks.length === 0 ? (
                        <p className="reading-bookmark-empty">还没有书签。读到想记住的地方，点右上角的书签图标。</p>
                    ) : (
                        <div className="reading-bookmark-list">
                            {bookmarks.map((bookmark) => (
                                <div key={bookmark.id} className="reading-bookmark-row">
                                    <button
                                        type="button"
                                        className="reading-bookmark-jump"
                                        onClick={() => jumpToBookmark(bookmark)}
                                    >
                                        <span className="reading-bookmark-where">
                                            {bookmark.chapterTitle}
                                            <span className="reading-bookmark-at">
                                                {bookmark.pdfPage ? `第${bookmark.pdfPage}页` : `${Math.round(toBookFraction(bookmark.chapterIndex, bookmark.fraction) * 100)}%`}
                                            </span>
                                        </span>
                                        {bookmark.excerpt && (
                                            <span className="reading-bookmark-excerpt">{bookmark.excerpt}</span>
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        className="reading-bookmark-remove"
                                        onClick={() => { void removeBookmark(bookmark.id); }}
                                        aria-label={`删除书签 ${bookmark.chapterTitle}`}
                                    >
                                        <X size={15} strokeWidth={2} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </ContentDialog>
            )}

            {showNavigationDialog && (
                <>
                    <div className="reading-nav-backdrop" onClick={() => setShowNavigationDialog(false)} />
                    <aside className="reading-nav-drawer">
                        <header className="reading-nav-header">
                            <span className="reading-nav-title">导航</span>
                            <button type="button" className="reading-nav-close" onClick={() => setShowNavigationDialog(false)} aria-label="关闭">
                                <X size={18} strokeWidth={2} />
                            </button>
                        </header>
                        <div className="reading-nav-chapter-count">共{chapters.length}章</div>
                        <div className="reading-nav-chapter-list">
                            {chapters.map((chapter, index) => {
                                const charCount = chapter.paragraphs.reduce((sum, p) => sum + p.replace(/\s+/g, "").length, 0);
                                // 书自带目录里的层级：每深一层多缩进一点，最多缩三层
                                const navIndent = chapter.tocLevel
                                    ? { paddingLeft: `${16 + Math.min(chapter.tocLevel, 3) * 14}px` }
                                    : undefined;
                                const pageLabel = isPdf && chapter.pageStart ? chapter.pageStart : null;
                                return (
                                    <button
                                        key={chapter.id}
                                        type="button"
                                        className={`reading-nav-chapter-item${index === chapterIndex ? " is-active" : ""}`}
                                        onClick={() => handleNavChapterClick(index)}
                                        style={navIndent}
                                    >
                                        <div className="reading-nav-chapter-main">
                                            <span className="reading-nav-chapter-name">{chapter.title || `第${index + 1}章`}</span>
                                            <span className="reading-nav-chapter-meta">{charCount > 0 ? `${charCount}字` : ""}</span>
                                        </div>
                                        {pageLabel && <span className="reading-nav-chapter-page">{pageLabel}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    </aside>
                </>
            )}
        </div>
    );
}
