"use client";

import { Component, useState, useEffect, useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { Trash2, Zap, Clock, Users, Archive, Folder, AlertCircle, Search, Brain, FileText, MoreHorizontal, Plus, Edit3, X, Check, ChevronLeft, ChevronRight, ChevronDown, Filter, SlidersHorizontal, Sparkles, RotateCcw, RotateCw, History, type LucideIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/modal";
import { MemoryTimeline } from "./memory-timeline";
import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MemoryEntry, MemoryConfig } from "@/lib/memory-types";
import {
    DEFAULT_CORE_MEMORY_PROMPT,
    DEFAULT_SUMMARIZATION_PROMPT,
    SHORT_TERM_BUDGET_APP_KEYS,
} from "@/lib/memory-types";
import { CONTENT_APP_LABELS, type ContentAppId } from "@/lib/settings-types";
import {
    loadMemoryConfig,
    saveMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntry,
    deleteCharacterMemoriesByType,
    getAllCharacterIdsWithMemories,
    getMemoryCountByType,
    getLastSummarizedTimestamp,
    getLastCoreSummarizedTimestamp,
} from "@/lib/memory-storage";
import { hydrateChatStorage } from "@/lib/chat-storage";
import { loadNativeTimeline, filterTimelineByAllowedSources, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import {
    runSummarizationPipeline,
    extractMemoryStructuredMeta,
    extractDateFromRawText,
    stripMemoryStructuredSections,
    cleanAndSplitManualMemoryText,
    isLegacyUnorganizedMemory,
    cleanLegacyMemoryEntry,
    runBatchCleanLegacyMemories,
    resplitMergedMemory,
    isLegacyResplitFragment,
    trashAllLegacyResplitFragments,
    type CleanedManualMemoryDraft,
} from "@/lib/memory-summarizer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
    resummarizeCoreMemory,
    resolveCoreMemorySource,
    runCoreMemoryPipeline,
} from "@/lib/core-memory-builder";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "@/lib/settings-storage";
import {
    generateEmbedding,
    generateEmbeddingsBatch,
    resolveEmbeddingModel,
    searchMemories,
    getLastObservedEmbeddingDim,
} from "@/lib/memory-embedding";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";
import {
    REVISION_META_KEYS,
    clipSupersededSpans,
    getRevisionWeight,
    isEntrySuperseded,
    readSupersededSpans,
    sliceSupersededText,
} from "@/lib/memory-revision";
import {
    resolveMemoryProvenance,
} from "@/lib/memory-provenance";
import {
    TRASH_RETENTION_DAYS,
    buildTrashBucket,
    isEntryTrashed,
    permanentlyDeleteTrashed,
    purgeExpiredTrashed,
    readEditSnapshot,
    readTrashActor,
    readTrashReason,
    readTrashRemainingDays,
    readTrashedAt,
    restoreTrashedEntry,
    revertCharacterEdit,
    trashMemoryEntry,
} from "@/lib/memory-trash";
import {
    DEFAULT_EVENT_BOX_SUMMARY_PROMPT,
    EVENT_BOX_STATUS_META,
    buildSmartBoxSuggestions,
    createEventBox,
    deleteEventBoxAndKeepEntries,
    formatBoxSpan,
    getBoxLayers,
    getEntryBoxId,
    isEntryArchived,
    isEntryBoxDigest,
    loadEventBoxes,
    moveEntryToBox,
    removeEntryFromBox,
    restoreEventBoxArchivedEntries,
    summarizeAllPendingEventBoxes,
    summarizeEventBoxManually,
    unarchiveSingleBoxEntry,
    updateEventBox,
    type EventBoxStatus,
    type MemoryEventBox,
    type SmartBoxSuggestion,
} from "@/lib/memory-event-boxes";
type MemoryView = "list" | "detail" | "settings";
type MemoryTab = "short" | "shared" | "long" | "boxes" | "core" | "trash";
type MemoryBudgetKey = "shortTermTokenBudget" | "coreMemoryTokenBudget" | "longTermTokenBudget";

const MEMORY_TOKEN_BUDGET_MAX = 100000;
const MEMORY_TOKEN_BUDGET_MIN: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 1000,
    coreMemoryTokenBudget: 100,
    longTermTokenBudget: 200,
};
const MEMORY_TOKEN_BUDGET_STEP: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 5000,
    coreMemoryTokenBudget: 1000,
    longTermTokenBudget: 1000,
};
const MANUAL_MEMORY_CONTENT_LIMIT = 3000;
// 详情页时间线最多解析渲染的条数：全量历史可能有几万条，
// 一次性解析+渲染会把 iOS Safari 的单页内存顶爆（灰屏杀页）
const MEMORY_TIMELINE_ENTRY_CAP = 2000;

/** 详情页兜底：时间线渲染抛错时显示提示，而不是整页白屏 */
class MemoryDetailBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() {
        if (this.state.failed) {
            return <p className="text-center ts-14 mt-10 text-secondary">这一页加载出错了，返回上一页再试一次。</p>;
        }
        return this.props.children;
    }
}

type SummarizeRange = "auto" | "all" | number;

const SUMMARIZE_RANGE_OPTIONS: Array<{ value: SummarizeRange; label: string; desc?: string }> = [
    { value: "auto", label: "接着上次总结", desc: "默认方式，从上次进度继续" },
    { value: 1, label: "最近 1 天" },
    { value: 3, label: "最近 3 天" },
    { value: 7, label: "最近 7 天" },
    { value: 14, label: "最近 14 天" },
    { value: 30, label: "最近 30 天" },
    { value: "all", label: "全部历史" },
];

type MemorySourceKey = keyof NonNullable<MemoryConfig["shortTermAllowedSources"]>;

/** 记忆来源开关：同时作用于短期上下文与长期总结 */
const MEMORY_SOURCE_OPTIONS: Array<{ key: MemorySourceKey; label: string }> = [
    { key: "chat", label: "私聊上下文" },
    { key: "group_chat", label: "群聊上下文" },
    { key: "moments", label: "朋友圈" },
    { key: "checkphone", label: "查手机" },
    { key: "diary", label: "手记便签" },
    { key: "xiaohongshu", label: "小红书" },
    { key: "interview_magazine", label: "在场访谈" },
    { key: "cocreate", label: "共创" },
    { key: "game", label: "内置小游戏" },
    { key: "story", label: "剧情小剧场" },
    { key: "vn", label: "漫卷" },
    { key: "adventure", label: "地图冒险" },
    { key: "custom_app", label: "自定义应用" },
];

/** 分应用截断量的行标题：能用应用自己的名字就用，装不进 ContentAppId 的另给一个。 */
const SHORT_TERM_BUDGET_EXTRA_LABELS: Record<string, string> = {
    custom_app: "自定义应用",
};

function shortTermBudgetAppLabel(key: string): string {
    return CONTENT_APP_LABELS[key as ContentAppId] ?? SHORT_TERM_BUDGET_EXTRA_LABELS[key] ?? key;
}

type MemoryEditorDraftItem = {
    content: string;
    eventDate: string;
    importance: number; // 1-10
    keywordsText: string;
};

type MemoryEditorState = {
    type: MemoryEntry["type"];
    entry?: MemoryEntry;
    content: string;
    eventDate: string;
    dateTouched?: boolean;
    importance: number; // 1-10
    keywordsText: string;
    eventBoxId?: string;
    cleanedDrafts?: MemoryEditorDraftItem[];
};

function getLocalTodayKey(): string {
    const now = new Date();
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatIsoTimestamp(isoStr: string): string {
    const d = new Date(isoStr);
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return !isNaN(d.getTime())
        ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
        : isoStr.slice(0, 16);
}

/** 事件日期与入库日期分开成两行显示，顺序固定：事件日期在上，入库在下。 */
function formatEntryDateLines(entry: MemoryEntry): string[] {
    const eventDate = typeof entry.metadata?.eventDate === "string" ? entry.metadata.eventDate.trim() : "";
    const createdDate = formatIsoTimestamp(entry.createdAt);
    if (eventDate) {
        return [`事件日期: ${eventDate}`, `入库: ${createdDate}`];
    }
    return [`入库: ${createdDate}`];
}

const memorySettingsIconStyle = (color: string): CSSProperties => ({
    "--icon-color": color,
} as CSSProperties);

function MemorySettingsIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="card-icon" style={memorySettingsIconStyle(color)}>
            <Icon size={22} strokeWidth={1.75} />
        </span>
    );
}

function MemorySettingsSliderItem({
    icon,
    color,
    label,
    desc,
    value,
    min,
    max,
    step,
    onChange,
}: {
    icon: LucideIcon;
    color: string;
    label: string;
    desc: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
}) {
    return (
        <div className="menu-item memory-slider-item">
            <div className="memory-slider-header">
                <MemorySettingsIcon icon={icon} color={color} />
                <div className="menu-label-group">
                    <span className="menu-label">{label}</span>
                    <span className="menu-desc">{desc}</span>
                </div>
                <span className="ui-slider-value memory-slider-current">{value}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                className="ui-slider memory-settings-slider"
                aria-label={label}
            />
        </div>
    );
}

/** 分应用截断量的一行：没单独配过时显示「默认 N」，拖一下滑块就变成单独配。 */
function MemoryAppBudgetRow({
    label,
    override,
    fallback,
    min,
    max,
    step,
    onChange,
    onReset,
}: {
    label: string;
    override?: number;
    fallback: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
    onReset: () => void;
}) {
    const isCustom = typeof override === "number";
    return (
        <div className="memory-app-budget-row" data-custom={isCustom ? "" : undefined}>
            <div className="memory-app-budget-head">
                <span className="memory-app-budget-name">{label}</span>
                {isCustom ? (
                    <button type="button" className="memory-app-budget-reset" onClick={onReset}>跟随默认</button>
                ) : null}
                <span className="memory-app-budget-value">{isCustom ? override : `默认 ${fallback}`}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={isCustom ? override : fallback}
                onChange={e => onChange(Number(e.target.value))}
                className="ui-slider memory-app-budget-slider"
                aria-label={`${label}短期记忆截断量`}
            />
        </div>
    );
}

function relativeTime(isoStr: string): string {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}天前`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}周前`;
    return `${Math.floor(days / 30)}个月前`;
}

type CharacterMemoryInfo = {
    character: Character;
    longTermCount: number;
    coreCount: number;
    shortTermCount: number;
};

type Props = {
    view: MemoryView;
    selectedCharId?: string;
    onSelectChar: (charId: string) => void;
    onNotice?: (msg: string) => void;
};

