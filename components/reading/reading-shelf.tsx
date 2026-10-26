"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronLeft, Palette, Pin, Settings, UserRound } from "lucide-react";
import { loadBooks, addBook, updateBook, deleteBook, deleteBookmarksByBook, saveChapters, loadProgress, saveRawFile, countAnnotationsAndCommentsByBook } from "@/lib/reading-storage";
import { loadCharacters } from "@/lib/character-storage";
import { deleteReadingAssetsByPrefix, loadReadingCover, saveReadingAsset, saveReadingCover } from "@/lib/reading-appearance";
import { readingImageAssetKey, readingImageAssetPrefix } from "@/lib/reading-inline-image";
import { decodeTxtArrayBuffer, parseTxtContent, parseEpubFile, parseMobiFile, PDF_PAGES_PER_CHAPTER } from "@/lib/reading-parser";
import { loadReadingInteractionConfig } from "@/lib/reading-storage";
import type { Book, BookChapter } from "@/lib/reading-types";
import type { ReadingAppearance } from "@/lib/reading-appearance";
import { ContentDialog } from "@/components/ui/modal";
import { ReadingAppearanceDialog, type ReadingAppearanceSaveOptions, type ReadingLoadedFonts } from "./reading-appearance-dialog";
import { ReadingInteractionDialog } from "./reading-interaction-dialog";
import { ReadingProfileDialog } from "./reading-profile-dialog";
import { kvGet, kvSet, kvRemove } from "@/lib/kv-db";
import { READING_COVER_MAX_SIZE, compressReadingImage } from "@/lib/reading-image";
import {
    DEFAULT_READING_PROFILE,
    READING_PROFILE_CHANGED_EVENT,
    loadReadingProfile,
    loadReadingProfileAvatar,
    readingProfileIdLabel,
    type ReadingProfile,
} from "@/lib/reading-profile";

type Props = {
    onOpenBook: (book: Book) => void;
    onClose: () => void;
    appearance: ReadingAppearance;
    backgroundUrl: string | null;
    loadedFonts: ReadingLoadedFonts;
    onSaveAppearance: (appearance: ReadingAppearance, options: ReadingAppearanceSaveOptions) => Promise<void>;
};

const IMPORT_DIAG_KEY = "reading-import-diagnostic-v1";

type ImportDiagnostic = {
    status: "running" | "failed";
    stage: string;
    fileName: string;
    fileSize: number;
    format?: Book["format"];
    detail?: string;
    updatedAt: string;
};

function buildImportError(stage: string, err: unknown, format?: Book["format"]): { summary: string; detail?: string } {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const lower = detail.toLowerCase();

    if (lower.includes("notfounderror") || lower.includes("object store")) {
        return {
            summary: `导入失败，阶段：${stage}。本地阅读数据库结构异常，刷新页面后重试即可自动修复。`,
            detail,
        };
    }

    if (lower.includes("quotaexceeded")) {
        return {
            summary: `导入失败，阶段：${stage}。当前浏览器可用存储空间不足，原始文件没能保存成功。`,
            detail,
        };
    }

    if (lower.includes("database") || lower.includes("indexeddb") || lower.includes("idbdatabase")) {
        return {
            summary: `导入失败，阶段：${stage}。浏览器本地数据库写入失败。`,
            detail,
        };
    }

    if (lower.includes("out of memory") || lower.includes("memory") || lower.includes("allocation") || lower.includes("unable to allocate")) {
        return {
            summary: `导入失败，阶段：${stage}。当前手机内存不足，这份${format === "pdf" ? " PDF " : ""}文件对浏览器来说太大了。`,
            detail,
        };
    }

    if (lower.includes("abort") || lower.includes("interrupted")) {
        return {
            summary: `导入失败，阶段：${stage}。浏览器中断了这次文件处理，手机上常见于切后台、内存紧张或系统回收。`,
            detail,
        };
    }

    if (lower.includes("failed to load pdf.js") || lower.includes("pdf")) {
        return {
            summary: `导入失败，阶段：${stage}。PDF 引擎没能完成这份文件的读取。`,
            detail,
        };
    }

    return {
        summary: `导入失败，阶段：${stage}。`,
        detail,
    };
}

