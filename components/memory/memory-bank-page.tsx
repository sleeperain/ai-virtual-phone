"use client";

import { Component, useState, useEffect, useCallback, type CSSProperties, type ReactNode } from "react";
import { Trash2, Zap, Clock, Users, Archive, AlertCircle, Search, Brain, FileText, MoreHorizontal, Plus, Edit3, X, Check, ChevronRight, Filter, SlidersHorizontal, Sparkles, type LucideIcon } from "lucide-react";
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
    type CleanedManualMemoryDraft,
} from "@/lib/memory-summarizer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { runCoreMemoryPipeline } from "@/lib/core-memory-builder";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "@/lib/settings-storage";
import {
    generateEmbedding,
    generateEmbeddingsBatch,
    resolveEmbeddingModel,
    searchMemories,
    getLastObservedEmbeddingDim,
} from "@/lib/memory-embedding";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";

type MemoryView = "list" | "detail" | "settings";
type MemoryTab = "short" | "shared" | "core" | "long";
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
    cleanedDrafts?: MemoryEditorDraftItem[];
};

function getLocalTodayKey(): string {
    const now = new Date();
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatEntryDateLabel(entry: MemoryEntry): string {
    const eventDate = typeof entry.metadata?.eventDate === "string" ? entry.metadata.eventDate.trim() : "";
    const d = new Date(entry.createdAt);
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    const createdDate = !isNaN(d.getTime())
        ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
        : entry.createdAt.slice(0, 16);
    if (eventDate) {
        return `事件日期: ${eventDate} · 入库: ${createdDate}`;
    }
    return `入库: ${createdDate}`;
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
    const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<string | null>(null);
    const [confirmClearAll, setConfirmClearAll] = useState(false);
    const [pickedCharId, setPickedCharId] = useState<string | null>(null);
    const [entryMenuId, setEntryMenuId] = useState<string | null>(null);
    const [memoryEditor, setMemoryEditor] = useState<MemoryEditorState | null>(null);
    const [savingMemory, setSavingMemory] = useState(false);
    const [embeddingAll, setEmbeddingAll] = useState(false);
    const [cleaningManualText, setCleaningManualText] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchingVectors, setSearchingVectors] = useState(false);
    const [searchScoreMap, setSearchScoreMap] = useState<Record<string, number> | null>(null);
    const [summarizeRangeOpen, setSummarizeRangeOpen] = useState(false);
    const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
    const [appBudgetOpen, setAppBudgetOpen] = useState(false);

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
            const [core, lt] = await Promise.all([
                loadMemoryEntriesByType(charId, "core"),
                loadMemoryEntriesByType(charId, "long_term"),
            ]);
            setCoreEntries(core);
            setLongTermEntries(lt);
        } catch {
            setCoreEntries([]);
            setLongTermEntries([]);
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
        }
    }, [view]);

    const handleSelectChar = (char: Character) => {
        onSelectChar(char.id);
    };

    const handleDeleteEntry = async (id: string) => {
        await deleteMemoryEntry(id);
        setCoreEntries(prev => prev.filter(e => e.id !== id));
        setLongTermEntries(prev => prev.filter(e => e.id !== id));
        setEntryMenuId(null);
        loadCharacterList();
    };

    const handleClearEntries = async (type: "core" | "long_term") => {
        if (!selectedCharId) return;
        await deleteCharacterMemoriesByType(selectedCharId, type);
        if (type === "core") setCoreEntries([]);
        else setLongTermEntries([]);
        loadCharacterList();
    };

    const showNotice = (msg: string) => {
        onNotice?.(msg);
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
            const longTermEntries = await loadMemoryEntriesByType(selectedCharId, "long_term");
            const pendingLongTermCount = longTermEntries.filter(entry =>
                !lastCoreSummarizedAt || entry.createdAt > lastCoreSummarizedAt
            ).length;
            if (pendingLongTermCount === 0) {
                showNotice(lastCoreSummarizedAt ? "没有新的长期记忆需要总结" : "没有可用于总结核心记忆的长期记忆");
                return;
            }

            const result = await runCoreMemoryPipeline(selectedCharId, selectedChar?.name ?? "");
            if (result.success) {
                showNotice(result.rebuiltCount ? `核心记忆已重建（${result.rebuiltCount}条）` : "核心记忆已重建");
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
        const missing = longTermEntries.filter(e => !isEntryVectorValid(e));
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

    const handleRunVectorSearchTest = async () => {
        const q = searchQuery.trim();
        if (!q) {
            setSearchScoreMap(null);
            return;
        }
        const pool = activeTab === "core" ? coreEntries : longTermEntries;
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
            showNotice(`记忆内容过长，请控制在 ${MANUAL_MEMORY_CONTENT_LIMIT} 字以内（或点击「AI 清洗与拆分」拆分为多条）`);
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

    const renderMemoryEntries = (type: MemoryEntry["type"], entries: MemoryEntry[], emptyText: string) => {
        const label = type === "core" ? "核心记忆" : "长期记忆";
        const missingVectorCount = type === "long_term"
            ? entries.filter(e => !isEntryVectorValid(e)).length
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
                        <div className="mem-entry-toolbar" style={{ flexWrap: "wrap" }}>
                            <button
                                className="mem-entry-add-btn"
                                onClick={() => openCreateMemoryEditor(type)}
                            >
                                <Plus size={15} strokeWidth={1.8} />
                                <span>新增{label}</span>
                            </button>
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
                                onClick={() => setConfirmClearAll(true)}
                            >
                                <Trash2 size={15} strokeWidth={1.8} />
                                <span>清除{label}</span>
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

                        return (
                            <div
                                key={entry.id}
                                className={`g-card memory-report-card${entryMenuId === entry.id ? " is-menu-open" : ""}`}
                                onClick={() => {
                                    if (entryMenuId) {
                                        setEntryMenuId(null);
                                        return;
                                    }
                                    setExpandedId(isExpanded ? null : entry.id);
                                }}
                            >
                                <div className="mem-report-head">
                                    <span className="ts-11 text-secondary" style={{ letterSpacing: "0.5px" }}>
                                        [ {formatEntryDateLabel(entry)} ]
                                    </span>
                                    <div className="mem-report-actions">
                                        {typeof matchScore === "number" && (
                                            <span className="mem-stat-pill is-vector-ok" style={{ fontWeight: 700 }}>
                                                匹配度 {Math.round(Math.min(1, matchScore) * 100)}%
                                            </span>
                                        )}
                                        <span className={`mem-origin-badge ${isManualMemoryEntry(entry) ? "is-manual" : ""}`}>
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
                                                    <button
                                                        className="is-danger"
                                                        onClick={() => {
                                                            setEntryMenuId(null);
                                                            setConfirmDeleteEntryId(entry.id);
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
                                <div className="ts-12 leading-[1.7] mem-markdown-body chat-markdown">
                                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                                        {displayMarkdown}
                                    </ReactMarkdown>
                                </div>
                                <div className="mem-structured-footer">
                                    <div className="mem-stats-row">
                                        <span className="mem-stat-pill">
                                            重要性 <strong>{importanceScore}/10</strong>
                                        </span>
                                        <span className="mem-stat-pill">
                                            访问次数 <strong>{accessCount}</strong>
                                        </span>
                                        {type === "long_term" && (
                                            <span className={`mem-stat-pill ${vectorValid ? "is-vector-ok" : "is-vector-missing"}`}>
                                                {vectorValid
                                                    ? `● 已向量化(${entry.embedding!.length}d)`
                                                    : dimMismatch
                                                        ? "◐ 维度不符(可重算)"
                                                        : "○ 未向量化"}
                                            </span>
                                        )}
                                    </div>
                                    <div className="mem-keywords-row">
                                        <span className="mem-keywords-label">检索关键词：</span>
                                        {keywords.length > 0 ? (
                                            keywords.map((kw, idx) => (
                                                <span key={idx} className="mem-keyword-chip">{kw}</span>
                                            ))
                                        ) : (
                                            <span className="mem-keywords-empty">未设置（点右上角编辑可补充）</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })
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
                    ) : activeTab === "core" ? (
                        renderMemoryEntries("core", coreEntries, "暂无核心记忆。长期记忆累计到设定条数后会自动提炼，也可以手动新增。")
                    ) : (
                        /* ── Long-term: Summarized Memories ── */
                        renderMemoryEntries("long_term", longTermEntries, "暂无长期记忆。点击设置页的手动总结，或直接新增一条记忆。")
                    )}
                    </MemoryDetailBoundary>
                </div>

                {/* Bottom tab bar — floating above bottom */}
                <div className="chat-tab-bar" style={{ position: "absolute", bottom: 40, left: 40, right: 40, zIndex: 10, borderRadius: 28, borderTop: "none", padding: "10px 0" }}>
                    {([
                        { key: "short" as const, icon: Clock, label: "短期" },
                        { key: "shared" as const, icon: Users, label: "共享事件" },
                        { key: "long" as const, icon: Archive, label: "长期" },
                        { key: "core" as const, icon: Archive, label: "核心" },
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
                        : "可直接输入单条记忆，或粘贴多段长文本/跨天记录，点击下方「AI 清洗与拆分」自动拆成独立记忆并提取日期。";
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
                                                    已拆分为 <strong>{memoryEditor.cleanedDrafts!.length}</strong> 条独立记忆（可逐条核对或修改事件日期）
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
                                                            placeholder="检索关键词（用顿号分隔）"
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
                                            <div className="flex justify-between items-center" style={{ gap: 8, flexWrap: "wrap" }}>
                                                <button
                                                    type="button"
                                                    className="ui-btn ui-btn-outline py-1.5 px-3 ts-12"
                                                    onClick={() => void handleCleanManualText()}
                                                    disabled={savingMemory || cleaningManualText || !contentLength}
                                                    title="调用 API 将长文本自动清洗、按独立话题拆分为多条记忆，并提取事件日期与关键词"
                                                >
                                                    <Sparkles size={13} className="mr-1" />
                                                    {cleaningManualText ? "AI 清洗拆分中..." : "AI 清洗与拆分（自动提日期/关键词）"}
                                                </button>
                                                <div className={`mem-edit-footer ${overLimit ? "is-over-limit" : ""}`} style={{ margin: 0 }}>
                                                    <span>{contentLength}/{MANUAL_MEMORY_CONTENT_LIMIT}</span>
                                                </div>
                                            </div>
                                            <div className="mem-edit-meta-fields">
                                                <div className="mem-edit-field-row" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                                    <label className="mem-edit-field-label" style={{ margin: 0 }}>
                                                        事件日期（文本含日期会自动识别，也可手动修改）
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
                                                    <label className="mem-edit-field-label">重要性：{memoryEditor.importance}/10（权重越高，注入时越靠前）</label>
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
                                                    <label className="mem-edit-field-label">检索关键词（用顿号或逗号分隔）</label>
                                                    <input
                                                        type="text"
                                                        className="ui-input ts-12"
                                                        value={memoryEditor.keywordsText}
                                                        placeholder="例如：窄门、法语、银翼杀手、约定"
                                                        disabled={savingMemory || cleaningManualText}
                                                        onChange={e => setMemoryEditor(prev => prev ? { ...prev, keywordsText: e.target.value } : prev)}
                                                    />
                                                </div>
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

                {/* Confirm delete single entry */}
                {confirmDeleteEntryId && (
                    <ConfirmDialog
                        title="确认删除？"
                        message="删除记忆条目后无法恢复。是否继续？"
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认删除"
                        onConfirm={() => {
                            handleDeleteEntry(confirmDeleteEntryId);
                            setConfirmDeleteEntryId(null);
                        }}
                        onCancel={() => setConfirmDeleteEntryId(null)}
                    />
                )}

                {/* Confirm clear all long-term entries */}
                {confirmClearAll && (
                    <ConfirmDialog
                        title="确认清除？"
                        message={activeTab === "core" ? "将清除该角色所有核心记忆，此操作无法恢复。" : "将清除该角色所有长期记忆，此操作无法恢复。"}
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认清除"
                        onConfirm={() => {
                            handleClearEntries(activeTab === "core" ? "core" : "long_term");
                            setConfirmClearAll(false);
                        }}
                        onCancel={() => setConfirmClearAll(false)}
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
                                变量：{"{{char}}"} 角色、{"{{earliest}}"} 起始时间、{"{{latest}}"} 结束时间、{"{{events}}"} 长期记忆集合
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

                    <div className="mem-picker-chips">
                        {characters.map(({ character }) => (
                            <button
                                key={character.id}
                                className="ui-chip"
                                {...(pickedCharId === character.id ? { "data-selected": "" } : {})}
                                onClick={() => setPickedCharId(pickedCharId === character.id ? null : character.id)}
                            >
                                {character.name}
                            </button>
                        ))}
                    </div>

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