export function MemoryBankPage({ view, selectedCharId, onSelectChar, onNotice }: Props) {
    const [config, setConfig] = useState<MemoryConfig>(loadMemoryConfig);
    const [characters, setCharacters] = useState<CharacterMemoryInfo[]>([]);
    const [activeTab, setActiveTab] = useState<MemoryTab>("short");
    const [coreEntries, setCoreEntries] = useState<MemoryEntry[]>([]);
    const [longTermEntries, setLongTermEntries] = useState<MemoryEntry[]>([]);
    const [shortTermEvents, setShortTermEvents] = useState<NativeTimelineEntry[]>([]);
    const [sharedEvents, setSharedEvents] = useState<NativeTimelineEntry[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [summarizing, setSummarizing] = useState(false);
    const [rebuildingCore, setRebuildingCore] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
    const [editingCorePrompt, setEditingCorePrompt] = useState<string | null>(null);
    const [editingEventBoxPrompt, setEditingEventBoxPrompt] = useState<string | null>(null);
    // 最近删除页里「彻底删除」与「清空回收站」的二次确认（这里删掉就真的没了）
    const [confirmPurgeEntry, setConfirmPurgeEntry] = useState<MemoryEntry | null>(null);
    const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
    /** 批量删除的二次确认：只移入回收站，不真删 */
    const [confirmClearAll, setConfirmClearAll] = useState<null | "core" | "long_term">(null);
    const [pickedCharId, setPickedCharId] = useState<string | null>(null);
    /** 首页角色选择器：展开下拉 + 方框里输入的人名检索词 */
    const [charPickerOpen, setCharPickerOpen] = useState(false);
    const [charPickerQuery, setCharPickerQuery] = useState("");
    const [entryMenuId, setEntryMenuId] = useState<string | null>(null);
    const [memoryEditor, setMemoryEditor] = useState<MemoryEditorState | null>(null);
    const [savingMemory, setSavingMemory] = useState(false);
    const [embeddingAll, setEmbeddingAll] = useState(false);
    /** 正在「重新总结」的条目 id */
    const [resplittingEntryId, setResplittingEntryId] = useState<string | null>(null);
    /** 「重新总结」弹窗：先写修正思路，再带着它让模型重新总结 */
    const [resummarizeDialog, setResummarizeDialog] = useState<{ entry: MemoryEntry; instruction: string; isCore?: boolean } | null>(null);
    /** 核心记忆展开时的原文溯源结果（依据的长期记忆 + 原始记录），异步加载 */
    const [coreProvenance, setCoreProvenance] = useState<{
        longTermEntries: MemoryEntry[];
        rawEntries: Array<{ id: string; timestamp: string; sourceApp: string; content: string }>;
        earliest: string;
        latest: string;
        totalLongTerm: number;
    } | null>(null);
    const [coreProvenanceLoading, setCoreProvenanceLoading] = useState(false);
    /** 一键将旧版遗留的拆分碎片移入回收站 */
    const [cleaningFragments, setCleaningFragments] = useState(false);
    const [cleaningManualText, setCleaningManualText] = useState(false);
    const [cleaningAllLegacy, setCleaningAllLegacy] = useState(false);
    const [cleanLegacyProgress, setCleanLegacyProgress] = useState("");
    const [cleaningLegacyEntryId, setCleaningLegacyEntryId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchingVectors, setSearchingVectors] = useState(false);
    const [searchScoreMap, setSearchScoreMap] = useState<Record<string, number> | null>(null);
    const [summarizeRangeOpen, setSummarizeRangeOpen] = useState(false);
    const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
    const [appBudgetOpen, setAppBudgetOpen] = useState(false);

    // ── 事件盒（位于「长期」与「核心」之间）──
    const [boxes, setBoxes] = useState<MemoryEventBox[]>([]);
    const [activeBoxId, setActiveBoxId] = useState<string | null>(null);
    const [flashTargetId, setFlashTargetId] = useState<string | null>(null);
    const [boxSummarizing, setBoxSummarizing] = useState(false);
    const [batchBoxSummarizing, setBatchBoxSummarizing] = useState(false);
    const [batchBoxProgress, setBatchBoxProgress] = useState("");
    const [digestHistoryOpen, setDigestHistoryOpen] = useState(false);
    const [boxMoveEntryId, setBoxMoveEntryId] = useState<string | null>(null);
    const [boxDialog, setBoxDialog] = useState<{
        boxId?: string;
        title: string;
        importance: number; // 1-10
        keywordsText: string;
        summaryText?: string;
        pendingEntryId?: string;
    } | null>(null);
    const [savingBoxDialog, setSavingBoxDialog] = useState(false);
    const [boxConfirm, setBoxConfirm] = useState<{ kind: "delete" | "restore"; boxId: string } | null>(null);
    const [boxAddPickerOpen, setBoxAddPickerOpen] = useState(false);
    const [boxAddSelectedIds, setBoxAddSelectedIds] = useState<Record<string, boolean>>({});
    const [smartSuggestions, setSmartSuggestions] = useState<SmartBoxSuggestion[]>([]);
    const [smartSelected, setSmartSelected] = useState<Record<string, boolean>>({});
    const [smartBusy, setSmartBusy] = useState(false);

    // 「放入事件盒」模块：事件盒选项区最多显示三行，超出上下滑动。
    // 行高由 chip 实测得出（不同主题/字号下不写死），量不到就整段展开不滚。
    const boxChipScrollRef = useRef<HTMLDivElement | null>(null);
    const [boxChipMaxHeight, setBoxChipMaxHeight] = useState<number | undefined>(undefined);

    const disabledSourceCount = MEMORY_SOURCE_OPTIONS
        .filter(source => (config.shortTermAllowedSources ?? {})[source.key] === false).length;

    const appBudgetOverrides = config.shortTermTokenBudgetByApp ?? {};
    const customAppBudgetCount = SHORT_TERM_BUDGET_APP_KEYS
        .filter(key => typeof appBudgetOverrides[key] === "number").length;

    // Resolve selected character object from ID
    const selectedChar = selectedCharId
        ? loadCharacters().find(c => c.id === selectedCharId) ?? null
        : null;

    const loadCharacterList = useCallback(async (isCancelled?: () => boolean) => {
        const allChars = loadCharacters();

        let charIdsWithMem: string[] = [];
        try { charIdsWithMem = await getAllCharacterIdsWithMemories(); } catch { /* DB may fail */ }

        const infos: CharacterMemoryInfo[] = [];
        const seen = new Set<string>();

        // Characters with memories first
        for (const id of charIdsWithMem) {
            const char = allChars.find(c => c.id === id);
            if (!char) continue;
            seen.add(id);
            let ltCount = 0;
            let coreCount = 0;
            try {
                [ltCount, coreCount] = await Promise.all([
                    getMemoryCountByType(id, "long_term"),
                    getMemoryCountByType(id, "core"),
                ]);
            } catch { /* ignore */ }
            infos.push({ character: char, longTermCount: ltCount, coreCount, shortTermCount: 0 });
        }

        // Remaining characters
        for (const char of allChars) {
            if (seen.has(char.id)) continue;
            infos.push({ character: char, longTermCount: 0, coreCount: 0, shortTermCount: 0 });
        }

        if (isCancelled?.()) return;
        setCharacters(infos);

        // 短期计数逐个异步补齐：loadNativeTimeline 是全量组装，重数据账号
        // 在循环里同步跑完会长时间卡死主线程、瞬时吃掉大量内存
        for (const info of infos) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (isCancelled?.()) return;
            let stCount = 0;
            try { stCount = loadNativeTimeline(info.character.id).length; } catch { /* ignore */ }
            if (isCancelled?.()) return;
            setCharacters(prev => prev.map(item =>
                item.character.id === info.character.id ? { ...item, shortTermCount: stCount } : item));
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        void loadCharacterList(() => cancelled);
        return () => { cancelled = true; };
    }, [loadCharacterList]);

    // Load detail data when entering detail view
    const loadDetailData = useCallback(async (charId: string) => {
        setLoading(true);
        try {
            await hydrateChatStorage();
            const [rawCore, rawLt] = await Promise.all([
                loadMemoryEntriesByType(charId, "core"),
                loadMemoryEntriesByType(charId, "long_term"),
            ]);
            // 自动清理在「最近删除」中已满 60 天（TRASH_RETENTION_DAYS）的过期条目；正常记忆一条都不碰
            const purged = await purgeExpiredTrashed([...rawCore, ...rawLt]);
            const purgedSet = purged.ids.length > 0 ? new Set(purged.ids) : null;
            const core = purgedSet ? rawCore.filter(e => !purgedSet.has(e.id)) : rawCore;
            const lt = purgedSet ? rawLt.filter(e => !purgedSet.has(e.id)) : rawLt;
            setCoreEntries(core);
            setLongTermEntries(lt);
            setBoxes(loadEventBoxes(charId));
        } catch {
            setCoreEntries([]);
            setLongTermEntries([]);
            setBoxes(loadEventBoxes(charId));
        }
        // Native timeline is sync (localStorage) — no await needed.
        // 只取最近一段（全量可能几万条），防止解析+渲染把 iOS Safari 内存顶爆
        const timeline = loadNativeTimeline(charId).slice(-MEMORY_TIMELINE_ENTRY_CAP);
        setShortTermEvents(timeline.filter(e =>
            !(e.sourceApp === "moments" && e.postAuthorType === "user")
            && !(e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setSharedEvents(timeline.filter(e =>
            (e.sourceApp === "moments" && e.postAuthorType === "user") ||
            (e.sourceApp === "chat" && e.sourceDetail === "group") ||
            (e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setLoading(false);
    }, []);

    // Reload detail data when view changes to detail
    useEffect(() => {
        if (view === "detail" && selectedCharId) {
            setActiveTab("short");
            setActiveBoxId(null);
            setExpandedId(null);
            setSearchQuery("");
            setSearchScoreMap(null);
            loadDetailData(selectedCharId);
        }
    }, [view, selectedCharId, loadDetailData]);

    // Reset editing prompt when leaving settings
    useEffect(() => {
        if (view !== "settings") {
            setEditingPrompt(null);
            setEditingCorePrompt(null);
            setEditingEventBoxPrompt(null);
        }
    }, [view]);

    // 事件盒功能已整个移除：任何来源把标签设为 boxes 都直接落回短期列表，不再渲染已废弃的盒子页
    useEffect(() => {
        if ((activeTab as string) === "boxes") setActiveTab("short");
    }, [activeTab]);

    // 核心记忆展开时按需追溯「这条结论是从哪些长期记忆与原始记录里提炼出来的」
    useEffect(() => {
        let cancelled = false;
        setCoreProvenance(null);
        if (!selectedCharId || !expandedId) return;
        const target = coreEntries.find(e => e.id === expandedId);
        if (!target) return;
        setCoreProvenanceLoading(true);
        void (async () => {
            try {
                const res = await resolveCoreMemorySource(selectedCharId, target);
                if (!cancelled) setCoreProvenance(res);
            } catch {
                if (!cancelled) setCoreProvenance(null);
            } finally {
                if (!cancelled) setCoreProvenanceLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [selectedCharId, expandedId, coreEntries]);

    // 量出「放入事件盒」里单个 chip 的高度，把列表滚动区的最大高度压到三行以内
    useEffect(() => {
        const el = boxChipScrollRef.current;
        if (!el) {
            setBoxChipMaxHeight(undefined);
            return;
        }
        const CHIP_GAP = 6; // 与 .mem-box-chip-scroll 的 gap 保持一致
        const measure = () => {
            const first = el.firstElementChild as HTMLElement | null;
            const rowHeight = first?.offsetHeight ?? 0;
            if (rowHeight <= 0) return;
            setBoxChipMaxHeight(rowHeight * 3 + CHIP_GAP * 2);
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, [memoryEditor ? memoryEditor.entry?.id ?? "new" : null, boxes.length]);

    const handleSelectChar = (char: Character) => {
        onSelectChar(char.id);
    };

    /**
     * 批量把某一类记忆全部移进「最近删除」。
     * 这里不做真正的删除——怕误删的人点错一次不该丢档，真删只留给回收站里的「彻底删除」。
     */
    const handleClearEntries = async (type: "core" | "long_term") => {
        if (!selectedCharId) return;
        const targets = (type === "core" ? coreEntries : longTermEntries).filter(e => !isEntryTrashed(e));
        try {
            for (const entry of targets) {
                await trashMemoryEntry(entry, { by: "user" });
            }
            await loadDetailData(selectedCharId);
            loadCharacterList();
            showNotice(`已将 ${targets.length} 条${type === "core" ? "核心" : "长期"}记忆移入「最近删除」，可随时恢复`);
        } catch (err) {
            showNotice("批量删除失败: " + String(err));
        }
    };

    // ── 最近删除（回收站）──
    /**
     * 删除一条记忆 = 移进「最近删除」。正文完整保留、立刻停止注入，随时可恢复。
     * 真正的彻底删除只在回收站页面里做，所以主列表不需要「弃用」这第二个按钮。
     */
    const handleTrashEntry = async (entry: MemoryEntry) => {
        if (!selectedCharId) return;
        setEntryMenuId(null);
        try {
            await trashMemoryEntry(entry, { by: "user" });
            await loadDetailData(selectedCharId);
            loadCharacterList();
            showNotice(`已移入「最近删除」，${TRASH_RETENTION_DAYS} 天内可恢复`);
        } catch (err) {
            showNotice("删除失败: " + String(err));
        }
    };

    const handleRestoreTrashed = async (entry: MemoryEntry) => {
        if (!selectedCharId) return;
        try {
            const { removedDerivedCount } = await restoreTrashedEntry(entry);
            await loadDetailData(selectedCharId);
            loadCharacterList();
            showNotice(
                removedDerivedCount > 0
                    ? `已恢复原记忆，并自动撤回当初派生出的 ${removedDerivedCount} 条重总结条目`
                    : "已恢复，这条记忆会重新参与记忆注入",
            );
        } catch (err) {
            showNotice("恢复失败: " + String(err));
        }
    };

    const handleRestoreAllTrashed = async (entries: MemoryEntry[]) => {
        if (!selectedCharId || entries.length === 0) return;
        try {
            // 若回收站里同时包含「原记忆」和它派生的子条目，恢复原记忆会自动撤掉子条目，这里跳过已撤掉的子条目
            const removedIds = new Set<string>();
            let restoredCount = 0;
            for (const entry of entries) {
                if (removedIds.has(entry.id)) continue;
                const derived = Array.isArray(entry.metadata?.resplitInto)
                    ? (entry.metadata!.resplitInto as unknown[]).map(String)
                    : [];
                for (const cid of derived) removedIds.add(cid);
                await restoreTrashedEntry(entry);
                restoredCount += 1;
            }
            await loadDetailData(selectedCharId);
            loadCharacterList();
            showNotice(`已恢复 ${restoredCount} 条记忆`);
        } catch (err) {
            showNotice("批量恢复失败: " + String(err));
        }
    };

    /** 彻底删除单条：仅在「最近删除」里可用，执行后不可恢复 */
    const handlePurgeTrashed = async (entry: MemoryEntry) => {
        if (!selectedCharId) return;
        try {
            await permanentlyDeleteTrashed([entry.id]);
            await loadDetailData(selectedCharId);
            loadCharacterList();
            showNotice("已彻底删除");
        } catch (err) {
            showNotice("删除失败: " + String(err));
        }
    };

    /** 清空回收站：把当前角色「最近删除」中的所有已删除条目彻底删除 */
    const handleEmptyTrash = async () => {
        if (!selectedCharId) return;
        const trashedIds = [...coreEntries, ...longTermEntries]
            .filter(isEntryTrashed)
            .map(e => e.id);
        if (trashedIds.length === 0) return;
        try {
            await permanentlyDeleteTrashed(trashedIds);
            await loadDetailData(selectedCharId);
            loadCharacterList();
            showNotice(`已彻底清空 ${trashedIds.length} 条已删除记忆`);
        } catch (err) {
            showNotice("清空回收站失败: " + String(err));
        }
    };

    /**
     * 重新总结：必须追溯到原始对话/事件记录，无原文绝不编造。
     * instruction 是用户在弹窗里写的修正思路，会以最高优先级注入提示词。
     */
    const handleResplitEntry = async (entry: MemoryEntry, instruction?: string) => {
        if (!selectedCharId || resplittingEntryId) return;
        setEntryMenuId(null);
        setResummarizeDialog(null);
        setResplittingEntryId(entry.id);
        try {
            // 核心记忆与长期记忆的重新总结走不同链路：
            // 核心记忆依据的是「当时的长期记忆 + 它们的原始记录」，长期记忆依据的是自己的原文存档。
            if (entry.type === "core") {
                const coreRes = await resummarizeCoreMemory(
                    selectedCharId,
                    selectedChar?.name ?? "角色",
                    entry.id,
                    instruction,
                );
                if (coreRes.success) {
                    await loadDetailData(selectedCharId);
                    loadCharacterList();
                    showNotice("已按依据的长期记忆与原始记录重新提炼核心记忆，旧版本标记为历史记录（可回看）");
                } else {
                    showNotice(coreRes.error || "核心记忆重新总结失败");
                }
                return;
            }

            const res = await resplitMergedMemory(
                selectedCharId,
                selectedChar?.name ?? "角色",
                entry.id,
                instruction,
            );
            if (res.success) {
                await loadDetailData(selectedCharId);
                loadCharacterList();
                showNotice(
                    (res.createdCount ?? 0) > 1
                        ? `已按原文拆分为 ${res.createdCount} 条独立记忆并生成向量，原条目已移入「最近删除」（恢复原条目会自动撤回新条目）`
                        : "已按原始对话记录重新总结修正并更新向量，原条目已移入「最近删除」",
                );
            } else {
                showNotice(res.error || "重新总结失败");
            }
        } catch (err) {
            showNotice("重新总结出错: " + String(err));
        } finally {
            setResplittingEntryId(null);
        }
    };

    /** 清理此前旧版批量拆分遗留的 mem_lt_resplit_ 碎片（软删除进回收站，仍可恢复） */
    const handleCleanLegacyFragments = async () => {
        if (!selectedCharId || cleaningFragments) return;
        setCleaningFragments(true);
        try {
            const res = await trashAllLegacyResplitFragments(longTermEntries);
            await loadDetailData(selectedCharId);
            loadCharacterList();
            showNotice(res.count > 0 ? `已将 ${res.count} 条旧版拆分遗留碎片移入「最近删除」` : "没有需要清理的旧碎片");
        } catch (err) {
            showNotice("清理碎片出错: " + String(err));
        } finally {
            setCleaningFragments(false);
        }
    };

    /** 把角色改过的记忆还原到修改前的内容（长期记忆自动同步重算向量） */
    const handleRevertCharacterEdit = async (entry: MemoryEntry) => {
        if (!selectedCharId) return;
        try {
            const snapshot = readEditSnapshot(entry);
            if (!snapshot) {
                showNotice("这条记忆没有可还原的修改快照");
                return;
            }
            let rebuiltEmbedding: number[] | undefined;
            if (entry.type === "long_term" && config.vectorRecallEnabled) {
                const kws = Array.isArray(entry.metadata?.keywords)
                    ? (entry.metadata.keywords as unknown[]).map(String).filter(Boolean)
                    : extractMemoryStructuredMeta(snapshot.content).keywords;
                const cleanSnap = stripMemoryStructuredSections(snapshot.content) || snapshot.content;
                const embInput = kws.length > 0 ? `关键词：${kws.join("、")}\n${cleanSnap}` : cleanSnap;
                rebuiltEmbedding = await maybeBuildManualMemoryEmbedding("long_term", embInput);
            }
            const reverted = await revertCharacterEdit(entry, rebuiltEmbedding);
            if (!reverted) {
                showNotice("这条记忆没有可还原的修改快照");
                return;
            }
            await loadDetailData(selectedCharId);
            loadCharacterList();
            showNotice("已还原到角色修改前的版本");
        } catch (err) {
            showNotice("还原失败: " + String(err));
        }
    };

    const showNotice = (msg: string) => {
        onNotice?.(msg);
    };

    /** 滚动到指定 DOM 元素并触发 1.8s 高亮呼吸闪烁 */
    const scrollToAndFlash = useCallback((domId: string, highlightKey: string) => {
        setFlashTargetId(highlightKey);
        setTimeout(() => {
            const el = document.getElementById(domId);
            if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }, 80);
        setTimeout(() => {
            setFlashTargetId(prev => (prev === highlightKey ? null : prev));
        }, 1900);
    }, []);

    // ── 事件盒操作 ──
    const handleSaveBoxDialog = async () => {
        if (!selectedCharId || !boxDialog || savingBoxDialog) return;
        const cleanTitle = boxDialog.title.trim();
        if (!cleanTitle) {
            showNotice("请输入事件盒名称");
            return;
        }
        const parsedKws = boxDialog.keywordsText
            .split(/[、，,；;|/\s]+/)
            .map(s => s.trim())
            .filter(Boolean);
        const cleanSummary = (boxDialog.summaryText ?? "").trim();
        const normalizedBoxImp = Math.max(0.1, Math.min(1, Number(((boxDialog.importance || 8) / 10).toFixed(2))));
        const pendingEntryId = boxDialog.pendingEntryId;
        setSavingBoxDialog(true);
        try {
            if (boxDialog.boxId) {
                const targetBoxBefore = boxes.find(b => b.id === boxDialog.boxId);
                const { digestEntry, allMemberEntries } = targetBoxBefore
                    ? getBoxLayers(longTermEntries, targetBoxBefore)
                    : { digestEntry: undefined, allMemberEntries: [] as MemoryEntry[] };
                const now = new Date().toISOString();
                let nextDigestId = targetBoxBefore?.digestEntryId;

                if (digestEntry || cleanSummary) {
                    const finalBody = cleanSummary || (digestEntry ? (stripMemoryStructuredSections(digestEntry.content) || digestEntry.content).trim() : "");
                    if (finalBody) {
                        const prevClean = digestEntry ? (stripMemoryStructuredSections(digestEntry.content) || digestEntry.content).trim() : "";
                        const prevKws = Array.isArray(digestEntry?.metadata?.keywords)
                            ? (digestEntry!.metadata!.keywords as unknown[]).map(String).join(",")
                            : "";
                        const bodyOrKwsChanged = !digestEntry || finalBody !== prevClean || parsedKws.join(",") !== prevKws;

                        let embedding = digestEntry?.embedding;
                        if (bodyOrKwsChanged || !embedding?.length) {
                            const embInput = parsedKws.length > 0 ? `关键词：${parsedKws.join("、")}\n${finalBody}` : finalBody;
                            const newEmb = await maybeBuildManualMemoryEmbedding("long_term", embInput);
                            if (newEmb) embedding = newEmb;
                        }

                        const chronologicAll = [...allMemberEntries].sort((a, b) =>
                            String(a.metadata?.eventDate ?? a.createdAt).localeCompare(String(b.metadata?.eventDate ?? b.createdAt))
                        );
                        const earliest = chronologicAll[0]
                            ? String(chronologicAll[0].metadata?.eventDate ?? chronologicAll[0].createdAt.slice(0, 10))
                            : now.slice(0, 10);
                        const latest = chronologicAll[chronologicAll.length - 1]
                            ? String(chronologicAll[chronologicAll.length - 1].metadata?.eventDate ?? chronologicAll[chronologicAll.length - 1].createdAt.slice(0, 10))
                            : now.slice(0, 10);

                        nextDigestId = digestEntry?.id ?? `mem_lt_boxdigest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                        const updatedDigest: MemoryEntry = {
                            id: nextDigestId,
                            characterId: selectedCharId,
                            sourceApp: digestEntry?.sourceApp ?? chronologicAll[0]?.sourceApp ?? "chat",
                            type: "long_term",
                            content: finalBody,
                            embedding,
                            importance: normalizedBoxImp,
                            accessCount: digestEntry?.accessCount ?? 0,
                            createdAt: digestEntry?.createdAt ?? chronologicAll[0]?.createdAt ?? now,
                            updatedAt: now,
                            metadata: {
                                ...(digestEntry?.metadata ?? {}),
                                origin: "event_box_digest",
                                editedByUser: true,
                                eventBoxId: boxDialog.boxId,
                                eventBoxDigestOf: boxDialog.boxId,
                                eventBoxTitle: cleanTitle,
                                eventDate: latest,
                                timeSpan: earliest === latest ? earliest : `${earliest} ~ ${latest}`,
                                keywords: parsedKws,
                                sourceEntryCount: allMemberEntries.length,
                                topicSplitV2: true,
                                resplitDone: true,
                                ...(embedding ? { embeddingDim: embedding.length } : {}),
                            },
                        };
                        await saveMemoryEntry(updatedDigest);
                    }
                }

                // 同步更新盒内所有关联条目的 eventBoxTitle
                for (const member of allMemberEntries) {
                    if (member.metadata?.eventBoxTitle !== cleanTitle) {
                        await saveMemoryEntry({
                            ...member,
                            updatedAt: now,
                            metadata: {
                                ...(member.metadata ?? {}),
                                eventBoxTitle: cleanTitle,
                            },
                        });
                    }
                }

                const next = updateEventBox(selectedCharId, boxDialog.boxId, {
                    title: cleanTitle,
                    importance: normalizedBoxImp,
                    keywords: parsedKws,
                    ...(nextDigestId ? { digestEntryId: nextDigestId } : {}),
                });
                setBoxes(next);
                await loadDetailData(selectedCharId);
                showNotice("事件盒与总结内容已更新");
            } else {
                const created = createEventBox(selectedCharId, cleanTitle, "active", undefined, parsedKws, normalizedBoxImp);
                setBoxes(loadEventBoxes(selectedCharId));
                if (pendingEntryId) {
                    const target = longTermEntries.find(e => e.id === pendingEntryId);
                    if (target) {
                        const updated = await moveEntryToBox(target, created.id);
                        setLongTermEntries(prev => prev.map(item => (item.id === updated.id ? updated : item)));
                    }
                    setBoxMoveEntryId(null);
                    showNotice(`已创建事件盒「${created.title}」并放入记忆`);
                } else {
                    showNotice(`已创建事件盒「${created.title}」`);
                }
            }
            setBoxDialog(null);
        } finally {
            setSavingBoxDialog(false);
        }
    };

    const handleMoveSingleEntryToBox = async (boxId: string) => {
        if (!selectedCharId || !boxMoveEntryId) return;
        const target = longTermEntries.find(e => e.id === boxMoveEntryId);
        if (!target) return;
        const box = boxes.find(b => b.id === boxId);
        const updated = await moveEntryToBox(target, boxId);
        setLongTermEntries(prev => prev.map(item => (item.id === updated.id ? updated : item)));
        setBoxMoveEntryId(null);
        showNotice(`已放入事件盒「${box?.title ?? "事件盒"}」的新事件中`);
    };

    const handleRemoveEntryFromBox = async (entryId: string) => {
        const target = longTermEntries.find(e => e.id === entryId);
        if (!target) return;
        const updated = await removeEntryFromBox(target);
        setLongTermEntries(prev => prev.map(item => (item.id === updated.id ? updated : item)));
        setBoxMoveEntryId(null);
        setEntryMenuId(null);
        showNotice("已移出事件盒");
    };

    const handleUnarchiveEntry = async (entry: MemoryEntry) => {
        const updated = await unarchiveSingleBoxEntry(entry);
        setLongTermEntries(prev => prev.map(item => (item.id === updated.id ? updated : item)));
        setEntryMenuId(null);
        showNotice("已取消归档，移回「新事件」");
    };

    /** 在盒内批量把未归盒记忆添加进当前盒子的「新事件」 */
    const handleConfirmAddEntriesToBox = async () => {
        if (!selectedCharId || !activeBoxId) return;
        const chosenIds = Object.keys(boxAddSelectedIds).filter(id => boxAddSelectedIds[id]);
        if (chosenIds.length === 0) return;
        for (const id of chosenIds) {
            const target = longTermEntries.find(e => e.id === id);
            if (target) {
                await moveEntryToBox(target, activeBoxId);
            }
        }
        setBoxAddPickerOpen(false);
        setBoxAddSelectedIds({});
        await loadDetailData(selectedCharId);
        showNotice(`已将 ${chosenIds.length} 条记忆加入「新事件」，可点击上方「手动总结」归档`);
    };

    /** 用户在事件盒内手动点击「总结」：总结 + 自动向量化 + 原记忆移入下方已归档 */
    const handleManualSummarizeBox = async (boxId: string) => {
        if (!selectedCharId || boxSummarizing) return;
        setBoxSummarizing(true);
        try {
            const res = await summarizeEventBoxManually(
                selectedCharId,
                selectedChar?.name ?? "角色",
                boxId,
                longTermEntries,
            );
            if (!res.success) {
                showNotice(res.error || "事件盒总结失败");
                return;
            }
            await loadDetailData(selectedCharId);
            const hasVec = Boolean(res.digestEntry?.embedding && res.digestEntry.embedding.length > 0);
            showNotice(hasVec
                ? "事件盒总结完成并已自动向量化，原记忆已移至下方「已归档事件」"
                : "事件盒总结完成，原记忆已移至下方「已归档事件」");
        } catch (err) {
            showNotice("事件盒总结出错: " + String(err));
        } finally {
            setBoxSummarizing(false);
        }
    };

    const handleConfirmBoxAction = async () => {
        if (!selectedCharId || !boxConfirm) return;
        const { kind, boxId } = boxConfirm;
        setBoxConfirm(null);
        if (kind === "restore") {
            const res = await restoreEventBoxArchivedEntries(selectedCharId, boxId, longTermEntries);
            await loadDetailData(selectedCharId);
            showNotice(`已撤销总结，${res.restoredCount} 条记忆已恢复为「新事件」`);
        } else {
            const res = await deleteEventBoxAndKeepEntries(selectedCharId, boxId, longTermEntries);
            if (activeBoxId === boxId) setActiveBoxId(null);
            await loadDetailData(selectedCharId);
            showNotice(`已删除事件盒，盒内 ${res.detachedCount} 条原始记忆均已保留`);
        }
    };

    /** 智能识别相关记忆归盒（只归入事件盒，绝不自动批量总结） */
    const handleRunSmartBoxSuggest = async () => {
        if (!selectedCharId || smartBusy) return;
        const ungrouped = longTermEntries.filter(e => !isEntryTrashed(e) && !getEntryBoxId(e) && !isEntryBoxDigest(e));
        if (ungrouped.length < 2 && boxes.length === 0) {
            showNotice("当前未归盒的长期记忆不足 2 条，可先手动新建事件盒");
            return;
        }
        setSmartBusy(true);
        try {
            const list = await buildSmartBoxSuggestions(
                selectedCharId,
                selectedChar?.name ?? "角色",
                longTermEntries,
                boxes,
            );
            if (list.length === 0) {
                showNotice("未发现明显属于同一件事的零散记忆，可手动新建事件盒并添加记忆");
                return;
            }
            setSmartSuggestions(list);
            const initSel: Record<string, boolean> = {};
            for (const item of list) initSel[item.key] = true;
            setSmartSelected(initSel);
        } catch (err) {
            showNotice("智能识别出错: " + String(err));
        } finally {
            setSmartBusy(false);
        }
    };

    /** 批量总结所有含「新事件」或待总结内容的事件盒 */
    const handleBatchSummarizeBoxes = async (targetBoxIds?: string[]) => {
        if (!selectedCharId || batchBoxSummarizing || boxSummarizing) return;
        setBatchBoxSummarizing(true);
        setBatchBoxProgress("准备中");
        try {
            const latestEntries = await loadMemoryEntriesByType(selectedCharId, "long_term");
            const res = await summarizeAllPendingEventBoxes(
                selectedCharId,
                selectedChar?.name ?? "角色",
                latestEntries,
                targetBoxIds,
                (done, total) => setBatchBoxProgress(`${done}/${total}`),
            );
            await loadDetailData(selectedCharId);
            if (res.summarizedCount > 0) {
                showNotice(
                    res.failedCount > 0
                        ? `已完成 ${res.summarizedCount} 个事件盒总结（${res.failedCount} 个失败：${res.lastError ?? ""}）`
                        : `已批量完成 ${res.summarizedCount} 个事件盒的总结与归档`
                );
            } else if (res.failedCount > 0) {
                showNotice(res.lastError || "批量总结失败");
            } else {
                showNotice("当前没有需要更新总结的事件盒");
            }
        } catch (err) {
            showNotice("批量总结出错: " + String(err));
        } finally {
            setBatchBoxSummarizing(false);
            setBatchBoxProgress("");
        }
    };

    const handleConfirmSmartSuggestions = async (autoSummarize = false) => {
        if (!selectedCharId || smartBusy) return;
        const chosen = smartSuggestions.filter(s => smartSelected[s.key]);
        if (chosen.length === 0) return;
        setSmartBusy(true);
        try {
            let totalMoved = 0;
            const touchedBoxIds: string[] = [];
            for (const group of chosen) {
                const targetBoxId = group.targetBoxId
                    ? group.targetBoxId
                    : createEventBox(selectedCharId, group.title, "active").id;
                touchedBoxIds.push(targetBoxId);
                for (const entry of group.entries) {
                    await moveEntryToBox(entry, targetBoxId);
                    totalMoved += 1;
                }
            }
            setSmartSuggestions([]);
            setSmartSelected({});
            await loadDetailData(selectedCharId);
            if (autoSummarize && touchedBoxIds.length > 0) {
                setSmartBusy(false);
                await handleBatchSummarizeBoxes(touchedBoxIds);
            } else {
                showNotice(`已将 ${totalMoved} 条记忆放入事件盒，可点击顶栏「批量总结」或点开事件盒总结`);
            }
        } catch (err) {
            showNotice("归入事件盒出错: " + String(err));
        } finally {
            setSmartBusy(false);
        }
    };

    const handleManualSummarize = async (range: SummarizeRange = "auto") => {
        if (!selectedCharId || summarizing) return;
        setSummarizeRangeOpen(false);
        setSummarizing(true);
        try {
            const sinceTimestamp = typeof range === "number"
                ? new Date(Date.now() - range * 86400000).toISOString()
                : undefined;
            const afterTimestamp = range === "all"
                ? undefined
                : sinceTimestamp ?? getLastSummarizedTimestamp(selectedCharId) ?? undefined;
            const timelineCount = filterTimelineByAllowedSources(
                loadNativeTimeline(
                    selectedCharId,
                    afterTimestamp ? { afterTimestamp } : undefined,
                ),
                config.shortTermAllowedSources,
            ).length;
            if (timelineCount < 4) {
                showNotice("所选范围内事件不足 4 条");
                return;
            }

            const result = await runSummarizationPipeline(
                selectedCharId,
                selectedChar?.name ?? "",
                range === "all" ? { force: true } : sinceTimestamp ? { sinceTimestamp } : undefined,
            );
            if (result.success) {
                showNotice("总结完成");
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "总结失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual summarize failed:", err);
            showNotice("总结失败: " + String(err));
        } finally {
            setSummarizing(false);
        }
    };

    const handleManualRebuildCore = async () => {
        if (!selectedCharId || rebuildingCore) return;
        setRebuildingCore(true);
        try {
            const lastCoreSummarizedAt = getLastCoreSummarizedTimestamp(selectedCharId);
            const longTermEntries = (await loadMemoryEntriesByType(selectedCharId, "long_term")).filter(e => !isEntryTrashed(e));
            const pendingLongTermCount = longTermEntries.filter(entry =>
                !lastCoreSummarizedAt || entry.createdAt > lastCoreSummarizedAt
            ).length;
            if (pendingLongTermCount === 0) {
                showNotice(lastCoreSummarizedAt ? "没有新的长期记忆需要总结" : "没有可用于总结核心记忆的长期记忆");
                return;
            }

            const result = await runCoreMemoryPipeline(selectedCharId, selectedChar?.name ?? "");
            if (result.success) {
                if (result.skippedNoChange) {
                    showNotice("本周期无新增核心变化，已保留上一轮核心记忆");
                } else {
                    showNotice(result.rebuiltCount ? `核心记忆已更新（${result.rebuiltCount}条）` : "核心记忆已更新");
                }
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "核心记忆重建失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual core rebuild failed:", err);
            showNotice("核心记忆重建失败: " + String(err));
        } finally {
            setRebuildingCore(false);
        }
    };

    const saveBudget = (key: MemoryBudgetKey, value: number) => {
        if (!Number.isFinite(value)) return;
        const min = MEMORY_TOKEN_BUDGET_MIN[key];
        const nextValue = Math.min(MEMORY_TOKEN_BUDGET_MAX, Math.max(min, Math.round(value)));
        const next = { ...config, [key]: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    /** 传 null = 这个应用回到跟随默认（把键删掉，而不是写一个等于默认值的数）。 */
    const saveAppBudget = (key: string, value: number | null) => {
        const nextMap = { ...(config.shortTermTokenBudgetByApp ?? {}) };
        if (value === null) {
            delete nextMap[key];
        } else {
            if (!Number.isFinite(value)) return;
            const min = MEMORY_TOKEN_BUDGET_MIN.shortTermTokenBudget;
            nextMap[key] = Math.min(MEMORY_TOKEN_BUDGET_MAX, Math.max(min, Math.round(value)));
        }
        const next = { ...config, shortTermTokenBudgetByApp: nextMap };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(200, Math.max(10, Math.round(value)));
        const next = { ...config, summarizationEventInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveCoreInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(20, Math.max(1, Math.round(value)));
        const next = { ...config, coreSummarizationInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    // ── Prompt editing ──
    const handleSavePrompt = () => {
        if (editingPrompt === null) return;
        const next = { ...config, summarizationPrompt: editingPrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("提示词已保存");
    };

    const handleResetPrompt = () => {
        setEditingPrompt(DEFAULT_SUMMARIZATION_PROMPT);
        const next = { ...config, summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("已恢复默认提示词");
    };

    const handleSaveCorePrompt = () => {
        if (editingCorePrompt === null) return;
        const next = { ...config, coreMemoryPrompt: editingCorePrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("核心记忆提示词已保存");
    };

    const handleResetCorePrompt = () => {
        setEditingCorePrompt(DEFAULT_CORE_MEMORY_PROMPT);
        const next = { ...config, coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("核心记忆提示词已恢复默认");
    };

    // 事件盒提示词：存空串表示跟随内置默认；恢复默认时将 editing 状态置回 null，输入框立刻显示内置默认全文
    const handleSaveEventBoxPrompt = () => {
        if (editingEventBoxPrompt === null) return;
        const trimmed = editingEventBoxPrompt.trim();
        const stored = (!trimmed || trimmed === DEFAULT_EVENT_BOX_SUMMARY_PROMPT) ? "" : editingEventBoxPrompt;
        const next = { ...config, eventBoxSummaryPrompt: stored };
        setEditingEventBoxPrompt(null);
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("事件盒提示词已保存");
    };

    const handleResetEventBoxPrompt = () => {
        setEditingEventBoxPrompt(null);
        const next = { ...config, eventBoxSummaryPrompt: "" };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("事件盒提示词已恢复默认");
    };

    const createManualMemoryId = (type: MemoryEntry["type"]) => (
        `mem_${type === "core" ? "core" : "lt"}_manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );

    const isManualMemoryEntry = (entry: MemoryEntry) => {
        const origin = String(entry.metadata?.origin ?? "");
        return origin === "user_manual" || origin === "user_edited" || entry.id.includes("_manual_");
    };

    const maybeBuildManualMemoryEmbedding = async (type: MemoryEntry["type"], content: string): Promise<number[] | undefined> => {
        if (type !== "long_term" || !config.vectorRecallEnabled) return undefined;
        const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
        if (!embeddingApiConfig || !resolveEmbeddingModel(embeddingApiConfig)) return undefined;
        try {
            return await generateEmbedding(content, embeddingApiConfig) ?? undefined;
        } catch {
            return undefined;
        }
    };

    // 检测该角色记忆的主流/最新向量维度（用于发现换 Embedding 模型后维度不一致的旧向量）
    const expectedVectorDim = (() => {
        const observed = getLastObservedEmbeddingDim();
        if (observed > 0) return observed;
        for (const item of longTermEntries) {
            if (Array.isArray(item.embedding) && item.embedding.length > 0) {
                return item.embedding.length;
            }
        }
        return 0;
    })();

    const isEntryVectorValid = (entry: MemoryEntry): boolean => {
        if (!Array.isArray(entry.embedding) || entry.embedding.length === 0) return false;
        if (expectedVectorDim > 0 && entry.embedding.length !== expectedVectorDim) return false;
        return true;
    };

    const handleBackfillEmbeddings = async () => {
        if (!selectedCharId || embeddingAll) return;
        const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
        if (!embeddingApiConfig || !resolveEmbeddingModel(embeddingApiConfig)) {
            showNotice("请先在「设置 → 绑定配置 → 辅助 API 绑定」中配置向量检索 (Embedding) 模型");
            return;
        }
        const missing = longTermEntries.filter(e => !isEntryTrashed(e) && !isEntryVectorValid(e));
        if (missing.length === 0) {
            showNotice("当前所有长期记忆均已生成有效向量");
            return;
        }
        setEmbeddingAll(true);
        let done = 0;
        try {
            const inputs: string[] = [];
            const keywordsByIdx: string[][] = [];
            for (const item of missing) {
                const parsed = extractMemoryStructuredMeta(item.content);
                const kws = Array.isArray(item.metadata?.keywords) && (item.metadata.keywords as unknown[]).length > 0
                    ? (item.metadata.keywords as unknown[]).map(String)
                    : parsed.keywords;
                const cleanBody = stripMemoryStructuredSections(item.content) || item.content;
                const embInput = kws.length > 0 ? `关键词：${kws.join("、")}\n${cleanBody}` : cleanBody;
                inputs.push(embInput);
                keywordsByIdx.push(kws);
            }

            const embeddings = await generateEmbeddingsBatch(inputs, embeddingApiConfig);
            for (let i = 0; i < missing.length; i++) {
                const item = missing[i];
                const emb = embeddings[i];
                const kws = keywordsByIdx[i];
                if (emb && emb.length > 0) {
                    const updated: MemoryEntry = {
                        ...item,
                        embedding: emb,
                        metadata: {
                            ...(item.metadata ?? {}),
                            ...(kws.length > 0 ? { keywords: kws } : {}),
                            embeddingDim: emb.length,
                        },
                    };
                    await saveMemoryEntry(updated);
                    done += 1;
                }
            }
            await loadDetailData(selectedCharId);
            showNotice(done > 0 ? `已成功为 ${done}/${missing.length} 条记忆生成/更新向量` : "向量生成失败，请检查 Embedding API 配置");
        } catch (err) {
            showNotice("补全向量出错: " + String(err));
        } finally {
            setEmbeddingAll(false);
        }
    };

    const handleCleanSingleLegacyEntry = async (entry: MemoryEntry) => {
        if (!selectedCharId || cleaningLegacyEntryId || cleaningAllLegacy) return;
        setEntryMenuId(null);
        setCleaningLegacyEntryId(entry.id);
        try {
            const res = await cleanLegacyMemoryEntry(entry, selectedChar?.name ?? "角色");
            if (res.success && res.newEntries) {
                await loadDetailData(selectedCharId);
                loadCharacterList();
                showNotice(
                    res.newEntries.length > 1
                        ? `已将该条旧记忆清洗拆分为 ${res.newEntries.length} 条独立记忆`
                        : "已清洗该条记忆并补齐日期、关键词与向量",
                );
            } else {
                showNotice(res.error || "清洗旧记忆失败");
            }
        } catch (err) {
            showNotice("清洗旧记忆出错: " + String(err));
        } finally {
            setCleaningLegacyEntryId(null);
        }
    };

    const handleCleanAllLegacyMemories = async () => {
        if (!selectedCharId || cleaningAllLegacy || summarizing) return;
        const legacyTargets = longTermEntries.filter(e => !isEntryTrashed(e) && isLegacyUnorganizedMemory(e));
        if (legacyTargets.length === 0) {
            showNotice("当前没有需要清洗的长文本旧记忆");
            return;
        }
        setCleaningAllLegacy(true);
        setCleanLegacyProgress(`0/${legacyTargets.length}`);
        try {
            const res = await runBatchCleanLegacyMemories(
                selectedCharId,
                selectedChar?.name ?? "角色",
                {
                    targetEntries: legacyTargets,
                    onProgress: (done, total) => {
                        setCleanLegacyProgress(`${done}/${total}`);
                    },
                },
            );
            await loadDetailData(selectedCharId);
            loadCharacterList();
            if (res.success) {
                showNotice(`清洗完成：已将 ${res.processedCount} 条旧长文本记忆整理为 ${res.newTotalCount} 条规范记忆`);
            } else {
                showNotice(res.error || "一键清洗旧记忆失败");
            }
        } catch (err) {
            showNotice("一键清洗出错: " + String(err));
        } finally {
            setCleaningAllLegacy(false);
            setCleanLegacyProgress("");
        }
    };

    const handleRunVectorSearchTest = async () => {
        const q = searchQuery.trim();
        if (!q) {
            setSearchScoreMap(null);
            return;
        }
        const pool = (activeTab === "core" ? coreEntries : longTermEntries).filter(e => !isEntryTrashed(e));
        if (pool.length === 0 || searchingVectors) return;
        setSearchingVectors(true);
        try {
            const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
            const results = await searchMemories(q, pool, embeddingApiConfig, pool.length);
            const nextMap: Record<string, number> = {};
            for (const r of results) {
                nextMap[r.entry.id] = r.score;
            }
            setSearchScoreMap(nextMap);
        } catch (err) {
            showNotice("检索测试出错: " + String(err));
        } finally {
            setSearchingVectors(false);
        }
    };

    const openCreateMemoryEditor = (type: MemoryEntry["type"]) => {
        setEntryMenuId(null);
        setMemoryEditor({
            type,
            content: "",
            eventDate: getLocalTodayKey(),
            dateTouched: false,
            importance: type === "core" ? 10 : 8,
            keywordsText: "",
            eventBoxId: type === "long_term" && activeTab === "boxes" && activeBoxId ? activeBoxId : "",
        });
    };

    const openEditMemoryEditor = (entry: MemoryEntry) => {
        setEntryMenuId(null);
        const parsedMeta = extractMemoryStructuredMeta(entry.content);
        const existingKeywords = Array.isArray(entry.metadata?.keywords) && (entry.metadata.keywords as unknown[]).length > 0
            ? (entry.metadata.keywords as unknown[]).map(String)
            : parsedMeta.keywords;
        const cleanBody = stripMemoryStructuredSections(entry.content) || entry.content;
        const impScore = Math.max(1, Math.min(10, Math.round((Number.isFinite(entry.importance) ? entry.importance : 0.8) * 10)));
        const existingDate = typeof entry.metadata?.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.metadata.eventDate.trim())
            ? entry.metadata.eventDate.trim()
            : (parsedMeta.eventDate ?? entry.createdAt.slice(0, 10));
        setMemoryEditor({
            type: entry.type,
            entry,
            content: cleanBody,
            eventDate: existingDate || getLocalTodayKey(),
            dateTouched: true,
            importance: impScore,
            keywordsText: existingKeywords.join("、"),
            eventBoxId: getEntryBoxId(entry),
        });
    };

    const handleCleanManualText = async () => {
        if (!selectedCharId || !memoryEditor || cleaningManualText || savingMemory) return;
        const rawText = memoryEditor.content.trim();
        if (!rawText) {
            showNotice("请先在输入框中粘贴或输入需要清洗的记忆文本");
            return;
        }
        setCleaningManualText(true);
        try {
            const defaultDate = memoryEditor.eventDate || getLocalTodayKey();
            const res = await cleanAndSplitManualMemoryText(
                selectedCharId,
                selectedChar?.name ?? "角色",
                rawText,
                defaultDate,
            );
            if (!res.success || !res.drafts || res.drafts.length === 0) {
                showNotice(res.error || "清洗记忆失败");
                return;
            }
            const drafts: CleanedManualMemoryDraft[] = res.drafts;
            if (drafts.length === 1) {
                const d = drafts[0];
                setMemoryEditor(prev => prev ? {
                    ...prev,
                    content: d.cleanBody,
                    eventDate: d.eventDate || prev.eventDate,
                    dateTouched: true,
                    importance: d.importance,
                    keywordsText: d.keywords.join("、"),
                    cleanedDrafts: undefined,
                } : prev);
                showNotice(`已清洗记忆并提取日期（${d.eventDate}）`);
            } else {
                setMemoryEditor(prev => prev ? {
                    ...prev,
                    cleanedDrafts: drafts.map(d => ({
                        content: d.cleanBody,
                        eventDate: d.eventDate || prev.eventDate,
                        importance: d.importance,
                        keywordsText: d.keywords.join("、"),
                    })),
                } : prev);
                showNotice(`已将长文本清洗拆分为 ${drafts.length} 条独立记忆，可逐条核对或修改事件日期后保存`);
            }
        } catch (err) {
            showNotice("清洗拆分出错: " + String(err));
        } finally {
            setCleaningManualText(false);
        }
    };

    const handleSaveManualMemory = async () => {
        if (!selectedCharId || !memoryEditor || savingMemory) return;
        const todayKey = getLocalTodayKey();
        const type = memoryEditor.type;
        const source = memoryEditor.entry;

        // Multi-draft batch save mode (after AI cleaning & splitting)
        if (memoryEditor.cleanedDrafts && memoryEditor.cleanedDrafts.length > 0) {
            const validDrafts = memoryEditor.cleanedDrafts
                .map(d => ({
                    ...d,
                    content: d.content.trim(),
                    eventDate: /^\d{4}-\d{2}-\d{2}$/.test(d.eventDate.trim())
                        ? d.eventDate.trim()
                        : (extractDateFromRawText(d.content) ?? todayKey),
                }))
                .filter(d => d.content.length > 0);
            if (validDrafts.length === 0) {
                showNotice("没有可保存的有效记忆条目");
                return;
            }

            setSavingMemory(true);
            try {
                const nowMs = Date.now();
                const embeddingApiConfig = type === "long_term" && config.vectorRecallEnabled
                    ? resolveAuxiliaryApiConfig("embeddingApiConfigId")
                    : null;
                const canEmbed = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig));

                const parsedDrafts = validDrafts.map(d => {
                    const structuredMeta = extractMemoryStructuredMeta(d.content);
                    const cleanContent = stripMemoryStructuredSections(d.content) || d.content;
                    const kws = d.keywordsText
                        .split(/[、，,；;|/\s]+/)
                        .map(s => s.trim())
                        .filter(Boolean);
                    const finalKeywords = kws.length > 0 ? kws : structuredMeta.keywords;
                    const normalizedImportance = Math.max(0.1, Math.min(1, Number((d.importance / 10).toFixed(2))));
                    const embeddingInput = finalKeywords.length > 0
                        ? `关键词：${finalKeywords.join("、")}\n${cleanContent}`
                        : cleanContent;
                    return {
                        cleanContent,
                        eventDate: d.eventDate,
                        finalKeywords,
                        normalizedImportance,
                        embeddingInput,
                    };
                });

                let batchEmbeddings: Array<number[] | null> = [];
                if (canEmbed && embeddingApiConfig) {
                    try {
                        batchEmbeddings = await generateEmbeddingsBatch(
                            parsedDrafts.map(d => d.embeddingInput),
                            embeddingApiConfig,
                        );
                    } catch { /* ignore */ }
                }

                let firstSavedId = "";
                for (let i = 0; i < parsedDrafts.length; i++) {
                    const item = parsedDrafts[i];
                    const emb = batchEmbeddings[i] ?? undefined;
                    const iso = new Date(nowMs + i * 10).toISOString();
                    const isReplacingSource = Boolean(source && i === 0);
                    const entryId = isReplacingSource ? source!.id : createManualMemoryId(type);
                    if (i === 0) firstSavedId = entryId;

                    const existingAccessCount = isReplacingSource
                        ? (typeof source?.accessCount === "number"
                            ? source.accessCount
                            : (typeof source?.metadata?.accessCount === "number" ? Number(source.metadata.accessCount) : 0))
                        : 0;

                    const newEntry: MemoryEntry = {
                        id: entryId,
                        characterId: selectedCharId,
                        sourceApp: source?.sourceApp || "chat",
                        type,
                        content: item.cleanContent,
                        embedding: emb,
                        importance: item.normalizedImportance,
                        accessCount: existingAccessCount,
                        createdAt: isReplacingSource ? source!.createdAt : iso,
                        updatedAt: iso,
                        metadata: {
                            ...(isReplacingSource ? (source?.metadata ?? {}) : {}),
                            origin: "user_manual",
                            eventDate: item.eventDate,
                            accessCount: existingAccessCount,
                            keywords: item.finalKeywords,
                            topicSplitV2: true,
                            ...(emb ? { embeddingDim: emb.length } : {}),
                        },
                    };
                    await saveMemoryEntry(newEntry);
                }

                await loadDetailData(selectedCharId);
                setMemoryEditor(null);
                if (firstSavedId) setExpandedId(firstSavedId);
                loadCharacterList();
                showNotice(`已保存 ${parsedDrafts.length} 条${type === "core" ? "核心记忆" : "长期记忆"}`);
            } catch (error) {
                console.error("[MemoryBank] Batch save manual memories failed:", error);
                showNotice("记忆保存失败: " + String(error));
            } finally {
                setSavingMemory(false);
            }
            return;
        }

        const rawContent = memoryEditor.content.trim();
        if (!rawContent) {
            showNotice("记忆内容不能为空");
            return;
        }
        if (rawContent.length > MANUAL_MEMORY_CONTENT_LIMIT) {
            showNotice(`记忆内容过长，请控制在 ${MANUAL_MEMORY_CONTENT_LIMIT} 字以内，或使用「记忆清洗」拆分为多条`);
            return;
        }

        setSavingMemory(true);
        try {
            const now = new Date().toISOString();
            const structuredMeta = extractMemoryStructuredMeta(rawContent);
            const cleanContent = stripMemoryStructuredSections(rawContent) || rawContent;
            const manualKeywords = memoryEditor.keywordsText
                .split(/[、，,；;|/\s]+/)
                .map(s => s.trim())
                .filter(Boolean);
            const finalKeywords = manualKeywords.length > 0 ? manualKeywords : structuredMeta.keywords;
            const normalizedImportance = Math.max(0.1, Math.min(1, Number((memoryEditor.importance / 10).toFixed(2))));

            const detectedDate = structuredMeta.eventDate ?? extractDateFromRawText(rawContent);
            const resolvedEventDate = /^\d{4}-\d{2}-\d{2}$/.test(memoryEditor.eventDate.trim())
                ? (memoryEditor.dateTouched ? memoryEditor.eventDate.trim() : (detectedDate ?? memoryEditor.eventDate.trim()))
                : (detectedDate ?? todayKey);

            const contentChanged = !source || source.content.trim() !== cleanContent || finalKeywords.join(",") !== (Array.isArray(source.metadata?.keywords) ? source.metadata.keywords.join(",") : "");
            const embeddingText = finalKeywords.length > 0
                ? `关键词：${finalKeywords.join("、")}\n${cleanContent}`
                : cleanContent;
            const embedding = type === "long_term"
                ? (contentChanged || !source?.embedding?.length ? await maybeBuildManualMemoryEmbedding(type, embeddingText) : source?.embedding)
                : undefined;
            const existingAccessCount = typeof source?.accessCount === "number"
                ? source.accessCount
                : (typeof source?.metadata?.accessCount === "number" ? Number(source.metadata.accessCount) : 0);

            const entry: MemoryEntry = source
                ? {
                    ...source,
                    content: cleanContent,
                    embedding,
                    importance: normalizedImportance,
                    accessCount: existingAccessCount,
                    updatedAt: now,
                    metadata: {
                        ...(source.metadata ?? {}),
                        eventDate: resolvedEventDate,
                        origin: isManualMemoryEntry(source) ? "user_manual" : "user_edited",
                        editedByUser: true,
                        accessCount: existingAccessCount,
                        keywords: finalKeywords,
                        ...(embedding ? { embeddingDim: embedding.length } : {}),
                    },
                }
                : {
                    id: createManualMemoryId(type),
                    characterId: selectedCharId,
                    sourceApp: "chat",
                    type,
                    content: cleanContent,
                    embedding,
                    importance: normalizedImportance,
                    accessCount: 0,
                    createdAt: now,
                    updatedAt: now,
                    metadata: {
                        origin: "user_manual",
                        eventDate: resolvedEventDate,
                        accessCount: 0,
                        keywords: finalKeywords,
                        ...(embedding ? { embeddingDim: embedding.length } : {}),
                    },
                };

            await saveMemoryEntry(entry);
            if (type === "long_term" && !isEntryBoxDigest(entry)) {
                const desiredBoxId = (memoryEditor.eventBoxId ?? "").trim();
                const prevBoxId = source ? getEntryBoxId(source) : "";
                if (desiredBoxId && desiredBoxId !== prevBoxId) {
                    await moveEntryToBox(entry, desiredBoxId);
                } else if (!desiredBoxId && prevBoxId) {
                    await removeEntryFromBox(entry);
                }
            }
            await loadDetailData(selectedCharId);
            setMemoryEditor(null);
            setExpandedId(entry.id);
            loadCharacterList();
            showNotice(type === "core" ? "核心记忆已保存" : "长期记忆已保存");
        } catch (error) {
            console.error("[MemoryBank] Save manual memory failed:", error);
            showNotice("记忆保存失败: " + String(error));
        } finally {
            setSavingMemory(false);
        }
    };

    const renderMemoryEntries = (type: MemoryEntry["type"], allEntries: MemoryEntry[], emptyText: string) => {
        const label = type === "core" ? "核心记忆" : "长期记忆";
        // 已删除的记忆只在「最近删除」里出现；已移除的角色反思旧条目不再在核心记忆页展示
        const entries = allEntries.filter(e => !isEntryTrashed(e) && e.metadata?.origin !== "character_reflection");
        const missingVectorCount = type === "long_term"
            ? entries.filter(e => !isEntryVectorValid(e)).length
            : 0;
        const legacyUnorganizedCount = type === "long_term"
            ? entries.filter(isLegacyUnorganizedMemory).length
            : 0;
        const legacyFragmentCount = type === "long_term"
            ? entries.filter(isLegacyResplitFragment).length
            : 0;

        // Filter or rank entries when search query is active
        const trimmedQ = searchQuery.trim().toLowerCase();
        let displayEntries = entries;
        if (searchScoreMap) {
            displayEntries = [...entries]
                .filter(e => (searchScoreMap[e.id] ?? 0) > 0)
                .sort((a, b) => (searchScoreMap[b.id] ?? 0) - (searchScoreMap[a.id] ?? 0));
        } else if (trimmedQ) {
            displayEntries = entries.filter(e => {
                const kws = Array.isArray(e.metadata?.keywords)
                    ? (e.metadata.keywords as unknown[]).map(String).join(" ").toLowerCase()
                    : "";
                const dateStr = String(e.metadata?.eventDate ?? e.createdAt.slice(0, 10)).toLowerCase();
                return e.content.toLowerCase().includes(trimmedQ) || kws.includes(trimmedQ) || dateStr.includes(trimmedQ);
            });
        }

        return (
            <>
                {entries.length > 0 && (
                    <>
                        <div className="mem-entry-toolbar mem-toolbar-row">
                            <button
                                className="mem-entry-add-btn"
                                onClick={() => openCreateMemoryEditor(type)}
                            >
                                <Plus size={15} strokeWidth={1.8} />
                                <span>新增{label}</span>
                            </button>
                            {type === "long_term" && legacyUnorganizedCount > 0 && (
                                <button
                                    className="mem-entry-add-btn"
                                    onClick={() => void handleCleanAllLegacyMemories()}
                                    disabled={cleaningAllLegacy || summarizing}
                                    title="整理「格式未归档」的记忆（长文本、正文带日期或缺少检索关键词）：拆分成独立话题、提取事件日期并补齐向量。只处理你自己录入/导入的条目与历史遗留条目，自动总结的记忆不会出现在这里"
                                >
                                    <Sparkles size={14} strokeWidth={1.8} />
                                    <span>
                                        {cleaningAllLegacy
                                            ? `整理中(${cleanLegacyProgress})...`
                                            : `整理旧格式记忆(${legacyUnorganizedCount})`}
                                    </span>
                                </button>
                            )}
                            {type === "long_term" && legacyFragmentCount > 0 && (
                                <button
                                    className="mem-entry-add-btn"
                                    onClick={() => void handleCleanLegacyFragments()}
                                    disabled={cleaningFragments}
                                    title="把此前旧版批量拆分产生的 mem_lt_resplit_ 碎片移入「最近删除」，随时可恢复"
                                >
                                    <Trash2 size={14} strokeWidth={1.8} />
                                    <span>
                                        {cleaningFragments
                                            ? "清理中..."
                                            : `清理旧拆分碎片(${legacyFragmentCount})`}
                                    </span>
                                </button>
                            )}
                            {type === "long_term" && missingVectorCount > 0 && (
                                <button
                                    className="mem-entry-add-btn"
                                    onClick={() => void handleBackfillEmbeddings()}
                                    disabled={embeddingAll}
                                    title="为尚未生成向量或更换模型后维度不匹配的记忆计算 Embedding 向量"
                                >
                                    <Zap size={14} strokeWidth={1.8} />
                                    <span>{embeddingAll ? "向量化中..." : `补全向量(${missingVectorCount})`}</span>
                                </button>
                            )}
                            <button
                                className="mem-entry-clear-btn"
                                onClick={() => setConfirmClearAll(type)}
                                title="把这一类记忆全部移入「最近删除」，随时可以恢复"
                            >
                                <Trash2 size={15} strokeWidth={1.8} />
                                <span>全部移入最近删除</span>
                            </button>
                        </div>

                        <div className="g-card" style={{ padding: "8px 12px", flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <Search size={15} className="text-secondary" style={{ flexShrink: 0 }} />
                            <input
                                type="text"
                                className="ui-input ui-input-inline ts-12"
                                style={{ flex: 1, minWidth: 0 }}
                                placeholder={`搜索${label}关键词、日期，或输入句子测试向量召回...`}
                                value={searchQuery}
                                onChange={e => {
                                    setSearchQuery(e.target.value);
                                    if (searchScoreMap) setSearchScoreMap(null);
                                }}
                                onKeyDown={e => {
                                    if (type === "long_term" && e.key === "Enter" && searchQuery.trim()) {
                                        e.preventDefault();
                                        void handleRunVectorSearchTest();
                                    }
                                }}
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    className="ui-bare-btn text-secondary"
                                    onClick={() => {
                                        setSearchQuery("");
                                        setSearchScoreMap(null);
                                    }}
                                    title="清空搜索"
                                >
                                    <X size={15} />
                                </button>
                            )}
                            {type === "long_term" && searchQuery.trim() && (
                                <button
                                    type="button"
                                    className="ui-chip"
                                    style={{ padding: "4px 10px", fontSize: 11, flexShrink: 0 }}
                                    data-selected={searchScoreMap ? "" : undefined}
                                    disabled={searchingVectors}
                                    onClick={() => void handleRunVectorSearchTest()}
                                >
                                    {searchingVectors ? "计算中..." : searchScoreMap ? "已按相关度排序" : "向量召回测试"}
                                </button>
                            )}
                        </div>
                    </>
                )}
                {entryMenuId && (
                    <button
                        className="mem-entry-menu-backdrop"
                        aria-label="关闭菜单"
                        onClick={() => setEntryMenuId(null)}
                    />
                )}
                {entries.length === 0 ? (
                    <div className="mem-empty-card">
                        <p>{emptyText}</p>
                        <button className="mem-empty-add-btn" onClick={() => openCreateMemoryEditor(type)}>
                            <Plus size={14} />
                            <span>新增{label}</span>
                        </button>
                    </div>
                ) : displayEntries.length === 0 ? (
                    <div className="mem-empty-card">
                        <p>未找到匹配的{label}</p>
                    </div>
                ) : (
                    displayEntries.map(entry => {
                        const parsedMeta = extractMemoryStructuredMeta(entry.content);
                        const keywords = Array.isArray(entry.metadata?.keywords) && (entry.metadata.keywords as unknown[]).length > 0
                            ? (entry.metadata.keywords as unknown[]).map(String)
                            : parsedMeta.keywords;
                        const accessCount = typeof entry.accessCount === "number"
                            ? entry.accessCount
                            : (typeof entry.metadata?.accessCount === "number" ? Number(entry.metadata.accessCount) : 0);
                        const importanceVal = Number.isFinite(entry.importance) ? entry.importance : (parsedMeta.importance ?? 0.8);
                        const importanceScore = Math.max(1, Math.min(10, Math.round(importanceVal * 10)));
                        const rawHasVector = Array.isArray(entry.embedding) && entry.embedding.length > 0;
                        const vectorValid = isEntryVectorValid(entry);
                        const dimMismatch = rawHasVector && !vectorValid;
                        const matchScore = searchScoreMap ? searchScoreMap[entry.id] : undefined;
                        const isExpanded = expandedId === entry.id;
                        const cleanBody = stripMemoryStructuredSections(entry.content) || entry.content;
                        const displayMarkdown = isExpanded || cleanBody.length <= 180
                            ? cleanBody
                            : cleanBody.slice(0, 180) + "...";
                        // 被后来的记忆改写过：把被改掉的字句划掉显示，其余部分照旧
                        const supersededSpans = readSupersededSpans(entry);
                        const isSuperseded = isEntrySuperseded(entry);
                        const revisionRatioRaw = entry.metadata?.[REVISION_META_KEYS.ratio];
                        const revisionRatio = typeof revisionRatioRaw === "number" ? revisionRatioRaw : undefined;
                        const revisionWeight = getRevisionWeight(entry);
                        const revisionSourceId = typeof entry.metadata?.[REVISION_META_KEYS.by] === "string"
                            ? String(entry.metadata[REVISION_META_KEYS.by])
                            : "";
                        const hasRevisionSource = revisionSourceId
                            ? entries.some(item => item.id === revisionSourceId)
                            : false;

                        const entryIsDigest = isEntryBoxDigest(entry);
                        const entryBoxId = getEntryBoxId(entry) || (entryIsDigest ? String(entry.metadata?.eventBoxDigestOf ?? "") : "");
                        const boxOfEntry = entryBoxId ? boxes.find(b => b.id === entryBoxId) : undefined;
                        const entryArchived = isEntryArchived(entry);

                        return (
                            <div
                                key={entry.id}
                                id={`mem-entry-card-${entry.id}`}
                                className={`g-card memory-report-card${entryMenuId === entry.id ? " is-menu-open" : ""}${flashTargetId === entry.id ? " mem-jump-flash" : ""}`}
                                onClick={() => {
                                    if (entryMenuId) {
                                        setEntryMenuId(null);
                                        return;
                                    }
                                    setExpandedId(isExpanded ? null : entry.id);
                                }}
                            >
                                <div className="mem-report-head">
                                    <span
                                        className="ts-11 text-secondary"
                                        style={{
                                            letterSpacing: "0.5px",
                                            display: "flex",
                                            flexDirection: "column",
                                            alignItems: "flex-start",
                                            gap: 1,
                                            textAlign: "left",
                                            lineHeight: 1.5,
                                        }}
                                    >
                                        {formatEntryDateLines(entry).map((line, lineIdx) => (
                                            <span key={lineIdx}>{line}</span>
                                        ))}
                                    </span>
                                    <div className="mem-report-actions">
                                        {typeof matchScore === "number" && (
                                            <span className="mem-stat-pill is-vector-ok" style={{ fontWeight: 700, borderRadius: 5 }}>
                                                匹配度 {Math.round(Math.min(1, matchScore) * 100)}%
                                            </span>
                                        )}
                                        {entryIsDigest && (
                                            <span
                                                className="mem-stat-pill"
                                                style={{ fontWeight: 700, borderRadius: 5 }}
                                                title="事件盒手动总结生成的阶段性总结"
                                            >
                                                事件盒总结
                                            </span>
                                        )}
                                        {entryArchived && (
                                            <span
                                                className="mem-stat-pill"
                                                style={{ fontWeight: 700, borderRadius: 5 }}
                                                title="已在事件盒中总结归档"
                                            >
                                                已归档
                                            </span>
                                        )}
                                        <span
                                            className={`mem-origin-badge ${isManualMemoryEntry(entry) ? "is-manual" : ""}`}
                                            style={{ borderRadius: 5 }}
                                        >
                                            {isManualMemoryEntry(entry) ? "MANUAL" : "AUTO"}
                                        </span>
                                        <div className="mem-entry-menu-wrap">
                                            <button
                                                className="mem-entry-menu-btn"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    setEntryMenuId(prev => prev === entry.id ? null : entry.id);
                                                }}
                                                title="更多"
                                            >
                                                <MoreHorizontal size={18} />
                                            </button>
                                            {entryMenuId === entry.id && (
                                                <div className="mem-entry-menu" onClick={event => event.stopPropagation()}>
                                                    <button onClick={() => openEditMemoryEditor(entry)}>
                                                        <Edit3 size={13} />
                                                        <span>编辑</span>
                                                    </button>
                                                    {!entryIsDigest && (
                                                        <button
                                                            onClick={() => {
                                                                setEntryMenuId(null);
                                                                setResummarizeDialog({
                                                                    entry,
                                                                    instruction: "",
                                                                    isCore: type === "core",
                                                                });
                                                            }}
                                                            disabled={Boolean(resplittingEntryId)}
                                                            title={type === "core"
                                                                ? "回到这条核心记忆所依据的长期记忆与原始对话记录重新提炼，可先写下你希望模型修正的思路（追溯不到依据时会拒绝执行，绝不对着旧结论二次编造）"
                                                                : "回到这条记忆对应的原始对话/事件记录重新总结，可先写下你希望模型修正的思路（没有原文记录时会拒绝执行，绝不对着旧总结二次编造）"}
                                                        >
                                                            <RotateCw size={13} />
                                                            <span>
                                                                {resplittingEntryId === entry.id ? "重新总结中..." : "重新总结"}
                                                            </span>
                                                        </button>
                                                    )}

                                                    {/* 清洗按钮只在「确实需要整理」的条目上出现：
                                                        自动总结产出、格式已规范、已在事件盒里的条目都没有清洗的意义，
                                                        菜单里直接不给这个入口，免得看着像是「每条都得点一下」。 */}
                                                    {type === "long_term" && !entryIsDigest && isLegacyUnorganizedMemory(entry) && (
                                                        <button
                                                            onClick={() => void handleCleanSingleLegacyEntry(entry)}
                                                            disabled={Boolean(cleaningLegacyEntryId) || cleaningAllLegacy}
                                                            title="这条记忆的格式还没归档（长文本/多段落/带日期/缺检索关键词），可以拆条整理"
                                                        >
                                                            <Sparkles size={13} />
                                                            <span>{cleaningLegacyEntryId === entry.id ? "清洗中..." : "清洗格式"}</span>
                                                        </button>
                                                    )}
                                                    {/* 只有一个删除入口：先移进「最近删除」，真删在回收站里做。
                                                        不做「弃用」和「删除」两个按钮——两个都是删，没人愿意点两次才放心。 */}
                                                    <button
                                                        className="is-danger"
                                                        onClick={() => void handleTrashEntry(entry)}
                                                    >
                                                        <Trash2 size={13} />
                                                        <span>删除</span>
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                <div className="ts-12 leading-[1.7] mem-markdown-body chat-markdown">
                                    {supersededSpans.length > 0 ? (
                                        // 被后来的记忆改写过：划掉改动的字句，其余照常显示。
                                        // 这段不能用 Markdown 渲染——删除线要精确到字，交给纯文本切片。
                                        <span className="mem-superseded-body">
                                            {sliceSupersededText(displayMarkdown, clipSupersededSpans(displayMarkdown, supersededSpans)).map((piece, pieceIdx) =>
                                                piece.superseded ? (
                                                    <del key={pieceIdx} className="mem-superseded-text" title="这段已被后来的记忆改写">{piece.text}</del>
                                                ) : (
                                                    <span key={pieceIdx}>{piece.text}</span>
                                                ),
                                            )}
                                        </span>
                                    ) : (
                                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                                            {displayMarkdown}
                                        </ReactMarkdown>
                                    )}
                                </div>
                                {isSuperseded && (
                                    <div className="mem-superseded-note">
                                        <span>
                                            {entry.metadata?.origin === "core_summary"
                                                ? "已被新一轮核心记忆总结演进接替（仅保留作历史记录）"
                                                : "已被后来的记忆更正"}
                                            {typeof revisionRatio === "number" && revisionRatio > 0
                                                ? ` · 改动约 ${Math.round(revisionRatio * 100)}%`
                                                : ""}
                                            {entry.metadata?.origin !== "core_summary" && revisionWeight < 1
                                                ? ` · 检索权重 ${Math.round(revisionWeight * 100)}%`
                                                : ""}
                                        </span>
                                        {hasRevisionSource && (
                                            <button
                                                type="button"
                                                className="mem-superseded-jump"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    if (searchQuery) setSearchQuery("");
                                                    if (searchScoreMap) setSearchScoreMap(null);
                                                    setExpandedId(revisionSourceId);
                                                    scrollToAndFlash(`mem-entry-card-${revisionSourceId}`, revisionSourceId);
                                                }}
                                            >
                                                {entry.metadata?.origin === "core_summary"
                                                    ? "查看最新总结"
                                                    : "查看新版本"}
                                            </button>
                                        )}
                                    </div>
                                )}
                                {boxOfEntry && (
                                    <div className="mem-superseded-note">
                                        <span>关联事件盒：{boxOfEntry.title}</span>
                                        <button
                                            type="button"
                                            className="mem-superseded-jump"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                setActiveBoxId(boxOfEntry.id);
                                                setActiveTab("boxes");
                                                const targetDomId = entryIsDigest
                                                    ? `mem-box-card-${boxOfEntry.id}`
                                                    : `mem-box-item-${entry.id}`;
                                                const highlightKey = entryIsDigest ? boxOfEntry.id : entry.id;
                                                scrollToAndFlash(targetDomId, highlightKey);
                                            }}
                                        >
                                            展开关联事件
                                        </button>
                                    </div>
                                )}
                                <div className="mem-structured-footer">
                                    <div
                                        className="mem-stats-row"
                                        style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 10 }}
                                    >
                                        {/* 重要性、访问次数都在最左侧并排，向量化状态单独靠最右 */}
                                        <span className="mem-stat-pill" style={{ background: "transparent", border: "none", padding: 0 }}>
                                            重要性 <strong>{importanceScore}/10</strong>
                                        </span>
                                        <span className="mem-stat-pill" style={{ background: "transparent", border: "none", padding: 0 }}>
                                            访问 <strong>{accessCount}</strong> 次
                                        </span>
                                        {type === "long_term" && (
                                            <span
                                                className={`mem-stat-pill ${vectorValid ? "is-vector-ok" : "is-vector-missing"}`}
                                                style={{ marginLeft: "auto", background: "transparent", border: "none", padding: 0 }}
                                            >
                                                {vectorValid
                                                    ? `● 已向量化(${entry.embedding!.length}d)`
                                                    : dimMismatch
                                                        ? "◐ 维度不符(可重算)"
                                                        : "○ 未向量化"}
                                            </span>
                                        )}
                                    </div>
                                    {keywords.length > 0 && (
                                        <div className="mem-keywords-row">
                                            {keywords.map((kw, idx) => (
                                                <span key={idx} className="mem-keyword-chip" style={{ borderRadius: 5 }}>{kw}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                {/* 核心记忆的原文溯源：这条结论依据的长期记忆 + 它们的原始对话记录 */}
                                {isExpanded && type === "core" && (
                                    <div className="mem-superseded-note" style={{ display: "block" }} onClick={ev => ev.stopPropagation()}>
                                        <div className="ts-11 text-secondary" style={{ fontWeight: 600, marginBottom: 4 }}>
                                            原文溯源{coreProvenance
                                                ? `（依据 ${coreProvenance.totalLongTerm} 条长期记忆 · ${coreProvenance.earliest} ~ ${coreProvenance.latest}）`
                                                : ""}
                                        </div>
                                        {coreProvenanceLoading ? (
                                            <div className="ts-11 text-secondary">正在追溯…</div>
                                        ) : !coreProvenance || coreProvenance.longTermEntries.length === 0 ? (
                                            <div className="ts-11 text-secondary">
                                                追溯不到这条核心记忆所依据的长期记忆（可能已被删除），因此无法对这条执行「重新总结」。
                                            </div>
                                        ) : (
                                            <>
                                                <div className="ts-11 text-secondary" style={{ marginBottom: 2 }}>
                                                    依据的长期记忆（{coreProvenance.longTermEntries.length} 条）：
                                                </div>
                                                <div style={{ maxHeight: 180, overflowY: "auto" }}>
                                                    {coreProvenance.longTermEntries.slice(-30).map(item => (
                                                        <div key={item.id} className="ts-11" style={{ padding: "3px 0", borderTop: "1px solid rgba(128,128,128,.15)" }}>
                                                            <span className="text-secondary" style={{ marginRight: 6 }}>
                                                                [{String(item.metadata?.eventDate ?? item.createdAt.slice(0, 10))}]
                                                            </span>
                                                            <span style={{ opacity: 0.85 }}>
                                                                {(stripMemoryStructuredSections(item.content) || item.content).slice(0, 90)}
                                                                {(stripMemoryStructuredSections(item.content) || item.content).length > 90 ? "…" : ""}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                                <div className="ts-11 text-secondary" style={{ marginTop: 6, marginBottom: 2 }}>
                                                    原始对话/事件记录（{coreProvenance.rawEntries.length} 条）：
                                                </div>
                                                {coreProvenance.rawEntries.length === 0 ? (
                                                    <div className="ts-11 text-secondary">这批长期记忆已无对应的原始记录，只能依据上面的长期记忆正文。</div>
                                                ) : (
                                                    <div style={{ maxHeight: 220, overflowY: "auto" }}>
                                                        {coreProvenance.rawEntries.map((item, idx) => (
                                                            <div key={`${item.id}_${idx}`} className="ts-11" style={{ padding: "3px 0", borderTop: "1px solid rgba(128,128,128,.15)" }}>
                                                                <span className="text-secondary" style={{ marginRight: 6 }}>[{item.sourceApp}]</span>
                                                                <span style={{ whiteSpace: "pre-wrap", opacity: 0.85 }}>{item.content}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                )}
                                {/* 长期记忆的原文溯源：仅在展开时渲染，同时兼容批次快照与手机原生历史时间线回溯 */}
                                {isExpanded && type === "long_term" && !entryIsDigest && (() => {
                                    const provenance = resolveMemoryProvenance(selectedCharId!, entry);
                                    if (!provenance || provenance.entries.length === 0) {
                                        return (
                                            <div className="mem-superseded-note" style={{ display: "block" }} onClick={ev => ev.stopPropagation()}>
                                                <div className="ts-11 text-secondary">
                                                    原文溯源：未找到该日期对应的原始对话或事件记录（聊天记录可能已清理，无法执行重新总结）。
                                                </div>
                                            </div>
                                        );
                                    }
                                    return (
                                        <div className="mem-superseded-note" style={{ display: "block" }} onClick={ev => ev.stopPropagation()}>
                                            <div className="ts-11 text-secondary" style={{ fontWeight: 600, marginBottom: 4 }}>
                                                原文溯源（共 {provenance.totalEntries} 条原始记录 · {provenance.dayKey}）
                                                {provenance.entries.length < provenance.totalEntries
                                                    ? ` · 展示最近 ${provenance.entries.length} 条`
                                                    : ""}
                                            </div>
                                            <div style={{ maxHeight: 260, overflowY: "auto" }}>
                                                {provenance.entries.map((item, idx) => (
                                                    <div
                                                        key={`${item.id}_${idx}`}
                                                        className="ts-11"
                                                        style={{ padding: "3px 0", borderTop: "1px solid rgba(128,128,128,.15)" }}
                                                    >
                                                        <span className="text-secondary" style={{ marginRight: 6 }}>[{item.sourceApp}]</span>
                                                        <span style={{ whiteSpace: "pre-wrap", opacity: 0.85 }}>{item.content}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        );
                    })
                )}
            </>
        );
    };

    /**
     * 最近删除页：按当前角色隔离，分「已删除」和「被角色修改过」两摞。
     * - 已删除：不再注入 Prompt，可恢复；只有在这里点「彻底删除」才真正 drop，
     *   且删除满 60 天后会自动清理（见 memory-trash 的 purgeExpiredTrashed）。
     * - 被角色修改过：新内容在生效，但保留了修改前快照，可一键还原创。
     */
    const renderTrashTab = () => {
        const bucket = buildTrashBucket([...coreEntries, ...longTermEntries]);
        const { trashed, edited } = bucket;
        const total = trashed.length + edited.length;

        const renderCard = (entry: MemoryEntry, mode: "trashed" | "edited") => {
            const body = (stripMemoryStructuredSections(entry.content) || entry.content).trim();
            const snapshot = mode === "edited" ? readEditSnapshot(entry) : null;
            const actor = readTrashActor(entry);
            const reason = readTrashReason(entry);
            const trashedAt = readTrashedAt(entry);
            // 距自动清理还剩几天（到期会由 loadDetailData 里的清理逻辑真正删掉）
            const remainingDays = mode === "trashed" ? readTrashRemainingDays(entry) : null;
            const typeLabel = entry.type === "core" ? "核心记忆" : "长期记忆";
            // 拆分关系：原条目记着拆成了哪几条，碎片记着从哪条拆出来
            const resplitIntoCount = Array.isArray(entry.metadata?.resplitInto)
                ? (entry.metadata.resplitInto as unknown[]).length
                : 0;
            const resplitFromId = String(entry.metadata?.resplitFrom ?? "");
            const resplitDetached = Boolean(entry.metadata?.resplitDetachedBy);
            const isExpanded = expandedId === entry.id;
            const displayBody = isExpanded || body.length <= 180 ? body : body.slice(0, 180) + "...";
            return (
                <div key={entry.id} className="g-card memory-report-card">
                    <div className="mem-report-head">
                        <span
                            className="ts-11 text-secondary"
                            style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, lineHeight: 1.5 }}
                        >
                            <span>{typeLabel} · {formatEntryDateLines(entry)[0]}</span>
                            <span>
                                {mode === "trashed"
                                    ? `删除于 ${trashedAt ? formatIsoTimestamp(trashedAt) : "未知时间"} · ${actor === "character" ? "角色" : "用户"}删除`
                                    : `角色改于 ${formatIsoTimestamp(entry.updatedAt)}`}
                                {mode === "trashed" && remainingDays !== null
                                    ? remainingDays > 0
                                        ? ` · 剩 ${remainingDays} 天自动清理`
                                        : " · 即将自动清理"
                                    : ""}
                            </span>
                        </span>
                        <div className="mem-report-actions">
                            <span className="mem-stat-pill" style={{ fontWeight: 700, borderRadius: 5 }}>
                                {mode === "trashed" ? `已删除（${TRASH_RETENTION_DAYS}天内可恢复）` : "角色改过"}
                            </span>
                        </div>
                    </div>
                    {reason && (
                        <div className="ts-11 text-secondary" style={{ padding: "2px 0" }}>
                            理由：{reason}
                        </div>
                    )}
                    {(resplitIntoCount > 0 || resplitFromId || resplitDetached) && (
                        <div className="ts-11 text-secondary" style={{ padding: "2px 0" }}>
                            {resplitIntoCount > 0
                                ? `这条记忆曾派生出 ${resplitIntoCount} 条新总结：点「恢复」会自动撤掉那些新条目，干净回到替换前的原貌。`
                                : "由重总结或拆分产生：恢复原记忆时它会被自动撤掉；单独恢复会与原记忆重复，一般不必恢复。"}
                        </div>
                    )}
                    <div
                        className="ts-13 leading-[1.7]"
                        style={{ cursor: "pointer", whiteSpace: "pre-wrap" }}
                        onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    >
                        {displayBody}
                    </div>
                    {snapshot && (
                        <div className="mem-superseded-note" style={{ display: "block" }}>
                            <div className="ts-11 text-secondary" style={{ fontWeight: 600, marginBottom: 2 }}>
                                修改前的原文（可还原）
                            </div>
                            <div className="ts-12" style={{ whiteSpace: "pre-wrap", opacity: 0.85 }}>
                                {snapshot.content}
                            </div>
                        </div>
                    )}
                    <div className="mem-structured-footer">
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {mode === "trashed" ? (
                                <>
                                    <button
                                        type="button"
                                        className="mem-superseded-jump"
                                        onClick={() => void handleRestoreTrashed(entry)}
                                    >
                                        恢复
                                    </button>
                                    <button
                                        type="button"
                                        className="mem-superseded-jump"
                                        style={{ color: "var(--c-danger, #e5484d)" }}
                                        onClick={() => setConfirmPurgeEntry(entry)}
                                    >
                                        彻底删除
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        className="mem-superseded-jump"
                                        onClick={() => void handleRevertCharacterEdit(entry)}
                                    >
                                        还原到修改前
                                    </button>
                                    <button
                                        type="button"
                                        className="mem-superseded-jump"
                                        onClick={() => void handleTrashEntry(entry)}
                                    >
                                        删除这条
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            );
        };

        return (
            <>
                {total === 0 ? (
                    <div className="mem-empty-card">
                        <p>
                            最近删除是空的。角色或你删掉的记忆会先放在这里，可以随时恢复；
                            在这里点「彻底删除」才是真的删掉，超过 {TRASH_RETENTION_DAYS} 天的条目会自动清理。
                        </p>
                    </div>
                ) : (
                    <>
                        <div className="mem-entry-toolbar mem-toolbar-row">
                            {trashed.length > 0 && (
                                <>
                                    <button
                                        className="mem-entry-add-btn"
                                        onClick={() => void handleRestoreAllTrashed(trashed)}
                                    >
                                        <RotateCcw size={15} strokeWidth={1.8} />
                                        <span>全部恢复({trashed.length})</span>
                                    </button>
                                    <button
                                        className="mem-entry-clear-btn"
                                        onClick={() => setConfirmEmptyTrash(true)}
                                    >
                                        <Trash2 size={15} strokeWidth={1.8} />
                                        <span>清空回收站({trashed.length})</span>
                                    </button>
                                </>
                            )}
                        </div>
                        {trashed.length > 0 && (
                            <>
                                <p className="menu-group-desc mx-2">
                                    已删除（不再参与记忆注入，{trashed.length} 条；删除满 {TRASH_RETENTION_DAYS} 天自动清理）
                                </p>
                                {trashed.map(entry => renderCard(entry, "trashed"))}
                            </>
                        )}
                        {edited.length > 0 && (
                            <>
                                <p className="menu-group-desc mx-2">被角色修改过（新内容仍在生效，{edited.length} 条）</p>
                                {edited.map(entry => renderCard(entry, "edited"))}
                            </>
                        )}
                    </>
                )}
            </>
        );
    };


    // ── Detail View ──
    if (view === "detail" && selectedChar) {
        return (
            <div className="flex flex-col absolute inset-0 overflow-hidden" style={{ padding: "0 16px" }}>
                {/* Content */}
                <div className="memory-detail-scroll flex-1 overflow-y-auto flex flex-col gap-2 min-h-0">
                    <MemoryDetailBoundary>
                    {loading ? (
                        <p className="text-center ts-14 mt-10 text-secondary">
                            加载中...
                        </p>
                    ) : activeTab === "short" ? (
                        /* ── Short-term: card view ── */
                        <>
                            <MemoryTimeline
                                events={shortTermEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                            />
                        </>
                    ) : activeTab === "shared" ? (
                        /* ── Shared events: card view ── */
                        sharedEvents.length === 0 ? (
                            <p className="text-center ts-14 mt-10 text-secondary">
                                暂无共享事件。用户发朋友圈或参与群聊后会自动显示。
                            </p>
                        ) : (
                            <MemoryTimeline
                                events={sharedEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                            />
                        )
                    ) : activeTab === "boxes" ? (
                        /* 事件盒页面已删除：原来放进盒子的记忆都在「长期记忆」里，照常查看与召回 */
                        null
                    ) : (activeTab as string) === "__event_box_disabled__" ? (
                        /* 旧事件盒界面保留为不可达分支，仅作存档，等待后续整体删除 */
                        (() => {
                            const ungroupedCount = longTermEntries.filter(e => !isEntryTrashed(e) && !getEntryBoxId(e) && !isEntryBoxDigest(e)).length;
                            const pendingSummarizeBoxCount = boxes.filter(b => {
                                const { digestEntry, newEntries, allMemberEntries } = getBoxLayers(longTermEntries, b);
                                return newEntries.length > 0 || (!digestEntry && allMemberEntries.length > 0);
                            }).length;
                            return (
                                <>
                                    {entryMenuId && (
                                        <button
                                            className="mem-entry-menu-backdrop"
                                            aria-label="关闭菜单"
                                            onClick={() => setEntryMenuId(null)}
                                        />
                                    )}
                                    {boxes.length > 0 && (
                                        <div className="mem-entry-toolbar mem-toolbar-row">
                                            <button
                                                className="mem-entry-add-btn"
                                                onClick={() => setBoxDialog({ title: "", importance: 8, keywordsText: "" })}
                                            >
                                                <Plus size={15} strokeWidth={1.8} />
                                                <span>新建事件盒</span>
                                            </button>
                                            {ungroupedCount >= 2 && (
                                                <button
                                                    className="mem-entry-add-btn"
                                                    onClick={() => void handleRunSmartBoxSuggest()}
                                                    disabled={smartBusy || batchBoxSummarizing}
                                                    title="识别同一件事的相关记忆并推荐放入事件盒"
                                                >
                                                    <Sparkles size={14} strokeWidth={1.8} />
                                                    <span>{smartBusy ? "识别中..." : `智能关联记忆(${ungroupedCount})`}</span>
                                                </button>
                                            )}
                                            {pendingSummarizeBoxCount > 0 && (
                                                <button
                                                    className="mem-entry-add-btn"
                                                    onClick={() => void handleBatchSummarizeBoxes()}
                                                    disabled={batchBoxSummarizing || boxSummarizing}
                                                    title="一键批量总结所有包含新事件的事件盒并自动向量化"
                                                >
                                                    <Zap size={14} strokeWidth={1.8} />
                                                    <span>
                                                        {batchBoxSummarizing
                                                            ? `批量总结中(${batchBoxProgress})...`
                                                            : `批量总结(${pendingSummarizeBoxCount})`}
                                                    </span>
                                                </button>
                                            )}
                                        </div>
                                    )}

                                    {boxes.length === 0 ? (
                                        <div className="mem-empty-card">
                                            <p>暂无事件盒。将围绕同一件事的记忆关联到一起，点击卡片即可展开关联事件并总结。</p>
                                            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                                                <button
                                                    className="mem-empty-add-btn"
                                                    onClick={() => setBoxDialog({ title: "", importance: 8, keywordsText: "" })}
                                                >
                                                    <Plus size={14} />
                                                    <span>新建事件盒</span>
                                                </button>
                                                {ungroupedCount >= 2 && (
                                                    <button
                                                        className="mem-empty-add-btn"
                                                        disabled={smartBusy}
                                                        onClick={() => void handleRunSmartBoxSuggest()}
                                                    >
                                                        <Sparkles size={14} />
                                                        <span>{smartBusy ? "识别中..." : `智能关联(${ungroupedCount})`}</span>
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        boxes.map(box => {
                                            const { digestEntry, newEntries, archivedEntries, allMemberEntries } = getBoxLayers(longTermEntries, box);
                                            const isBoxOpen = activeBoxId === box.id;
                                            const menuKey = `box_menu_${box.id}`;
                                            const digestClean = digestEntry
                                                ? (stripMemoryStructuredSections(digestEntry.content) || digestEntry.content).trim()
                                                : "";
                                            const boxKeywords = (box.keywords && box.keywords.length > 0)
                                                ? box.keywords
                                                : (digestEntry && Array.isArray(digestEntry.metadata?.keywords)
                                                    ? (digestEntry.metadata.keywords as unknown[]).map(String)
                                                    : []);
                                            const boxSpan = formatBoxSpan(allMemberEntries);
                                            const maxMemberImp = allMemberEntries.reduce(
                                                (m, e) => Math.max(m, Number.isFinite(e.importance) ? e.importance : 0.8),
                                                0.8,
                                            );
                                            const rawBoxImp = digestEntry && Number.isFinite(digestEntry.importance)
                                                ? digestEntry.importance
                                                : (typeof box.importance === "number" && Number.isFinite(box.importance) ? box.importance : maxMemberImp);
                                            const boxImportanceScore = Math.max(1, Math.min(10, Math.round(rawBoxImp * 10)));
                                            const boxAccessCount = digestEntry
                                                ? (typeof digestEntry.accessCount === "number"
                                                    ? digestEntry.accessCount
                                                    : (typeof digestEntry.metadata?.accessCount === "number" ? Number(digestEntry.metadata.accessCount) : 0))
                                                : allMemberEntries.reduce((sum, e) => {
                                                    const c = typeof e.accessCount === "number"
                                                        ? e.accessCount
                                                        : (typeof e.metadata?.accessCount === "number" ? Number(e.metadata.accessCount) : 0);
                                                    return sum + c;
                                                }, 0);

                                            return (
                                                <div
                                                    key={box.id}
                                                    id={`mem-box-card-${box.id}`}
                                                    className={`g-card memory-report-card${entryMenuId === menuKey ? " is-menu-open" : ""}${flashTargetId === box.id ? " mem-jump-flash" : ""}`}
                                                    onClick={() => {
                                                        if (entryMenuId) {
                                                            setEntryMenuId(null);
                                                            return;
                                                        }
                                                        setActiveBoxId(isBoxOpen ? null : box.id);
                                                    }}
                                                >
                                                    {/* 头部（位于虚线分割线之上）：左侧为标题 + 紧跟其下的日期信息，右侧为操作菜单 */}
                                                    <div className="mem-report-head" style={{ alignItems: "flex-start" }}>
                                                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, minWidth: 0, flex: 1 }}>
                                                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                                                <span className="ts-13 font-bold" style={{ color: "var(--c-text)" }}>
                                                                    {box.title}
                                                                </span>
                                                                {newEntries.length > 0 && (
                                                                    <span
                                                                        className="mem-stat-pill"
                                                                        style={{ fontWeight: 700, borderRadius: 5 }}
                                                                        title="盒内有尚未并入总结的新事件"
                                                                    >
                                                                        +{newEntries.length} 条新事件
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="ts-11 text-secondary" style={{ letterSpacing: "0.4px", textAlign: "left", lineHeight: 1.4 }}>
                                                                {boxSpan ? `事件跨度: ${boxSpan} · ` : ""}最近更新：{formatIsoTimestamp(box.updatedAt)}
                                                            </div>
                                                        </div>
                                                        <div className="mem-report-actions">
                                                            <div className="mem-entry-menu-wrap">
                                                                <button
                                                                    className="mem-entry-menu-btn"
                                                                    onClick={ev => {
                                                                        ev.stopPropagation();
                                                                        setEntryMenuId(prev => prev === menuKey ? null : menuKey);
                                                                    }}
                                                                    title="更多"
                                                                >
                                                                    <MoreHorizontal size={18} />
                                                                </button>
                                                                {entryMenuId === menuKey && (
                                                                    <div className="mem-entry-menu" onClick={ev => ev.stopPropagation()}>
                                                                        <button
                                                                            disabled={boxSummarizing || batchBoxSummarizing || allMemberEntries.length === 0}
                                                                            onClick={() => {
                                                                                setEntryMenuId(null);
                                                                                void handleManualSummarizeBox(box.id);
                                                                            }}
                                                                        >
                                                                            <Sparkles size={13} />
                                                                            <span>{boxSummarizing ? "总结中..." : "总结"}</span>
                                                                        </button>
                                                                        <button
                                                                            onClick={() => {
                                                                                setEntryMenuId(null);
                                                                                setBoxDialog({
                                                                                    boxId: box.id,
                                                                                    title: box.title,
                                                                                    importance: boxImportanceScore,
                                                                                    keywordsText: boxKeywords.join("、"),
                                                                                    summaryText: digestClean,
                                                                                });
                                                                            }}
                                                                        >
                                                                            <Edit3 size={13} />
                                                                            <span>编辑</span>
                                                                        </button>
                                                                        <button
                                                                            className="is-danger"
                                                                            onClick={() => {
                                                                                setEntryMenuId(null);
                                                                                setBoxConfirm({ kind: "delete", boxId: box.id });
                                                                            }}
                                                                        >
                                                                            <Trash2 size={13} />
                                                                            <span>删除</span>
                                                                        </button>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* 第三行：总结正文内容（没有就不显示） */}
                                                    {digestClean && (
                                                        <div className="ts-12 leading-[1.7] mem-markdown-body chat-markdown">
                                                            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                                                                {digestClean}
                                                            </ReactMarkdown>
                                                        </div>
                                                    )}

                                                    {/* 第四行：重要性 + 访问次数 + 罗列检索关键词 */}
                                                    <div className="mem-structured-footer">
                                                        <div
                                                            className="mem-stats-row"
                                                            style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 10 }}
                                                        >
                                                            <span className="mem-stat-pill" style={{ background: "transparent", border: "none", padding: 0 }}>
                                                                重要性 <strong>{boxImportanceScore}/10</strong>
                                                            </span>
                                                            <span className="mem-stat-pill" style={{ background: "transparent", border: "none", padding: 0 }}>
                                                                访问 <strong>{boxAccessCount}</strong> 次
                                                            </span>
                                                        </div>
                                                        {boxKeywords.length > 0 && (
                                                            <div className="mem-keywords-row">
                                                                {boxKeywords.map((kw, idx) => (
                                                                    <span key={idx} className="mem-keyword-chip" style={{ borderRadius: 5 }}>{kw}</span>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>

                                                    {/* 第五行：点击展开/收起 {{条数}} 条关联事件（使用 ChevronRight ">" SVG 图标） */}
                                                    <div className="mem-structured-footer" style={{ paddingTop: 2 }}>
                                                        <div className="mem-stats-row" style={{ display: "flex", alignItems: "center", justifyContent: "flex-start" }}>
                                                            <span
                                                                className="mem-stat-pill"
                                                                style={{
                                                                    background: "transparent",
                                                                    border: "none",
                                                                    padding: 0,
                                                                    display: "inline-flex",
                                                                    alignItems: "center",
                                                                    gap: 4,
                                                                }}
                                                            >
                                                                <ChevronRight
                                                                    size={13}
                                                                    style={{
                                                                        transform: isBoxOpen ? "rotate(90deg)" : "none",
                                                                        transition: "transform 0.15s ease",
                                                                    }}
                                                                />
                                                                <span>
                                                                    {isBoxOpen ? "点击收起关联事件" : `点击展开 ${allMemberEntries.length} 条关联事件`}
                                                                </span>
                                                            </span>
                                                        </div>
                                                    </div>

                                                    {/* 展开折叠区：近期事件（深色在前，行尾带「+ 添加事件」）+ 已归档事件（浅色在后） */}
                                                    {isBoxOpen && (
                                                        <div className="mem-box-drawer" onClick={ev => ev.stopPropagation()}>
                                                            {/* 近期事件（深色）：标题在最左，「+ 添加事件」钉在同一行最右 */}
                                                            <div className="mem-box-layer-label" style={{ color: "var(--c-text)", fontWeight: 600 }}>
                                                                <span>近期事件（{newEntries.length}）</span>
                                                                <button
                                                                    type="button"
                                                                    className="mem-superseded-jump"
                                                                    style={{ marginLeft: "auto", flexShrink: 0, textDecoration: "none" }}
                                                                    onClick={() => {
                                                                        setBoxAddSelectedIds({});
                                                                        setBoxAddPickerOpen(true);
                                                                    }}
                                                                >
                                                                    + 添加事件
                                                                </button>
                                                            </div>
                                                            {newEntries.length > 0 ? (
                                                                <div className="mem-box-chain-list">
                                                                    {newEntries.map(item => {
                                                                        const itemBody = stripMemoryStructuredSections(item.content) || item.content;
                                                                        const itemDate = formatEntryDateLines(item)[0];
                                                                        return (
                                                                            <div
                                                                                key={item.id}
                                                                                id={`mem-box-item-${item.id}`}
                                                                                className={`mem-box-chain-item${flashTargetId === item.id ? " mem-jump-flash" : ""}`}
                                                                            >
                                                                                <div className="mem-box-chain-head">
                                                                                    <span>{itemDate}</span>
                                                                                    <div style={{ display: "flex", gap: 8 }}>
                                                                                        <button
                                                                                            type="button"
                                                                                            className="mem-superseded-jump"
                                                                                            onClick={() => {
                                                                                                if (searchQuery) setSearchQuery("");
                                                                                                if (searchScoreMap) setSearchScoreMap(null);
                                                                                                setActiveTab("long");
                                                                                                setExpandedId(item.id);
                                                                                                scrollToAndFlash(`mem-entry-card-${item.id}`, item.id);
                                                                                            }}
                                                                                        >
                                                                                            原条目
                                                                                        </button>
                                                                                        <button
                                                                                            type="button"
                                                                                            className="mem-superseded-jump"
                                                                                            onClick={() => openEditMemoryEditor(item)}
                                                                                        >
                                                                                            编辑
                                                                                        </button>
                                                                                        <button
                                                                                            type="button"
                                                                                            className="mem-superseded-jump"
                                                                                            onClick={() => void handleRemoveEntryFromBox(item.id)}
                                                                                        >
                                                                                            移出
                                                                                        </button>
                                                                                    </div>
                                                                                </div>
                                                                                <div className="ts-12 leading-[1.6]" style={{ color: "var(--c-text)" }}>
                                                                                    {itemBody}
                                                                                </div>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            ) : (
                                                                <div className="ts-11 text-secondary" style={{ paddingLeft: 2 }}>暂无近期事件</div>
                                                            )}

                                                            {/* 已归档事件（浅色，在近期事件之后） */}
                                                            {archivedEntries.length > 0 && (
                                                                <>
                                                                    <div className="mem-box-layer-label">
                                                                        <span>已归档事件（{archivedEntries.length}）</span>
                                                                    </div>
                                                                    <div className="mem-box-chain-list">
                                                                        {archivedEntries.map(item => {
                                                                            const itemBody = stripMemoryStructuredSections(item.content) || item.content;
                                                                            const itemDate = formatEntryDateLines(item)[0];
                                                                            return (
                                                                                <div
                                                                                    key={item.id}
                                                                                    id={`mem-box-item-${item.id}`}
                                                                                    className={`mem-box-chain-item is-archived${flashTargetId === item.id ? " mem-jump-flash" : ""}`}
                                                                                >
                                                                                    <div className="mem-box-chain-head">
                                                                                        <span>{itemDate}</span>
                                                                                        <div style={{ display: "flex", gap: 8 }}>
                                                                                            <button
                                                                                                type="button"
                                                                                                className="mem-superseded-jump"
                                                                                                onClick={() => {
                                                                                                    if (searchQuery) setSearchQuery("");
                                                                                                    if (searchScoreMap) setSearchScoreMap(null);
                                                                                                    setActiveTab("long");
                                                                                                    setExpandedId(item.id);
                                                                                                    scrollToAndFlash(`mem-entry-card-${item.id}`, item.id);
                                                                                                }}
                                                                                            >
                                                                                                原条目
                                                                                            </button>
                                                                                            <button
                                                                                                type="button"
                                                                                                className="mem-superseded-jump"
                                                                                                onClick={() => void handleUnarchiveEntry(item)}
                                                                                            >
                                                                                                取消归档
                                                                                            </button>
                                                                                            <button
                                                                                                type="button"
                                                                                                className="mem-superseded-jump"
                                                                                                onClick={() => void handleRemoveEntryFromBox(item.id)}
                                                                                            >
                                                                                                移出
                                                                                            </button>
                                                                                        </div>
                                                                                    </div>
                                                                                    <div className="ts-12 leading-[1.6]" style={{ color: "var(--c-icon)" }}>
                                                                                        {itemBody}
                                                                                    </div>
                                                                                </div>
                                                                            );
                                                                        })}
                                                                    </div>
                                                                </>
                                                            )}

                                                            {/* 「+ 添加事件」已上移到「近期事件」行尾，这里不再重复 */}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })
                                    )}
                                </>
                            );
                        })()
                    ) : activeTab === "core" ? (
                        renderMemoryEntries("core", coreEntries, "暂无核心记忆。长期记忆累计到设定条数后会自动提炼，也可以手动新增。")
                    ) : activeTab === "trash" ? (
                        renderTrashTab()
                    ) : (
                        /* ── Long-term: Summarized Memories ── */
                        renderMemoryEntries("long_term", longTermEntries, "暂无长期记忆。点击设置页的手动总结，或直接新增一条记忆。")
                    )}
                    </MemoryDetailBoundary>
                </div>

                {/* Bottom tab bar — 短期 | 共享事件 | 长期 | 核心 | 最近删除（核心图标恢复原版 Archive） */}
                <div className="chat-tab-bar" style={{ position: "absolute", bottom: 40, left: 24, right: 24, zIndex: 10, borderRadius: 28, borderTop: "none", padding: "10px 0" }}>
                    {([
                        { key: "short" as const, icon: Clock, label: "短期" },
                        { key: "shared" as const, icon: Users, label: "共享事件" },
                        { key: "long" as const, icon: Archive, label: "长期" },
                        { key: "core" as const, icon: Archive, label: "核心" },
                        { key: "trash" as const, icon: Trash2, label: "最近删除" },
                    ]).map(tab => (
                        <button
                            key={tab.key}
                            className={`chat-tab${activeTab === tab.key ? " chat-tab-active" : ""}`}
                            onClick={() => {
                                setActiveTab(tab.key);
                                setEntryMenuId(null);
                                setSearchScoreMap(null);
                            }}
                        >
                            <tab.icon size={18} />
                            <span>{tab.label}</span>
                        </button>
                    ))}
                </div>

                {/* Manual memory editor */}
                {memoryEditor && (() => {
                    const isCore = memoryEditor.type === "core";
                    const isEdit = Boolean(memoryEditor.entry);
                    const hasDrafts = Boolean(memoryEditor.cleanedDrafts && memoryEditor.cleanedDrafts.length > 0);
                    const title = `${isEdit ? "编辑" : "新增"}${isCore ? "核心记忆" : "长期记忆"}`;
                    const placeholder = isCore
                        ? "记录稳定、长期影响角色判断的事实，例如关系身份、重大约定、长期设定。"
                        : "输入单条记忆，或粘贴多段长文本后使用下方「记忆清洗」自动拆分并提取日期。";
                    const contentLength = memoryEditor.content.trim().length;
                    const overLimit = !hasDrafts && contentLength > MANUAL_MEMORY_CONTENT_LIMIT;
                    const canSave = hasDrafts
                        ? memoryEditor.cleanedDrafts!.some(d => d.content.trim().length > 0)
                        : (contentLength > 0 && !overLimit);

                    return (
                        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => (savingMemory || cleaningManualText) ? undefined : setMemoryEditor(null)}>
                            <div className="modal-sheet mem-edit-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                <div className="modal-header" data-ui="modal-header">
                                    <button
                                        className="modal-header-btn modal-header-btn-muted"
                                        onClick={() => setMemoryEditor(null)}
                                        disabled={savingMemory || cleaningManualText}
                                    >
                                        <X size={18} />
                                    </button>
                                    <h3 className="modal-title">{title}</h3>
                                    <button
                                        className="modal-header-btn modal-header-btn-action"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || cleaningManualText || !canSave}
                                    >
                                        <Check size={18} />
                                    </button>
                                </div>
                                <div className="modal-body mem-edit-body" data-ui="modal-body">
                                    {hasDrafts ? (
                                        <div className="flex flex-col gap-3">
                                            <div className="flex justify-between items-center">
                                                <span className="ts-12 text-secondary">
                                                    已拆分为 <strong>{memoryEditor.cleanedDrafts!.length}</strong> 条独立记忆
                                                </span>
                                                <button
                                                    type="button"
                                                    className="ui-bare-btn ts-12 underline text-secondary"
                                                    disabled={savingMemory}
                                                    onClick={() => setMemoryEditor(prev => prev ? { ...prev, cleanedDrafts: undefined } : prev)}
                                                >
                                                    返回原文本
                                                </button>
                                            </div>
                                            <div className="flex flex-col gap-3" style={{ maxHeight: "48vh", overflowY: "auto", paddingRight: 2 }}>
                                                {memoryEditor.cleanedDrafts!.map((draft, idx) => (
                                                    <div key={idx} className="g-card" style={{ padding: 12, gap: 8 }}>
                                                        <div className="flex justify-between items-center">
                                                            <span className="ts-12 font-bold">第 {idx + 1} 条</span>
                                                            {memoryEditor.cleanedDrafts!.length > 1 && (
                                                                <button
                                                                    type="button"
                                                                    className="ui-bare-btn ts-11 text-secondary"
                                                                    disabled={savingMemory}
                                                                    onClick={() => setMemoryEditor(prev => {
                                                                        if (!prev?.cleanedDrafts) return prev;
                                                                        const next = prev.cleanedDrafts.filter((_, i) => i !== idx);
                                                                        return { ...prev, cleanedDrafts: next.length > 0 ? next : undefined };
                                                                    })}
                                                                >
                                                                    移除此条
                                                                </button>
                                                            )}
                                                        </div>
                                                        <textarea
                                                            className="ui-textarea ts-12"
                                                            style={{ minHeight: 72 }}
                                                            value={draft.content}
                                                            disabled={savingMemory}
                                                            onChange={e => {
                                                                const val = e.target.value;
                                                                setMemoryEditor(prev => {
                                                                    if (!prev?.cleanedDrafts) return prev;
                                                                    const next = [...prev.cleanedDrafts];
                                                                    next[idx] = { ...next[idx], content: val };
                                                                    return { ...prev, cleanedDrafts: next };
                                                                });
                                                            }}
                                                        />
                                                        <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                                                            <label className="ts-11 text-secondary">事件日期：</label>
                                                            <input
                                                                type="date"
                                                                className="ui-input ts-12"
                                                                style={{ width: "auto", padding: "4px 8px" }}
                                                                value={draft.eventDate}
                                                                disabled={savingMemory}
                                                                onChange={e => {
                                                                    const val = e.target.value;
                                                                    setMemoryEditor(prev => {
                                                                        if (!prev?.cleanedDrafts) return prev;
                                                                        const next = [...prev.cleanedDrafts];
                                                                        next[idx] = { ...next[idx], eventDate: val };
                                                                        return { ...prev, cleanedDrafts: next };
                                                                    });
                                                                }}
                                                            />
                                                            <label className="ts-11 text-secondary" style={{ marginLeft: "auto" }}>
                                                                重要性：{draft.importance}/10
                                                            </label>
                                                            <input
                                                                type="range"
                                                                min={1}
                                                                max={10}
                                                                step={1}
                                                                value={draft.importance}
                                                                disabled={savingMemory}
                                                                style={{ width: 80 }}
                                                                onChange={e => {
                                                                    const val = Number(e.target.value);
                                                                    setMemoryEditor(prev => {
                                                                        if (!prev?.cleanedDrafts) return prev;
                                                                        const next = [...prev.cleanedDrafts];
                                                                        next[idx] = { ...next[idx], importance: val };
                                                                        return { ...prev, cleanedDrafts: next };
                                                                    });
                                                                }}
                                                                className="ui-slider"
                                                            />
                                                        </div>
                                                        <input
                                                            type="text"
                                                            className="ui-input ts-12"
                                                            value={draft.keywordsText}
                                                            placeholder="检索关键词，用顿号或逗号分隔"
                                                            disabled={savingMemory}
                                                            onChange={e => {
                                                                const val = e.target.value;
                                                                setMemoryEditor(prev => {
                                                                    if (!prev?.cleanedDrafts) return prev;
                                                                    const next = [...prev.cleanedDrafts];
                                                                    next[idx] = { ...next[idx], keywordsText: val };
                                                                    return { ...prev, cleanedDrafts: next };
                                                                });
                                                            }}
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <textarea
                                                className="ui-textarea mem-edit-textarea"
                                                value={memoryEditor.content}
                                                placeholder={placeholder}
                                                disabled={savingMemory || cleaningManualText}
                                                onChange={event => {
                                                    const newText = event.target.value;
                                                    setMemoryEditor(prev => {
                                                        if (!prev) return prev;
                                                        const autoDate = !prev.dateTouched ? extractDateFromRawText(newText) : undefined;
                                                        return {
                                                            ...prev,
                                                            content: newText,
                                                            ...(autoDate ? { eventDate: autoDate } : {}),
                                                        };
                                                    });
                                                }}
                                            />
                                            <div className="flex flex-col gap-1">
                                                {/* 记忆清洗做的是「拆条 + 提取日期关键词」，核心记忆是稳定事实的整段总结，用不上 */}
                                                <div className="flex justify-between items-center" style={{ gap: 8, flexWrap: "wrap" }}>
                                                    {!isCore && (
                                                        <button
                                                            type="button"
                                                            className="ui-btn ui-btn-outline py-1.5 px-3 ts-12"
                                                            onClick={() => void handleCleanManualText()}
                                                            disabled={savingMemory || cleaningManualText || !contentLength}
                                                        >
                                                            <Sparkles size={13} className="mr-1" />
                                                            {cleaningManualText ? "清洗中..." : "记忆清洗"}
                                                        </button>
                                                    )}
                                                    <div className={`mem-edit-footer ${overLimit ? "is-over-limit" : ""}`} style={{ margin: 0, marginLeft: "auto" }}>
                                                        <span>{contentLength}/{MANUAL_MEMORY_CONTENT_LIMIT}</span>
                                                    </div>
                                                </div>
                                                {!isCore && (
                                                    <span className="ts-11 text-secondary">
                                                        将调用模型接口自动拆分长文本、提取事件日期与检索关键词，会产生一次 API 调用
                                                    </span>
                                                )}
                                            </div>
                                            <div className="mem-edit-meta-fields">
                                                <div className="mem-edit-field-row" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                                    <label className="mem-edit-field-label" style={{ margin: 0 }}>
                                                        事件日期
                                                    </label>
                                                    <input
                                                        type="date"
                                                        className="ui-input ts-12"
                                                        style={{ width: "auto", padding: "4px 10px" }}
                                                        value={memoryEditor.eventDate}
                                                        disabled={savingMemory || cleaningManualText}
                                                        onChange={e => setMemoryEditor(prev => prev ? {
                                                            ...prev,
                                                            eventDate: e.target.value,
                                                            dateTouched: true,
                                                        } : prev)}
                                                    />
                                                </div>
                                                <div className="mem-edit-field-row">
                                                    <label className="mem-edit-field-label">重要性：{memoryEditor.importance}/10</label>
                                                    <input
                                                        type="range"
                                                        min={1}
                                                        max={10}
                                                        step={1}
                                                        value={memoryEditor.importance}
                                                        disabled={savingMemory || cleaningManualText}
                                                        onChange={e => setMemoryEditor(prev => prev ? { ...prev, importance: Number(e.target.value) } : prev)}
                                                        className="ui-slider"
                                                    />
                                                </div>
                                                <div className="mem-edit-field-row">
                                                    <label className="mem-edit-field-label">检索关键词</label>
                                                    <input
                                                        type="text"
                                                        className="ui-input ts-12"
                                                        value={memoryEditor.keywordsText}
                                                        placeholder="用顿号或逗号分隔，如：窄门、法语、约定"
                                                        disabled={savingMemory || cleaningManualText}
                                                        onChange={e => setMemoryEditor(prev => prev ? { ...prev, keywordsText: e.target.value } : prev)}
                                                    />
                                                </div>
                                                {/* 事件盒功能已停用：编辑器里不再提供「放入事件盒」 */}
                                                {false && !isCore && (!memoryEditor.entry || !isEntryBoxDigest(memoryEditor.entry)) && (
                                                    <div className="mem-edit-field-row">
                                                        <label className="mem-edit-field-label">放入事件盒</label>
                                                        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
                                                            {/* 第一行固定为「不放入」+「+ 新建事件盒」，不受下方列表滚动影响 */}
                                                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                                                                <button
                                                                    type="button"
                                                                    className="ui-chip"
                                                                    style={{ fontSize: 11, padding: "4px 10px" }}
                                                                    data-selected={!memoryEditor.eventBoxId ? "" : undefined}
                                                                    onClick={() => setMemoryEditor(prev => prev ? { ...prev, eventBoxId: "" } : prev)}
                                                                >
                                                                    不放入
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className="ui-chip"
                                                                    style={{ fontSize: 11, padding: "4px 10px" }}
                                                                    onClick={() => setBoxDialog({ title: "", importance: 8, keywordsText: "" })}
                                                                >
                                                                    + 新建事件盒
                                                                </button>
                                                            </div>
                                                            {/* 之后罗列全部事件盒：只露三行，超出上下滑动浏览选择 */}
                                                            {boxes.length > 0 && (
                                                                <div
                                                                    ref={boxChipScrollRef}
                                                                    className="mem-box-chip-scroll"
                                                                    style={{ maxHeight: boxChipMaxHeight }}
                                                                >
                                                                    {boxes.map(b => (
                                                                        <button
                                                                            key={b.id}
                                                                            type="button"
                                                                            className="ui-chip"
                                                                            style={{ fontSize: 11, padding: "4px 10px" }}
                                                                            data-selected={memoryEditor.eventBoxId === b.id ? "" : undefined}
                                                                            onClick={() => setMemoryEditor(prev => prev ? { ...prev, eventBoxId: b.id } : prev)}
                                                                        >
                                                                            {b.title}
                                                                        </button>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </>
                                    )}
                                    <button
                                        className="ui-btn ui-btn-primary mem-edit-save-btn"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || cleaningManualText || !canSave}
                                    >
                                        {savingMemory
                                            ? "保存中..."
                                            : hasDrafts
                                                ? `确认保存 ${memoryEditor.cleanedDrafts!.length} 条记忆`
                                                : "保存记忆"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* 重新总结：先写修正思路，再交给模型按原文重新核对 */}
                {resummarizeDialog && (
                    <div
                        className="modal-overlay modal-overlay-bottom"
                        data-ui="modal"
                        onClick={() => { if (!resplittingEntryId) setResummarizeDialog(null); }}
                    >
                        <div className="modal-sheet mem-edit-sheet" data-ui="modal-sheet" onClick={ev => ev.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <button
                                    className="modal-header-btn modal-header-btn-muted"
                                    disabled={Boolean(resplittingEntryId)}
                                    onClick={() => setResummarizeDialog(null)}
                                >
                                    <X size={18} />
                                </button>
                                <h3 className="modal-title">{resummarizeDialog.isCore ? "重新提炼核心记忆" : "重新总结"}</h3>
                                <button
                                    className="modal-header-btn modal-header-btn-action"
                                    disabled={Boolean(resplittingEntryId)}
                                    onClick={() => void handleResplitEntry(resummarizeDialog.entry, resummarizeDialog.instruction)}
                                >
                                    <Check size={18} />
                                </button>
                            </div>
                            <div className="modal-body mem-edit-body" data-ui="modal-body">
                                <div className="ts-12 text-secondary" style={{ whiteSpace: "pre-wrap", opacity: 0.85 }}>
                                    当前记忆：
                                    {(stripMemoryStructuredSections(resummarizeDialog.entry.content) || resummarizeDialog.entry.content).slice(0, 160)}
                                    {(stripMemoryStructuredSections(resummarizeDialog.entry.content) || resummarizeDialog.entry.content).length > 160 ? "…" : ""}
                                </div>
                                <div className="mem-edit-field-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                                    <label className="mem-edit-field-label">修正思路（可留空）</label>
                                    <textarea
                                        className="ui-textarea ts-12"
                                        style={{ minHeight: 96 }}
                                        maxLength={2000}
                                        placeholder={resummarizeDialog.isCore
                                            ? "写清楚这条核心记忆哪里判断偏了、希望模型怎么改。例如：\n· 不要把单次争吵写成关系稳定恶化，那只是一次情绪\n· 角色对工作的执着是他自己的原则，不是为了让用户满意\n· 漏掉了搬去城西这件事，它改变了他对这段关系的打算"
                                            : "写清楚这条记忆哪里总结错了、希望模型怎么改。例如：\n· 他不是女生，全文的「她」都要改成「他」\n· 两件事其实没关系，不要写成因为A所以B\n· 「调侃他扮观音」只是玩笑，不要写成真的扮过"}
                                        value={resummarizeDialog.instruction}
                                        onChange={e => {
                                            const val = e.target.value;
                                            setResummarizeDialog(prev => prev ? { ...prev, instruction: val } : prev);
                                        }}
                                    />
                                    <span className="ts-11 text-secondary">
                                        {resummarizeDialog.isCore
                                            ? "会以最高优先级注入提示词；模型只能依据这条核心记忆当初依据的长期记忆与原始对话记录重写，追溯不到依据时会拒绝执行。旧版本会保留为历史记录，可回看。"
                                            : "会以最高优先级注入提示词；模型仍只能依据原始对话/事件记录改写，不会因为这段要求而编造原文没有的事。"}
                                    </span>
                                </div>
                                <button
                                    className="ui-btn ui-btn-primary mem-edit-save-btn"
                                    disabled={Boolean(resplittingEntryId)}
                                    onClick={() => void handleResplitEntry(resummarizeDialog.entry, resummarizeDialog.instruction)}
                                >
                                    {resplittingEntryId ? "重新总结中..." : "开始重新总结"}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* 最近删除：清空回收站二次确认（不可恢复） */}
                {confirmEmptyTrash && (
                    <ConfirmDialog
                        title="彻底清空回收站？"
                        message="将把该角色「最近删除」中的所有已删除记忆彻底清除，此操作不可恢复（仍在生效的正常记忆不受影响）。"
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="彻底清空"
                        cancelLabel="取消"
                        onCancel={() => setConfirmEmptyTrash(false)}
                        onConfirm={() => {
                            setConfirmEmptyTrash(false);
                            void handleEmptyTrash();
                        }}
                    />
                )}

                {/* 最近删除：彻底删除二次确认（不可恢复） */}
                {confirmPurgeEntry && (
                    <ConfirmDialog
                        title="彻底删除这条记忆？"
                        message="这一步不可恢复，删掉之后记忆库里不会再留下内容。如果只是不想让它参与记忆注入，点「取消」让它留在「最近删除」里即可。"
                        variant="danger"
                        confirmLabel="彻底删除"
                        cancelLabel="取消"
                        onCancel={() => setConfirmPurgeEntry(null)}
                        onConfirm={() => {
                            const target = confirmPurgeEntry;
                            setConfirmPurgeEntry(null);
                            void handlePurgeTrashed(target);
                        }}
                    />
                )}

                {/* 事件盒：新建 / 编辑弹窗（支持修改事件盒标题、阶段总结正文、重要性与检索关键词） */}
                {boxDialog && (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => !savingBoxDialog && setBoxDialog(null)}>
                        <div className="modal-sheet mem-edit-sheet" data-ui="modal-sheet" onClick={ev => ev.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <button
                                    className="modal-header-btn modal-header-btn-muted"
                                    disabled={savingBoxDialog}
                                    onClick={() => setBoxDialog(null)}
                                >
                                    <X size={18} />
                                </button>
                                <h3 className="modal-title">{boxDialog.boxId ? "编辑事件盒与总结" : "新建事件盒"}</h3>
                                <button
                                    className="modal-header-btn modal-header-btn-action"
                                    disabled={savingBoxDialog || !boxDialog.title.trim()}
                                    onClick={() => void handleSaveBoxDialog()}
                                >
                                    <Check size={18} />
                                </button>
                            </div>
                            <div className="modal-body mem-edit-body" data-ui="modal-body">
                                <div className="mem-edit-field-row">
                                    <label className="mem-edit-field-label">事件盒标题</label>
                                    <input
                                        type="text"
                                        className="ui-input ts-12"
                                        placeholder="例如：筹备生日礼物、学法语的约定"
                                        disabled={savingBoxDialog}
                                        value={boxDialog.title}
                                        onChange={e => setBoxDialog(prev => prev ? { ...prev, title: e.target.value } : prev)}
                                    />
                                </div>
                                {boxDialog.boxId && (
                                    <div className="mem-edit-field-row">
                                        <label className="mem-edit-field-label">事件阶段总结</label>
                                        <textarea
                                            className="ui-textarea ts-12"
                                            style={{ minHeight: 110, lineHeight: 1.65 }}
                                            placeholder="在此直接编写或修改该事件盒的阶段总结内容（保存后将同步更新记忆条目与向量）"
                                            disabled={savingBoxDialog}
                                            value={boxDialog.summaryText ?? ""}
                                            onChange={e => setBoxDialog(prev => prev ? { ...prev, summaryText: e.target.value } : prev)}
                                        />
                                    </div>
                                )}
                                <div className="mem-edit-field-row">
                                    <label className="mem-edit-field-label">重要性：{boxDialog.importance}/10</label>
                                    <input
                                        type="range"
                                        min={1}
                                        max={10}
                                        step={1}
                                        value={boxDialog.importance}
                                        disabled={savingBoxDialog}
                                        onChange={e => setBoxDialog(prev => prev ? { ...prev, importance: Number(e.target.value) } : prev)}
                                        className="ui-slider"
                                    />
                                </div>
                                <div className="mem-edit-field-row">
                                    <label className="mem-edit-field-label">检索关键词</label>
                                    <input
                                        type="text"
                                        className="ui-input ts-12"
                                        placeholder="用顿号或逗号分隔（生成总结时也会自动生成）"
                                        disabled={savingBoxDialog}
                                        value={boxDialog.keywordsText}
                                        onChange={e => setBoxDialog(prev => prev ? { ...prev, keywordsText: e.target.value } : prev)}
                                    />
                                </div>
                                <button
                                    className="ui-btn ui-btn-primary mem-edit-save-btn"
                                    disabled={savingBoxDialog || !boxDialog.title.trim()}
                                    onClick={() => void handleSaveBoxDialog()}
                                >
                                    {savingBoxDialog ? "保存中..." : boxDialog.boxId ? "保存修改" : "创建事件盒"}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* 事件盒：单条记忆放入/更换事件盒 */}
                {boxMoveEntryId && (() => {
                    const targetEntry = longTermEntries.find(e => e.id === boxMoveEntryId);
                    if (!targetEntry) return null;
                    const currentBoxId = getEntryBoxId(targetEntry);
                    return (
                        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setBoxMoveEntryId(null)}>
                            <div className="modal-sheet" data-ui="modal-sheet" onClick={ev => ev.stopPropagation()}>
                                <div className="modal-header" data-ui="modal-header">
                                    <span style={{ width: 28 }} />
                                    <h3 className="modal-title">放入事件盒</h3>
                                    <button className="modal-header-btn modal-header-btn-muted" onClick={() => setBoxMoveEntryId(null)}>
                                        <X size={18} />
                                    </button>
                                </div>
                                <div className="modal-body" data-ui="modal-body" style={{ paddingBottom: 20 }}>
                                    <p className="ts-11 text-secondary mx-2" style={{ marginBottom: 8 }}>
                                        放入事件盒后将作为该盒的「新事件」，后续可在事件盒中手动点击总结。
                                    </p>
                                    <div className="menu-group">
                                        {boxes.map(box => (
                                            <button
                                                key={box.id}
                                                className="menu-item"
                                                onClick={() => void handleMoveSingleEntryToBox(box.id)}
                                            >
                                                <Folder size={18} />
                                                <div className="menu-label-group">
                                                    <span className="menu-label">{box.title}</span>
                                                    <span className="menu-desc">{EVENT_BOX_STATUS_META[box.status].label}</span>
                                                </div>
                                                <div className="menu-right">
                                                    {box.id === currentBoxId ? <span className="menu-desc">当前所属</span> : <ChevronRight size={16} />}
                                                </div>
                                            </button>
                                        ))}
                                        <button
                                            className="menu-item"
                                            onClick={() => {
                                                const pid = boxMoveEntryId;
                                                setBoxMoveEntryId(null);
                                                setBoxDialog({ title: "", importance: 8, keywordsText: "", pendingEntryId: pid });
                                            }}
                                        >
                                            <Plus size={18} />
                                            <div className="menu-label-group">
                                                <span className="menu-label">新建事件盒并放入</span>
                                                <span className="menu-desc">创建一个新事件盒，直接将本条记忆作为新事件放入</span>
                                            </div>
                                            <div className="menu-right">
                                                <ChevronRight size={16} />
                                            </div>
                                        </button>
                                        {currentBoxId && (
                                            <button
                                                className="menu-item"
                                                onClick={() => void handleRemoveEntryFromBox(targetEntry.id)}
                                            >
                                                <Trash2 size={18} />
                                                <div className="menu-label-group">
                                                    <span className="menu-label menu-label-danger">移出当前事件盒</span>
                                                    <span className="menu-desc">恢复为未归盒的普通长期记忆</span>
                                                </div>
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* 事件盒内：从已有未归盒记忆中勾选添加 */}
                {boxAddPickerOpen && activeBoxId && (() => {
                    const available = longTermEntries.filter(e => !isEntryTrashed(e) && !getEntryBoxId(e) && !isEntryBoxDigest(e));
                    const selectedCount = Object.keys(boxAddSelectedIds).filter(id => boxAddSelectedIds[id]).length;
                    return (
                        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setBoxAddPickerOpen(false)}>
                            <div className="modal-sheet" data-ui="modal-sheet" onClick={ev => ev.stopPropagation()}>
                                <div className="modal-header" data-ui="modal-header">
                                    <button className="modal-header-btn modal-header-btn-muted" onClick={() => setBoxAddPickerOpen(false)}>
                                        <X size={18} />
                                    </button>
                                    <h3 className="modal-title">勾选记忆加入「新事件」</h3>
                                    <button
                                        className="modal-header-btn modal-header-btn-action"
                                        disabled={selectedCount === 0}
                                        onClick={() => void handleConfirmAddEntriesToBox()}
                                    >
                                        <Check size={18} />
                                    </button>
                                </div>
                                <div className="modal-body" data-ui="modal-body" style={{ maxHeight: "60vh", overflowY: "auto", paddingBottom: 16 }}>
                                    {available.length === 0 ? (
                                        <p className="ts-12 text-secondary text-center py-6">当前没有未归盒的长期记忆可供添加。</p>
                                    ) : (
                                        <div className="flex flex-col gap-2">
                                            {available.map(item => {
                                                const checked = Boolean(boxAddSelectedIds[item.id]);
                                                const body = (stripMemoryStructuredSections(item.content) || item.content).slice(0, 120);
                                                return (
                                                    <div
                                                        key={item.id}
                                                        className="g-card"
                                                        style={{
                                                            padding: "10px 12px",
                                                            cursor: "pointer",
                                                            border: checked ? "1.5px solid var(--c-text)" : undefined,
                                                        }}
                                                        onClick={() => setBoxAddSelectedIds(prev => ({ ...prev, [item.id]: !prev[item.id] }))}
                                                    >
                                                        <div className="flex items-center justify-between">
                                                            <span className="ts-11 text-secondary">{formatEntryDateLines(item)[0]}</span>
                                                            <span className="ts-11 font-bold">{checked ? "✓ 已选" : "点击选择"}</span>
                                                        </div>
                                                        <p className="ts-12" style={{ margin: "4px 0 0" }}>{body}</p>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                    {available.length > 0 && (
                                        <button
                                            className="ui-btn ui-btn-primary mem-edit-save-btn"
                                            style={{ marginTop: 12 }}
                                            disabled={selectedCount === 0}
                                            onClick={() => void handleConfirmAddEntriesToBox()}
                                        >
                                            加入事件盒（{selectedCount} 条）
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* 事件盒：智能推荐归盒预览（仅归入事件盒，绝不自动批量总结） */}
                {smartSuggestions.length > 0 && (() => {
                    const chosenCount = smartSuggestions.filter(s => smartSelected[s.key]).length;
                    return (
                        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => !smartBusy && setSmartSuggestions([])}>
                            <div className="modal-sheet" data-ui="modal-sheet" onClick={ev => ev.stopPropagation()}>
                                <div className="modal-header" data-ui="modal-header">
                                    <span style={{ width: 28 }} />
                                    <h3 className="modal-title">智能推荐归盒（{smartSuggestions.length} 组）</h3>
                                    <button className="modal-header-btn modal-header-btn-muted" disabled={smartBusy} onClick={() => setSmartSuggestions([])}>
                                        <X size={18} />
                                    </button>
                                </div>
                                <div className="modal-body" data-ui="modal-body" style={{ maxHeight: "62vh", overflowY: "auto", paddingBottom: 16 }}>
                                    <p className="ts-11 text-secondary mx-2" style={{ marginBottom: 8 }}>
                                        确认后仅将相关记忆放入对应事件盒的「新事件」中，不会自动总结；你可以随后点进事件盒手动点击总结。
                                    </p>
                                    <div className="flex flex-col gap-2">
                                        {smartSuggestions.map(group => {
                                            const checked = Boolean(smartSelected[group.key]);
                                            return (
                                                <div
                                                    key={group.key}
                                                    className="g-card"
                                                    style={{
                                                        padding: "10px 12px",
                                                        cursor: "pointer",
                                                        opacity: checked ? 1 : 0.55,
                                                    }}
                                                    onClick={() => !smartBusy && setSmartSelected(prev => ({ ...prev, [group.key]: !prev[group.key] }))}
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <span className="ts-13 font-bold">
                                                            {group.targetBoxId ? `[并入已有盒] ${group.title}` : `[新建事件盒] ${group.title}`}
                                                        </span>
                                                        <span className="ts-11 font-bold">{checked ? "✓ 选中" : "已取消"}</span>
                                                    </div>
                                                    <span className="ts-11 text-secondary">
                                                        共 {group.entries.length} 条相关记忆 · {group.earliest} ~ {group.latest}
                                                    </span>
                                                    <div className="flex flex-col gap-1 mt-1">
                                                        {group.entries.slice(0, 3).map(e => (
                                                            <p key={e.id} className="ts-11 text-secondary" style={{ margin: 0 }}>
                                                                • {(stripMemoryStructuredSections(e.content) || e.content).slice(0, 65)}...
                                                            </p>
                                                        ))}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                                        <button
                                            className="ui-btn ui-btn-outline mem-edit-save-btn"
                                            style={{ flex: 1 }}
                                            disabled={smartBusy || batchBoxSummarizing || chosenCount === 0}
                                            onClick={() => void handleConfirmSmartSuggestions(false)}
                                        >
                                            {smartBusy ? "正在放入..." : `仅放入（${chosenCount} 组）`}
                                        </button>
                                        <button
                                            className="ui-btn ui-btn-primary mem-edit-save-btn"
                                            style={{ flex: 1 }}
                                            disabled={smartBusy || batchBoxSummarizing || chosenCount === 0}
                                            onClick={() => void handleConfirmSmartSuggestions(true)}
                                        >
                                            {smartBusy || batchBoxSummarizing ? "处理中..." : `放入并批量总结（${chosenCount} 组）`}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* 事件盒：删除盒子 / 撤销总结恢复确认 */}
                {boxConfirm && (
                    <ConfirmDialog
                        title={boxConfirm.kind === "delete" ? "删除这个事件盒？" : "撤销总结并恢复？"}
                        message={
                            boxConfirm.kind === "delete"
                                ? "盒内的原始记忆不会被删除，将全部恢复为普通长期记忆；该盒生成的总结条目将被移除。"
                                : "将移除该事件盒当前的「先前事件的总结」，并把下方所有「已归档事件」恢复为「新事件」重新参与独立召回。"
                        }
                        icon={AlertCircle}
                        variant={boxConfirm.kind === "delete" ? "danger" : undefined}
                        confirmLabel={boxConfirm.kind === "delete" ? "删除事件盒" : "确认恢复"}
                        onConfirm={() => void handleConfirmBoxAction()}
                        onCancel={() => setBoxConfirm(null)}
                    />
                )}

                {/* Confirm clear all long-term / core entries */}
                {confirmClearAll && (
                    <ConfirmDialog
                        title="全部移入最近删除？"
                        message={
                            confirmClearAll === "core"
                                ? "该角色的核心记忆会全部移入「最近删除」，随时可以恢复；在「最近删除」里点「彻底删除」才真的删掉，超过 60 天也会自动清理。"
                                : "该角色的长期记忆会全部移入「最近删除」，随时可以恢复；在「最近删除」里点「彻底删除」才真的删掉，超过 60 天也会自动清理。"
                        }
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="全部移入"
                        onConfirm={() => {
                            const targetType = confirmClearAll;
                            setConfirmClearAll(null);
                            void handleClearEntries(targetType);
                        }}
                        onCancel={() => setConfirmClearAll(null)}
                    />
                )}
            </div>
        );
    }

    // ── Settings View ──
    if (view === "settings") {
        const currentPrompt = editingPrompt ?? config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT;
        const currentCorePrompt = editingCorePrompt ?? config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT;
        const isModified = currentPrompt !== (config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT);
        const isDefault = (config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT) === DEFAULT_SUMMARIZATION_PROMPT;
        const isCoreModified = currentCorePrompt !== (config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT);
        const isCoreDefault = (config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT) === DEFAULT_CORE_MEMORY_PROMPT;

        // 空串 = 跟随内置默认，编辑框里直接显示默认全文，方便对照修改
        const savedEventBoxPrompt = (config.eventBoxSummaryPrompt ?? "").trim();
        const currentEventBoxPrompt = editingEventBoxPrompt ?? (savedEventBoxPrompt || DEFAULT_EVENT_BOX_SUMMARY_PROMPT);
        const isEventBoxModified = currentEventBoxPrompt !== (savedEventBoxPrompt || DEFAULT_EVENT_BOX_SUMMARY_PROMPT);
        const isEventBoxDefault = !savedEventBoxPrompt || savedEventBoxPrompt === DEFAULT_EVENT_BOX_SUMMARY_PROMPT;

        // 只有确实存在「格式待整理」的条目时才露出这个入口；自动总结的条目不会计入
        const legacyCleanupCount = selectedCharId
            ? longTermEntries.filter(e => !isEntryTrashed(e) && isLegacyUnorganizedMemory(e)).length
            : 0;

        return (
            <div className="page-menu memory-settings-menu">
                {/* Manual summarize */}
                {selectedCharId && (
                    <>
                        <p className="menu-group-desc mx-2">手动操作</p>
                        <div className="menu-group">
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Zap} color={BINDING_ACCENTS.memory} />
                                <div className="menu-label-group">
                                    <span className="menu-label">长期记忆手动总结</span>
                                    <span className="menu-desc">将新产生的事件整理为长期记忆</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={() => setSummarizeRangeOpen(true)}
                                        disabled={summarizing}
                                    >
                                        <Zap size={12} className="mr-1" />
                                        {summarizing ? "处理中..." : "总结"}
                                    </button>
                                </div>
                            </div>
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                                <div className="menu-label-group">
                                    <span className="menu-label">核心记忆手动总结</span>
                                    <span className="menu-desc">将长期记忆整理为核心记忆</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={handleManualRebuildCore}
                                        disabled={rebuildingCore}
                                    >
                                        <Archive size={12} className="mr-1" />
                                        {rebuildingCore ? "处理中..." : "重建"}
                                    </button>
                                </div>
                            </div>
                            {legacyCleanupCount > 0 && (
                                <div className="menu-item">
                                    <MemorySettingsIcon icon={Sparkles} color={BINDING_ACCENTS.preset} />
                                    <div className="menu-label-group">
                                        <span className="menu-label">整理旧格式记忆（{legacyCleanupCount}）</span>
                                        <span className="menu-desc">把长文本或混杂格式的条目拆分、提取事件日期并补齐向量；自动总结的条目不在处理范围内</span>
                                    </div>
                                    <div className="menu-right">
                                        <button
                                            className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                            onClick={() => void handleCleanAllLegacyMemories()}
                                            disabled={cleaningAllLegacy || summarizing}
                                        >
                                            <Sparkles size={12} className="mr-1" />
                                            {cleaningAllLegacy ? `整理中(${cleanLegacyProgress})` : "一键整理"}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {summarizeRangeOpen ? (
                            <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSummarizeRangeOpen(false)}>
                                <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                    <div className="modal-header" data-ui="modal-header">
                                        <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSummarizeRangeOpen(false)}><X size={18} /></button>
                                        <h3 className="modal-title">选择总结范围</h3>
                                        <span style={{ width: 44 }} />
                                    </div>
                                    <div className="modal-body modal-body-tight" data-ui="modal-body">
                                        <div className="menu-group">
                                            {SUMMARIZE_RANGE_OPTIONS.map(option => (
                                                <button
                                                    key={String(option.value)}
                                                    type="button"
                                                    className="menu-item w-full text-left"
                                                    onClick={() => void handleManualSummarize(option.value)}
                                                >
                                                    <div className="menu-label-group">
                                                        <span className="menu-label">{option.label}</span>
                                                        {option.desc ? <span className="menu-desc">{option.desc}</span> : null}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : null}
                    </>
                )}

                {/* Memory source filter — one entry row, full picker lives in a bottom sheet */}
                <p className="menu-group-desc mx-2">记忆来源</p>
                <div className="menu-group">
                    <button type="button" className="menu-item" onClick={() => setSourcePickerOpen(true)}>
                        <MemorySettingsIcon icon={Filter} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">记忆来源</span>
                            <span className="menu-desc">选择哪些内容参与记忆</span>
                        </div>
                        <div className="menu-right">
                            <span className="menu-desc mr-1">{disabledSourceCount === 0 ? "全部开启" : `已关闭 ${disabledSourceCount} 项`}</span>
                            <ChevronRight size={16} />
                        </div>
                    </button>
                </div>

                {sourcePickerOpen ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSourcePickerOpen(false)}>
                        <div className="modal-sheet memory-source-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <span style={{ width: 28 }} />
                                <h3 className="modal-title">记忆来源</h3>
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSourcePickerOpen(false)}><X size={18} /></button>
                            </div>
                            <div className="modal-body modal-body-tight" data-ui="modal-body">
                                <div className="memory-source-chips" style={{ "--chip-accent": BINDING_ACCENTS.memory } as CSSProperties}>
                                    {MEMORY_SOURCE_OPTIONS.map(source => {
                                        const allowed = config.shortTermAllowedSources ?? {};
                                        const isChecked = allowed[source.key] !== false;
                                        return (
                                            <button
                                                key={source.key}
                                                type="button"
                                                className="memory-source-chip"
                                                data-off={isChecked ? undefined : ""}
                                                aria-pressed={isChecked}
                                                onClick={() => {
                                                    const next = {
                                                        ...config,
                                                        shortTermAllowedSources: { ...allowed, [source.key]: !isChecked },
                                                    };
                                                    setConfig(next);
                                                    saveMemoryConfig(next);
                                                }}
                                            >
                                                {source.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Feature toggles */}
                <p className="menu-group-desc mx-2">自动化</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Clock} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数自动将新事件整理为长期记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoSummarizeEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoSummarizeEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">核心记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数长期记忆，自动整理为核心记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoBuildCoreEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoBuildCoreEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Search} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">向量召回</span>
                            <span className="menu-desc">通过 Embedding 向量与关键词混合打分，按相关性精筛长期记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.vectorRecallEnabled ?? true} onChange={(v) => {
                                const next = { ...config, vectorRecallEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    {(config.vectorRecallEnabled ?? true) && (
                        <>
                            <MemorySettingsSliderItem
                                icon={Search}
                                color={BINDING_ACCENTS.embedding}
                                label="向量召回上限 (Top-K)"
                                desc="单次最多筛选注入的相关长期记忆条数（注入时先按日期、再按重要性排序）"
                                value={config.vectorRecallTopK ?? 15}
                                min={5}
                                max={50}
                                step={1}
                                onChange={value => {
                                    const next = { ...config, vectorRecallTopK: Math.min(50, Math.max(5, Math.round(value))) };
                                    setConfig(next);
                                    saveMemoryConfig(next);
                                }}
                            />
                            <MemorySettingsSliderItem
                                icon={Filter}
                                color={BINDING_ACCENTS.embedding}
                                label="相关性最低阈值 (%)"
                                desc="混合得分低于此比例的无关记忆将被过滤（重要性 ≥ 9 的重大记忆豁免保底）"
                                value={Math.round((config.vectorMinScore ?? 0.38) * 100)}
                                min={15}
                                max={75}
                                step={5}
                                onChange={value => {
                                    const next = {
                                        ...config,
                                        vectorMinScore: Number((Math.min(75, Math.max(15, Math.round(value))) / 100).toFixed(2)),
                                    };
                                    setConfig(next);
                                    saveMemoryConfig(next);
                                }}
                            />
                        </>
                    )}
                </div>

                {/* Token budget sliders */}
                <p className="menu-group-desc mx-2">控制截断量</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Users}
                        color={BINDING_ACCENTS.voice}
                        label="短期记忆+最近上下文"
                        desc="聊天历史、朋友圈、群聊与跨应用近期事件截断量"
                        value={config.shortTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.shortTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.shortTermTokenBudget}
                        onChange={value => saveBudget("shortTermTokenBudget", value)}
                    />
                    <button type="button" className="menu-item" onClick={() => setAppBudgetOpen(true)}>
                        <MemorySettingsIcon icon={SlidersHorizontal} color={BINDING_ACCENTS.voice} />
                        <div className="menu-label-group">
                            <span className="menu-label">分应用短期记忆</span>
                            <span className="menu-desc">给某个应用单独设一个截断量，不影响其它应用</span>
                        </div>
                        <div className="menu-right">
                            <span className="menu-desc mr-1">{customAppBudgetCount === 0 ? "全部跟随默认" : `已单独设 ${customAppBudgetCount} 项`}</span>
                            <ChevronRight size={16} />
                        </div>
                    </button>
                    <MemorySettingsSliderItem
                        icon={Archive}
                        color={BINDING_ACCENTS.memory}
                        label="长期记忆"
                        desc="总结记忆注入量"
                        value={config.longTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.longTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.longTermTokenBudget}
                        onChange={value => saveBudget("longTermTokenBudget", value)}
                    />
                    <MemorySettingsSliderItem
                        icon={Brain}
                        color={BINDING_ACCENTS.embedding}
                        label="核心记忆"
                        desc="高优先级里程碑注入量"
                        value={config.coreMemoryTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.coreMemoryTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.coreMemoryTokenBudget}
                        onChange={value => saveBudget("coreMemoryTokenBudget", value)}
                    />
                </div>

                {appBudgetOpen ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setAppBudgetOpen(false)}>
                        <div className="modal-sheet memory-app-budget-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <span style={{ width: 28 }} />
                                <h3 className="modal-title">分应用短期记忆</h3>
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => setAppBudgetOpen(false)}><X size={18} /></button>
                            </div>
                            <div className="modal-body" data-ui="modal-body">
                                <p className="memory-app-budget-hint">拖动某一行就变成单独配置，点「跟随默认」再交回上面那个总开关。</p>
                                <div className="memory-app-budget-list" style={{ "--chip-accent": BINDING_ACCENTS.voice } as CSSProperties}>
                                    {SHORT_TERM_BUDGET_APP_KEYS.map(key => (
                                        <MemoryAppBudgetRow
                                            key={key}
                                            label={shortTermBudgetAppLabel(key)}
                                            override={appBudgetOverrides[key]}
                                            fallback={config.shortTermTokenBudget}
                                            min={MEMORY_TOKEN_BUDGET_MIN.shortTermTokenBudget}
                                            max={MEMORY_TOKEN_BUDGET_MAX}
                                            step={MEMORY_TOKEN_BUDGET_STEP.shortTermTokenBudget}
                                            onChange={value => saveAppBudget(key, value)}
                                            onReset={() => saveAppBudget(key, null)}
                                        />
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Summarization interval */}
                <p className="menu-group-desc mx-2">自动总结间隔</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Clock}
                        color={BINDING_ACCENTS.api}
                        label="总结间隔"
                        desc="每 N 条事件自动触发总结"
                        value={config.summarizationEventInterval ?? 50}
                        min={10}
                        max={200}
                        step={10}
                        onChange={saveInterval}
                    />
                    <MemorySettingsSliderItem
                        icon={Brain}
                        color={BINDING_ACCENTS.embedding}
                        label="核心记忆总结间隔"
                        desc="每 N 条长期记忆自动触发核心记忆总结"
                        value={config.coreSummarizationInterval ?? 5}
                        min={1}
                        max={20}
                        step={1}
                        onChange={saveCoreInterval}
                    />
                </div>

                {/* Summarization Prompt Editor */}
                <p className="menu-group-desc mx-2">长期记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.preset} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{earliest}}"} 起始时间、{"{{latest}}"} 结束时间、{"{{events}}"} 记录集合
                            </span>
                        </div>
                        {!isDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetPrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentPrompt}
                            onChange={e => setEditingPrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {isModified && (
                            <button
                                onClick={handleSavePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Zap size={14} className="mr-1.5" /> 保存提词配置
                            </button>
                        )}
                    </div>
                </div>

                <p className="menu-group-desc mx-2">核心记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">核心记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{earliest}}"} 起始时间、{"{{latest}}"} 结束时间、{"{{previous}}"} 上一轮核心记忆、{"{{events}}"} 长期记忆集合
                            </span>
                        </div>
                        {!isCoreDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetCorePrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentCorePrompt}
                            onChange={e => setEditingCorePrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {isCoreModified && (
                            <button
                                onClick={handleSaveCorePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Archive size={14} className="mr-1.5" /> 保存核心记忆提词配置
                            </button>
                        )}
                    </div>
                </div>

                {/* 事件盒提示词编辑器：事件盒功能已停用，配置入口一并移除（旧配置值原样留在存档里，不影响任何流程） */}
                {false && (
                <>
                <p className="menu-group-desc mx-2">事件盒提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Folder} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">事件盒总结提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{title}}"} 事件盒名称、{"{{earliest}}"} 起始时间、
                                {"{{latest}}"} 结束时间、{"{{previousDigestSection}}"} 先前总结、{"{{events}}"} 本次事件记录
                            </span>
                        </div>
                        {!isEventBoxDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetEventBoxPrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentEventBoxPrompt}
                            onChange={e => setEditingEventBoxPrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        <p className="ts-11 text-secondary" style={{ margin: 0 }}>
                            末尾必须保留「**事件标题** / **重要性** / **检索关键词**」三行输出要求，否则总结后无法自动更新盒名、重要性与向量。
                        </p>
                        {isEventBoxModified && (
                            <button
                                onClick={handleSaveEventBoxPrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Zap size={14} className="mr-1.5" /> 保存事件盒提词配置
                            </button>
                        )}
                    </div>
                </div>
                </>
                )}

            </div>
        );
    }

    // ── Character List View ──
    return (
        <div className="mem-picker">
            <div className="mem-picker-card">
                <p className="mem-picker-cover-title">Every moment we shared becomes a timeless memory</p>
                <div className="mem-picker-divider"><span>✦</span></div>
                <div className="mem-picker-cover-wrap">
                    {"MEMORY".split("").map((ch, i) => (
                        <span key={i} className={`mem-picker-cover-letter mem-picker-letter-${i}`}>{ch}</span>
                    ))}
                    <div className="mem-picker-cover-clip">
                        {(() => {
                            const coverSrc = pickedCharId
                                ? (characters.find(c => c.character.id === pickedCharId)?.character.avatar || "")
                                : (resolveUserIdentity()?.avatarUrl || "");
                            return coverSrc ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={coverSrc}
                                    alt=""
                                    className="mem-picker-cover"
                                    draggable={false}
                                />
                            ) : null;
                        })()}
                    </div>
                </div>

                <div className="mem-picker-body">
                    <p className="mem-picker-prompt">
                        你想查看谁的记忆呢？<br />
                        <span className="mem-picker-hint">点击TA的卡片查看吧</span>
                    </p>

                    {/* 角色选择：方框下拉（原来是一排人名按钮）。点方框展开并变成检索输入框，
                        列表固定露 4.5 行，超出部分上下滑动 */}
                    {(() => {
                        const keyword = charPickerQuery.trim().toLowerCase();
                        const pickedName = pickedCharId
                            ? characters.find(item => item.character.id === pickedCharId)?.character.name ?? ""
                            : "";
                        const visibleChars = keyword
                            ? characters.filter(item => item.character.name.toLowerCase().includes(keyword))
                            : characters;
                        return (
                            <div className="mem-char-select">
                                {charPickerOpen ? (
                                    <div className="mem-char-field is-open">
                                        <Search size={15} strokeWidth={1.8} className="mem-char-field-icon" />
                                        <input
                                            type="text"
                                            className="mem-char-input"
                                            value={charPickerQuery}
                                            placeholder="输入人名检索…"
                                            aria-label="检索角色人名"
                                            autoFocus
                                            onChange={event => setCharPickerQuery(event.target.value)}
                                        />
                                        <button
                                            type="button"
                                            className="mem-char-field-toggle"
                                            aria-label="收起人名列表"
                                            onClick={() => {
                                                setCharPickerOpen(false);
                                                setCharPickerQuery("");
                                            }}
                                        >
                                            <ChevronDown size={16} strokeWidth={1.8} className="mem-char-chevron is-open" />
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className={`mem-char-field${pickedName ? "" : " is-placeholder"}`}
                                        onClick={() => setCharPickerOpen(true)}
                                    >
                                        <span className="mem-char-value">{pickedName || "请选择…"}</span>
                                        <ChevronDown size={16} strokeWidth={1.8} className="mem-char-chevron" />
                                    </button>
                                )}

                                {charPickerOpen && (
                                    <div className="mem-char-dropdown" role="listbox" aria-label="角色人名列表">
                                        {visibleChars.length === 0 ? (
                                            <p className="mem-char-empty">没有匹配的人名</p>
                                        ) : (
                                            visibleChars.map(({ character }) => (
                                                <button
                                                    key={character.id}
                                                    type="button"
                                                    role="option"
                                                    aria-selected={pickedCharId === character.id}
                                                    className={`mem-char-option${pickedCharId === character.id ? " is-selected" : ""}`}
                                                    onClick={() => {
                                                        setPickedCharId(character.id);
                                                        setCharPickerOpen(false);
                                                        setCharPickerQuery("");
                                                    }}
                                                >
                                                    <span className="mem-char-option-name">{character.name}</span>
                                                    {pickedCharId === character.id && (
                                                        <Check size={14} strokeWidth={2} className="mem-char-option-check" />
                                                    )}
                                                </button>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    <div className="mem-picker-tear">
                        <div className="mem-picker-tear-line"><span>✦</span></div>
                    </div>

                    <div className="mem-picker-action">
                        <button
                            className="ui-chip ui-chip-lg"
                            {...(pickedCharId ? { "data-selected": "" } : {})}
                            onClick={() => pickedCharId && handleSelectChar(loadCharacters().find(c => c.id === pickedCharId)!)}
                        >
                            查看TA的记忆
                        </button>
                    </div>

                    <div className="mem-picker-footer">
                        <span>OBSERVER · 记忆观察员</span>
                        <span>{characters.length} PROFILES · {characters.reduce((s, c) => s + c.shortTermCount + c.coreCount + c.longTermCount, 0)} RECORDS</span>
                        <span>{new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