export function ReadingShelf({ onOpenBook, onClose, appearance, backgroundUrl, loadedFonts, onSaveAppearance }: Props) {
    const [books, setBooks] = useState<Book[]>([]);
    /** bookId → 封面 objectURL；没有封面的书不在这里，走原来那种自己画的封面 */
    const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
    /** bookId → 批注条数（仅句子批注，不含段评） */
    const [annotationCounts, setAnnotationCounts] = useState<Record<string, number>>({});
    /** bookId → 段评条数（与批注分别统计，书架卡片不显示） */
    const [, setCommentCounts] = useState<Record<string, number>>({});
    /** bookId → 伴读角色名。名字一律从角色数据里取，不写死 */
    const [companionNames, setCompanionNames] = useState<Record<string, string>>({});
    const [progressMap, setProgressMap] = useState<Record<string, {
        chapterIndex: number;
        total: number;
        hasProgress: boolean;
        fraction?: number;
        current?: number;
        pageTotal?: number;
        scope?: "book" | "chapter";
        lastReadAt?: string;
    }>>({});
    const [importing, setImporting] = useState(false);
    const [importStatus, setImportStatus] = useState<string | null>(null);
    const [importError, setImportError] = useState<{ summary: string; detail?: string } | null>(null);
    const [search, setSearch] = useState("");
    const [showSearchBar, setShowSearchBar] = useState(false);
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [showAppearanceDialog, setShowAppearanceDialog] = useState(false);
    const [showInteractionDialog, setShowInteractionDialog] = useState(false);
    const [showProfileDialog, setShowProfileDialog] = useState(false);
    /** 阅读账号：菜单第一行要显示圆形头像 + 昵称 + ID */
    const [profile, setProfile] = useState<ReadingProfile>(DEFAULT_READING_PROFILE);
    const [profileAvatarUrl, setProfileAvatarUrl] = useState<string | null>(null);
    const profileAvatarUrlRef = useRef<string | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const moreMenuWrapRef = useRef<HTMLDivElement>(null);
    /** 长按书卡弹出的操作菜单 */
    const [actionMenuBook, setActionMenuBook] = useState<Book | null>(null);
    /** 「编辑」里正在改的那本书；title/author 是草稿，保存时才落库 */
    const [editingBook, setEditingBook] = useState<Book | null>(null);
    const [editTitle, setEditTitle] = useState("");
    const [editAuthor, setEditAuthor] = useState("");
    const [coverBusy, setCoverBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);
    /** 正在设封面的书。存 ref 而不是 state：点完立刻要打开文件选择器，
     *  state 这一拍还没落地，onChange 里就取不到目标书了。 */
    const coverTargetRef = useRef<string | null>(null);
    /** 长按计时器 + 「这一下已经当成长按了」标记：标记用来吃掉随后那次 click，
     *  否则松手会在弹出菜单的同时把书也打开。 */
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressFiredRef = useRef(false);
    /** 按下时的坐标。手指按住不动也会有几 px 抖动，所以要有个阈值，
     *  不能一有 pointermove 就取消，否则手机上根本按不出菜单。 */
    const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);

    const persistImportDiagnostic = (payload: ImportDiagnostic | null) => {
        if (typeof window === "undefined") return;
        if (!payload) {
            kvRemove(IMPORT_DIAG_KEY);
            return;
        }
        kvSet(IMPORT_DIAG_KEY, JSON.stringify(payload));
    };

    useEffect(() => {
        const allBooks = loadBooks();
        setBooks(allBooks);
        (async () => {
            const map: typeof progressMap = {};
            const companions: Record<string, string> = {};
            const characters = loadCharacters();
            for (const b of allBooks) {
                const p = await loadProgress(b.id);
                map[b.id] = {
                    chapterIndex: p?.chapterIndex ?? 0,
                    total: b.totalChapters,
                    hasProgress: !!p,
                    fraction: p?.progressFraction,
                    current: p?.progressCurrent,
                    pageTotal: p?.progressTotal,
                    scope: p?.progressScope,
                    lastReadAt: p?.lastReadAt,
                };
                const companionId = p?.companionCharacterId;
                const companionName = companionId
                    ? characters.find((character) => character.id === companionId)?.name
                    : undefined;
                if (companionName) companions[b.id] = companionName;
            }
            setProgressMap(map);
            setCompanionNames(companions);
            const counts = await countAnnotationsAndCommentsByBook().catch(() => ({ noteCounts: {}, commentCounts: {} }));
            setAnnotationCounts(counts.noteCounts);
            setCommentCounts(counts.commentCounts);
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 阅读账号：进书架读一次，之后靠 READING_PROFILE_CHANGED_EVENT 更新。
    // 在账号弹窗里换了头像，这里菜单上的圆形头像要立刻跟着换，不能等重进。
    useEffect(() => {
        let alive = true;
        const refresh = async () => {
            const stored = loadReadingProfile();
            if (!alive) return;
            setProfile(stored);
            const blob = await loadReadingProfileAvatar().catch(() => null);
            if (!alive) return;
            const nextUrl = blob && blob.size > 0 ? URL.createObjectURL(blob) : null;
            if (profileAvatarUrlRef.current && profileAvatarUrlRef.current !== nextUrl) {
                URL.revokeObjectURL(profileAvatarUrlRef.current);
            }
            profileAvatarUrlRef.current = nextUrl;
            setProfileAvatarUrl(nextUrl);
        };
        void refresh();
        const onChange = () => { void refresh(); };
        window.addEventListener(READING_PROFILE_CHANGED_EVENT, onChange);
        return () => {
            alive = false;
            window.removeEventListener(READING_PROFILE_CHANGED_EVENT, onChange);
            if (profileAvatarUrlRef.current) {
                URL.revokeObjectURL(profileAvatarUrlRef.current);
                profileAvatarUrlRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!showMoreMenu) return;
        const onPointerDown = (e: PointerEvent) => {
            if (moreMenuWrapRef.current && !moreMenuWrapRef.current.contains(e.target as Node)) {
                setShowMoreMenu(false);
            }
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [showMoreMenu]);

    // 封面按书逐本取。串行读：这几个资源共用一个 IndexedDB，并发打开会互相 block。
    useEffect(() => {
        let cancelled = false;
        const created: string[] = [];
        (async () => {
            const map: Record<string, string> = {};
            for (const b of books) {
                const blob = await loadReadingCover(b.id).catch(() => null);
                if (cancelled) break;
                if (!blob || blob.size === 0) continue;
                const url = URL.createObjectURL(blob);
                created.push(url);
                map[b.id] = url;
            }
            if (cancelled) { created.forEach(url => URL.revokeObjectURL(url)); return; }
            setCoverUrls(prev => {
                Object.values(prev).forEach(url => URL.revokeObjectURL(url));
                return map;
            });
        })();
        return () => { cancelled = true; };
    }, [books]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const raw = kvGet(IMPORT_DIAG_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw) as ImportDiagnostic;
            if (!saved?.stage || !saved?.updatedAt) return;

            const timeLabel = new Date(saved.updatedAt).toLocaleString();
            const sizeLabel = saved.fileSize > 0 ? `，文件大小约 ${(saved.fileSize / 1024 / 1024).toFixed(1)} MB` : "";
            const summary = saved.status === "running"
                ? `上次导入在「${saved.stage}」阶段中断了。文件：${saved.fileName}${sizeLabel}。时间：${timeLabel}。`
                : `上次导入在「${saved.stage}」阶段失败。文件：${saved.fileName}${sizeLabel}。时间：${timeLabel}。`;
            setImportError({ summary, detail: saved.detail });
        } catch {
            // Ignore broken diagnostics.
        }
    }, []);

    // Dismiss must also clear the persisted diagnostic — it's reloaded on every
    // mount, which is what made the old inline banner impossible to get rid of.
    const dismissImportError = () => {
        setImportError(null);
        persistImportDiagnostic(null);
    };

    /** 换掉一本书的封面图：null 表示恢复成自动生成的那种封面 */
    const applyCover = async (bookId: string, blob: Blob | null) => {
        setCoverBusy(true);
        try {
            await saveReadingCover(bookId, blob);
            const nextUrl = blob ? URL.createObjectURL(blob) : null;
            setCoverUrls(prev => {
                const previous = prev[bookId];
                if (previous) URL.revokeObjectURL(previous);
                const next = { ...prev };
                if (nextUrl) next[bookId] = nextUrl;
                else delete next[bookId];
                return next;
            });
        } catch (err) {
            setImportError({
                summary: "封面保存失败。",
                detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            });
        } finally {
            setCoverBusy(false);
        }
    };

    const pickCoverFor = (bookId: string) => {
        coverTargetRef.current = bookId;
        coverInputRef.current?.click();
    };

    /** 长按：按住 500ms 弹操作菜单。移动或提前松手都取消。 */
    const cancelLongPress = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
        longPressOriginRef.current = null;
    };

    const startLongPress = (book: Book, e: React.PointerEvent) => {
        cancelLongPress();
        longPressFiredRef.current = false;
        longPressOriginRef.current = { x: e.clientX, y: e.clientY };
        longPressTimerRef.current = setTimeout(() => {
            longPressTimerRef.current = null;
            longPressFiredRef.current = true;
            longPressOriginRef.current = null;
            setActionMenuBook(book);
        }, 500);
    };

    /** 超过 10px 才算滑动（当成滚动列表），之内的抖动不打断长按 */
    const trackLongPressMove = (e: React.PointerEvent) => {
        const origin = longPressOriginRef.current;
        if (!origin) return;
        if (Math.abs(e.clientX - origin.x) > 10 || Math.abs(e.clientY - origin.y) > 10) cancelLongPress();
    };

    /** 长按刚弹过菜单时吞掉紧跟着的那次 click，别顺手把书也打开 */
    const handleCardClick = (book: Book) => {
        if (longPressFiredRef.current) {
            longPressFiredRef.current = false;
            return;
        }
        onOpenBook(book);
    };

    const togglePin = async (book: Book) => {
        await updateBook({ ...book, pinnedAt: book.pinnedAt ? undefined : new Date().toISOString() });
        setBooks(loadBooks());
    };

    const openEditor = (book: Book) => {
        setEditingBook(book);
        setEditTitle(book.title);
        setEditAuthor(book.author || "");
    };

    const saveEditor = async () => {
        if (!editingBook) return;
        const title = editTitle.trim();
        // 书名空着就留原来的：书架、分享图、提示词到处都在用它，不能变成空串
        await updateBook({
            ...editingBook,
            title: title || editingBook.title,
            author: editAuthor.trim() || undefined,
        });
        setEditingBook(null);
        setBooks(loadBooks());
    };

    const handleCoverFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        const bookId = coverTargetRef.current;
        coverTargetRef.current = null;
        if (!file || !bookId) return;
        await applyCover(bookId, await compressReadingImage(file, READING_COVER_MAX_SIZE));
    };

    const matchedBooks = search.trim()
        ? books.filter(b => b.title.toLowerCase().includes(search.toLowerCase()) || b.author?.toLowerCase().includes(search.toLowerCase()))
        : books;
    // 排序规则：
    // 1. 被置顶的书排最前（多本按置顶时间倒序）；
    // 2. 未置顶的书中，最近打开过的排在上方（按 lastReadAt 倒序），其余按导入时间倒序。
    const filteredBooks = [...matchedBooks].sort((a, b) => {
        if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) return a.pinnedAt ? -1 : 1;
        if (a.pinnedAt && b.pinnedAt) return b.pinnedAt.localeCompare(a.pinnedAt);
        const aReadAt = progressMap[a.id]?.lastReadAt || "";
        const bReadAt = progressMap[b.id]?.lastReadAt || "";
        if (Boolean(aReadAt) !== Boolean(bReadAt)) return aReadAt ? -1 : 1;
        if (aReadAt && bReadAt && aReadAt !== bReadAt) return bReadAt.localeCompare(aReadAt);
        return (b.createdAt || "").localeCompare(a.createdAt || "");
    });

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = "";
        setImporting(true);
        setImportError(null);
        setImportStatus("正在准备导入…");
        let importStage = "准备导入";
        const ext = file.name.split(".").pop()?.toLowerCase();
        const isMobiExt = ext === "mobi" || ext === "azw3" || ext === "azw" || ext === "prc";
        const detectedFormat = ext === "pdf" ? "pdf" : ext === "epub" ? "epub" : isMobiExt ? "mobi" : "txt";
        persistImportDiagnostic({
            status: "running",
            stage: importStage,
            fileName: file.name,
            fileSize: file.size,
            format: detectedFormat,
            updatedAt: new Date().toISOString(),
        });

        try {
            let parsed;
            let format: Book["format"];
            let rawFile: Blob | null = null;

            if (ext === "txt") {
                importStage = "读取 TXT 文件";
                setImportStatus("正在读取 TXT 文件…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "txt",
                    updatedAt: new Date().toISOString(),
                });
                const readingConfig = loadReadingInteractionConfig();
                const { text } = decodeTxtArrayBuffer(await file.arrayBuffer(), readingConfig.txtEncoding);
                parsed = parseTxtContent(text, file.name, readingConfig.paragraphMode);
                format = "txt";
            } else if (ext === "epub") {
                importStage = "读取 EPUB 文件";
                setImportStatus("正在读取 EPUB 文件…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "epub",
                    updatedAt: new Date().toISOString(),
                });
                const buffer = await file.arrayBuffer();
                importStage = "解析 EPUB 内容";
                setImportStatus("正在解析 EPUB 内容…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "epub",
                    updatedAt: new Date().toISOString(),
                });
                parsed = await parseEpubFile(buffer, file.name);
                format = "epub";
            } else if (isMobiExt) {
                importStage = "读取 MOBI 文件";
                setImportStatus("正在读取 MOBI 文件…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "mobi",
                    updatedAt: new Date().toISOString(),
                });
                const buffer = await file.arrayBuffer();
                importStage = "解析 MOBI 内容";
                setImportStatus("正在解析 MOBI 内容…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "mobi",
                    updatedAt: new Date().toISOString(),
                });
                parsed = await parseMobiFile(buffer, file.name);
                format = "mobi";
            } else if (ext === "pdf") {
                rawFile = file;
                importStage = "创建 PDF 导入记录";
                setImportStatus("正在创建 PDF 导入记录…");
                persistImportDiagnostic({
                    status: "running",
                    stage: importStage,
                    fileName: file.name,
                    fileSize: file.size,
                    format: "pdf",
                    updatedAt: new Date().toISOString(),
                });
                parsed = {
                    title: file.name.replace(/\.[^.]+$/, "") || "未命名",
                    chapters: [{ title: `第1-${PDF_PAGES_PER_CHAPTER}页`, paragraphs: [] }],
                    totalPages: 0,
                };
                format = "pdf";
            } else {
                alert("不支持的格式，请上传 TXT、EPUB 或 PDF 文件");
                persistImportDiagnostic(null);
                return;
            }

            const bookId = `book_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const book: Book = {
                id: bookId,
                title: parsed.title,
                author: parsed.author,
                format,
                totalChapters: parsed.chapters.length,
                createdAt: new Date().toISOString(),
            };

            const chapters: BookChapter[] = parsed.chapters.map((ch, i) => {
                if (format === "pdf") {
                    const pageStart = i * PDF_PAGES_PER_CHAPTER + 1;
                    const totalPages = "totalPages" in parsed ? (parsed as { totalPages: number }).totalPages : pageStart + PDF_PAGES_PER_CHAPTER - 1;
                    const pageEnd = Math.min(pageStart + PDF_PAGES_PER_CHAPTER - 1, totalPages);
                    return {
                        id: `${bookId}_ch${i}`,
                        bookId,
                        index: i,
                        title: ch.title,
                        paragraphs: [],
                        pageStart,
                        pageEnd,
                    };
                }
                // PDF 那条分支给的是个占位章节，没有 tocLevel，取值要容错
                const tocLevel = (ch as { tocLevel?: number }).tocLevel;
                return {
                    id: `${bookId}_ch${i}`,
                    bookId,
                    index: i,
                    title: ch.title,
                    paragraphs: ch.paragraphs,
                    ...(typeof tocLevel === "number" ? { tocLevel } : {}),
                };
            });

            importStage = "写入书架数据";
            setImportStatus("正在写入书架数据…");
            persistImportDiagnostic({
                status: "running",
                stage: importStage,
                fileName: file.name,
                fileSize: file.size,
                format,
                updatedAt: new Date().toISOString(),
            });
            await addBook(book);
            await saveChapters(bookId, chapters);
            if ("cover" in parsed && parsed.cover) {
                await saveReadingCover(bookId, new Blob([parsed.cover.data], { type: parsed.cover.mime }))
                    .catch(() => { /* 封面存不下不该挡住导入 */ });
            }
            const parsedImages = "images" in parsed ? parsed.images : undefined;
            if (parsedImages && parsedImages.length > 0) {
                importStage = "保存正文插图";
                setImportStatus(`正在保存 ${parsedImages.length} 张插图…`);
                for (const image of parsedImages) {
                    // 单张图存不下不该让整本书导入失败，正文里那一格会显示成「插图加载失败」
                    await saveReadingAsset(readingImageAssetKey(bookId, image.index), image.blob).catch(() => {});
                }
            }
            if (rawFile) {
                try {
                    importStage = format === "pdf" ? "保存原始 PDF 文件" : "保存原始文件";
                    setImportStatus(format === "pdf" ? "正在保存原始 PDF 文件…" : "正在保存原始文件…");
                    persistImportDiagnostic({
                        status: "running",
                        stage: importStage,
                        fileName: file.name,
                        fileSize: file.size,
                        format,
                        updatedAt: new Date().toISOString(),
                    });
                    await saveRawFile(bookId, rawFile);
                } catch (saveErr) {
                    await deleteBook(bookId).catch(() => {});
                    await saveReadingCover(bookId, null).catch(() => {});
                    await deleteReadingAssetsByPrefix(readingImageAssetPrefix(bookId)).catch(() => {});
                    const built = buildImportError(importStage, saveErr, format);
                    setImportError(built);
                    persistImportDiagnostic({
                        status: "failed",
                        stage: importStage,
                        fileName: file.name,
                        fileSize: file.size,
                        format,
                        detail: built.detail || built.summary,
                        updatedAt: new Date().toISOString(),
                    });
                    return;
                }
            }
            setBooks(loadBooks());
            setProgressMap(prev => ({ ...prev, [bookId]: { chapterIndex: 0, total: chapters.length, hasProgress: false } }));
            const nextCounts = await countAnnotationsAndCommentsByBook().catch(() => ({ noteCounts: {}, commentCounts: {} }));
            setAnnotationCounts(nextCounts.noteCounts);
            setCommentCounts(nextCounts.commentCounts);
            setImportStatus(null);
            persistImportDiagnostic(null);
        } catch (err) {
            console.error("[Reading] Import failed:", err);
            const format = detectedFormat;
            const built = buildImportError(importStage, err, format);
            setImportError(built);
            persistImportDiagnostic({
                status: "failed",
                stage: importStage,
                fileName: file.name,
                fileSize: file.size,
                format,
                detail: built.detail || built.summary,
                updatedAt: new Date().toISOString(),
            });
        } finally {
            setImporting(false);
            setImportStatus(null);
        }
    };

    const handleDelete = async (bookId: string) => {
        if (!confirm("确定删除这本书吗？")) return;
        await deleteBook(bookId);
        await deleteBookmarksByBook(bookId).catch(() => {});
        await saveReadingCover(bookId, null).catch(() => {});
        await deleteReadingAssetsByPrefix(readingImageAssetPrefix(bookId)).catch(() => {});
        setBooks(loadBooks());
    };

    const formatBadge = (f: string) => f.toUpperCase();

    const coverGradients = ["linen", "mist", "graphite", "sage", "cream", "parchment"] as const;
    const coverLayouts = ["layout-1", "layout-2", "layout-3", "layout-4"] as const;

    return (
        <div className="reading-app-surface absolute inset-0 z-[100] flex flex-col">
            <header className="reading-shelf-header">
                <div className="reading-shelf-appbar">
                    <button className="reading-shelf-back" type="button" onClick={onClose} aria-label="返回">
                        <ChevronLeft size={22} strokeWidth={2.5} />
                    </button>
                    <div className="reading-shelf-actions">
                        <button
                            className="reading-shelf-action-btn"
                            type="button"
                            onClick={() => {
                                setShowSearchBar((prev) => {
                                    const next = !prev;
                                    if (!next) setSearch("");
                                    else window.setTimeout(() => searchInputRef.current?.focus(), 0);
                                    return next;
                                });
                            }}
                            aria-label="搜索书籍"
                            aria-expanded={showSearchBar}
                        >
                            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="11" cy="11" r="8" />
                                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                        </button>
                        <div ref={moreMenuWrapRef} className="reading-shelf-more-wrap">
                            <button
                                className="reading-shelf-action-btn"
                                type="button"
                                onClick={() => setShowMoreMenu((prev) => !prev)}
                                aria-label="更多操作"
                                aria-expanded={showMoreMenu}
                            >
                                <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <circle cx="12" cy="5" r="1.2" fill="currentColor" />
                                    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
                                    <circle cx="12" cy="19" r="1.2" fill="currentColor" />
                                </svg>
                            </button>
                            {showMoreMenu && (
                                <div className="reading-shelf-more-menu" role="menu">
                                    {/* 第一行：阅读账号。左边圆形头像，右边两行——
                                        昵称（#252525）+ 小一号的浅色 ID */}
                                    <button
                                        type="button"
                                        className="reading-account-item"
                                        onClick={() => {
                                            setShowMoreMenu(false);
                                            setShowProfileDialog(true);
                                        }}
                                        aria-label="阅读账号"
                                    >
                                        <span className="reading-account-avatar">
                                            {profileAvatarUrl ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={profileAvatarUrl} alt="" />
                                            ) : (
                                                <UserRound size={16} strokeWidth={1.8} />
                                            )}
                                        </span>
                                        <span className="reading-account-copy">
                                            <span className="reading-account-name">{profile.name.trim() || "未设置昵称"}</span>
                                            <span className="reading-account-id">{readingProfileIdLabel(profile)}</span>
                                        </span>
                                    </button>
                                    <span className="reading-shelf-more-divider" aria-hidden="true" />
                                    <button
                                        type="button"
                                        className="reading-shelf-more-item"
                                        disabled={importing}
                                        onClick={() => {
                                            setShowMoreMenu(false);
                                            fileRef.current?.click();
                                        }}
                                    >
                                        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                            <path d="M12 5v14M5 12h14" />
                                        </svg>
                                        <span>导入图书</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="reading-shelf-more-item"
                                        onClick={() => {
                                            setShowMoreMenu(false);
                                            setShowInteractionDialog(true);
                                        }}
                                    >
                                        <Settings size={16} strokeWidth={1.8} />
                                        <span>阅读设置</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="reading-shelf-more-item"
                                        onClick={() => {
                                            setShowMoreMenu(false);
                                            setShowAppearanceDialog(true);
                                        }}
                                    >
                                        <Palette size={16} strokeWidth={1.8} />
                                        <span>阅读外观</span>
                                    </button>
                                </div>
                            )}
                        </div>
                        <input ref={fileRef} type="file" accept=".txt,.epub,.mobi,.azw3,.prc,.pdf" onChange={handleFileUpload} className="hidden" disabled={importing} />
                    </div>
                </div>
                <div className="reading-shelf-title-stack">
                    <h1 className="reading-shelf-title">书架</h1>
                    <span className="reading-shelf-subtitle">{books.length} BOOKS IN YOUR LIBRARY</span>
                </div>
            </header>

            <div className="reading-shelf-body">
                {showSearchBar && (
                    <div className="px-4 pb-3">
                        <div className="reading-search-bar">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                            <input
                                ref={searchInputRef}
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                placeholder={`搜索 ${books.length} 本书`}
                                className="reading-search-input"
                            />
                        </div>
                    </div>
                )}

                {importing && (
                    <div className="text-center ts-13 py-2" style={{ color: "var(--reading-warm-brown, #8a5a2b)" }}>
                        {importStatus ? `导入中：${importStatus}` : "导入中..."}
                    </div>
                )}
                {importError && (
                    <div className="modal-overlay" data-ui="modal" onClick={dismissImportError}>
                        <div className="reading-import-error-card reading-import-error-dialog" onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="reading-import-error-close" onClick={dismissImportError} aria-label="关闭">✕</button>
                            <div className="reading-import-error-kicker">IMPORT ERROR</div>
                            <div className="ts-13 font-medium" style={{ color: "#2f261f" }}>导入失败</div>
                            <div className="ts-12 mt-1" style={{ color: "#7f7266" }}>{importError.summary}</div>
                            {importError.detail && (
                                <div className="ts-11 mt-2 break-all reading-import-error-detail" style={{ color: "#a39487" }}>{importError.detail}</div>
                            )}
                            <button type="button" className="reading-import-error-ok" onClick={dismissImportError}>知道了</button>
                        </div>
                    </div>
                )}

                {filteredBooks.length === 0 ? (
                    <div className="py-10 text-center ts-14" style={{ color: "var(--reading-warm-ink-tertiary, #999)" }}>
                        {books.length === 0 ? "还没有书籍，点右上角菜单导入" : "没有匹配的书籍"}
                    </div>
                ) : (
                    <div className="reading-book-list">
                        {filteredBooks.map(book => {
                            const prog = progressMap[book.id];
                            const fallbackFraction = prog?.hasProgress && prog.total > 0
                                ? Math.min(1, Math.max(0, (prog.chapterIndex + 1) / prog.total))
                                : 0;
                            const progressFraction = prog?.hasProgress
                                ? Math.min(1, Math.max(0, prog.fraction ?? fallbackFraction))
                                : 0;
                            const progressPct = Math.round(progressFraction * 100);
                            const progressMeta = !prog?.hasProgress
                                ? null
                                : prog.scope === "book" && prog.current && prog.pageTotal
                                    ? `${prog.current}/${prog.pageTotal}`
                                    : prog.current && prog.pageTotal
                                        ? `第${Math.max(1, prog.chapterIndex + 1)}章 · ${prog.current}/${prog.pageTotal}`
                                        : `第${Math.max(1, prog.chapterIndex + 1)}/${Math.max(1, prog.total)}章`;
                            const gradient = coverGradients[book.title.length % coverGradients.length];
                            const layout = coverLayouts[(book.title.length + (book.author?.length || 0)) % coverLayouts.length];
                            return (
                                <div
                                    key={book.id}
                                    className="reading-list-item"
                                    onClick={() => handleCardClick(book)}
                                    onPointerDown={(e) => startLongPress(book, e)}
                                    onPointerUp={cancelLongPress}
                                    onPointerLeave={cancelLongPress}
                                    onPointerCancel={cancelLongPress}
                                    onPointerMove={trackLongPressMove}
                                    onContextMenu={(e) => { e.preventDefault(); setActionMenuBook(book); }}
                                >
                                    {/* 封面只是封面：换封面挪进长按菜单的「编辑」里了 */}
                                    <div className="reading-list-cover-btn">
                                        {coverUrls[book.id] ? (
                                            <div className="reading-list-cover reading-list-cover--image">
                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                <img src={coverUrls[book.id]} alt="" />
                                            </div>
                                        ) : (
                                            <div className={`reading-list-cover reading-list-cover--${gradient} reading-list-cover--${layout}`}>
                                                <span className="reading-list-cover-author">{book.author || ""}</span>
                                                <span className="reading-list-cover-title">{book.title}</span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="reading-list-info">
                                        <span className="reading-list-title">
                                            {book.title}
                                            {book.pinnedAt ? (
                                                <Pin size={12} className="reading-list-pin" aria-label="已置顶" />
                                            ) : null}
                                        </span>
                                        {book.author && <span className="reading-list-author">{book.author}</span>}
                                        <div className="reading-list-meta">
                                            <span className="reading-list-badge">{formatBadge(book.format)}</span>
                                            <span>{book.totalChapters}章</span>
                                            {annotationCounts[book.id] ? (
                                                <>
                                                    <span className="reading-list-badge">批注</span>
                                                    <span>{annotationCounts[book.id]}条</span>
                                                </>
                                            ) : null}
                                            {companionNames[book.id] ? (
                                                <>
                                                    <span className="reading-list-badge">伴读</span>
                                                    <span className="reading-list-meta-value">{companionNames[book.id]}</span>
                                                </>
                                            ) : null}
                                        </div>
                                        <div className="reading-list-progress-row">
                                            <span className="reading-list-progress-label">
                                                {prog?.hasProgress ? `阅读进度 ${progressPct}%` : "未开始阅读"}
                                            </span>
                                            {progressMeta && (
                                                <span className="reading-list-progress-meta">
                                                    {progressMeta}
                                                </span>
                                            )}
                                        </div>
                                        <div className="reading-list-progress-track" aria-hidden="true">
                                            <div className="reading-list-progress-fill" style={{ width: `${prog?.hasProgress ? progressPct : 0}%` }} />
                                        </div>
                                    </div>
                                    <button
                                        className="reading-list-delete"
                                        onClick={(e) => { e.stopPropagation(); handleDelete(book.id); }}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                        </svg>
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div className="reading-shelf-footer">
                    共 {books.length} 本书籍
                </div>
            </div>

            <input
                ref={coverInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => { void handleCoverFileChange(e); }}
            />

            {actionMenuBook && (
                <ContentDialog
                    title={actionMenuBook.title}
                    confirmLabel=""
                    cancelLabel="取消"
                    onConfirm={() => setActionMenuBook(null)}
                    onCancel={() => setActionMenuBook(null)}
                >
                    <div className="reading-settings-grid">
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => {
                                const target = actionMenuBook;
                                setActionMenuBook(null);
                                void togglePin(target);
                            }}
                        >
                            {actionMenuBook.pinnedAt ? "取消置顶" : "置顶"}
                        </button>
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline"
                            onClick={() => {
                                const target = actionMenuBook;
                                setActionMenuBook(null);
                                openEditor(target);
                            }}
                        >
                            编辑
                        </button>
                    </div>
                </ContentDialog>
            )}

            {editingBook && (
                <ContentDialog
                    title="编辑书籍"
                    confirmLabel="保存"
                    cancelLabel="取消"
                    onConfirm={() => { void saveEditor(); }}
                    onCancel={() => setEditingBook(null)}
                >
                    <div className="reading-book-edit">
                        <label className="reading-book-edit-field">
                            <span>书名</span>
                            <input
                                type="text"
                                className="ui-input"
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                placeholder={editingBook.title}
                            />
                        </label>
                        <label className="reading-book-edit-field">
                            <span>作者</span>
                            <input
                                type="text"
                                className="ui-input"
                                value={editAuthor}
                                onChange={(e) => setEditAuthor(e.target.value)}
                                placeholder="留空就不显示"
                            />
                        </label>
                        <div className="reading-book-edit-field">
                            <span>封面</span>
                            <div className="reading-settings-grid">
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-outline"
                                    disabled={coverBusy}
                                    onClick={() => pickCoverFor(editingBook.id)}
                                >
                                    从相册选择图片
                                </button>
                                {coverUrls[editingBook.id] ? (
                                    <button
                                        type="button"
                                        className="ui-btn ui-btn-outline"
                                        disabled={coverBusy}
                                        onClick={() => { void applyCover(editingBook.id, null); }}
                                    >
                                        移除封面，恢复默认样式
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </ContentDialog>
            )}

            {showAppearanceDialog && (
                <ReadingAppearanceDialog
                    appearance={appearance}
                    backgroundUrl={backgroundUrl}
                    loadedFonts={loadedFonts}
                    onClose={() => setShowAppearanceDialog(false)}
                    onSave={onSaveAppearance}
                />
            )}

            {showInteractionDialog && (
                <ReadingInteractionDialog onClose={() => setShowInteractionDialog(false)} />
            )}

            {showProfileDialog && (
                <ReadingProfileDialog
                    onClose={() => setShowProfileDialog(false)}
                    onSaved={(saved) => setProfile(saved)}
                />
            )}
        </div>
    );
}
