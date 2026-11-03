// lib/memory-event-boxes.ts
// 事件盒（Event Boxes）：把围绕同一件事的长期记忆放在一起管理。
//
// 盒内三层结构：
//   1. 先前事件的总结（digestEntry：由用户在盒内手动点击「总结」生成，自动完成向量化，代表已归档事件参与召回）
//   2. 新事件（已放入该事件盒、但尚未被总结归档的长期记忆，正常参与召回）
//   3. 已归档事件（已被手动总结吸收过的原始长期记忆，在事件盒下方显示「已归档」，不再重复注入 Prompt，但仍保留在主列表和盒内，随时可恢复）

import type { MemoryEntry } from "./memory-types";
import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";
import { saveMemoryEntry, deleteMemoryEntry } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity, keywordOverlapRatio } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { resolveSummarizationApiConfig, extractMemoryStructuredMeta, stripMemoryStructuredSections } from "./memory-summarizer";

export const EVENT_BOX_KV_PREFIX = "ai_phone_memory_boxes_";
registerDynamicPrefix(EVENT_BOX_KV_PREFIX);

export type EventBoxStatus = "active" | "settled" | "pivotal";

export const EVENT_BOX_STATUS_META: Record<EventBoxStatus, { label: string; hint: string }> = {
    active: { label: "进行中", hint: "这件事还在继续发展，后续还会有新进展" },
    settled: { label: "已完结", hint: "这件事已经告一段落" },
    pivotal: { label: "重要转折", hint: "对关系或设定有长期影响的关键事件" },
};

export type EventBoxDigestVersion = {
    version: number;
    text: string;
    sourceIds: string[];
    generatedAt: string;
};

export type MemoryEventBox = {
    id: string;
    characterId: string;
    title: string;
    note?: string;
    status: EventBoxStatus;
    keywords?: string[];
    createdAt: string;
    updatedAt: string;
    /** 摘要记忆条目在 memories 表里的 id */
    digestEntryId?: string;
    /** 历史总结记录 */
    digestHistory?: EventBoxDigestVersion[];
};

export const EVENT_BOX_META_KEYS = {
    /** 记忆所属的事件盒 ID */
    boxId: "eventBoxId",
    /** 标记该记忆是某个事件盒生成的「先前事件的总结」 */
    digestOf: "eventBoxDigestOf",
    /** 标记该记忆在事件盒中已被总结归档（值为事件盒 ID） */
    archivedInto: "eventBoxArchivedInto",
    /** 归档时间戳 */
    archivedAt: "eventBoxArchivedAt",
} as const;

function boxStorageKey(characterId: string): string {
    return `${EVENT_BOX_KV_PREFIX}${characterId}`;
}

function normalizeStatus(raw: unknown): EventBoxStatus {
    return raw === "settled" || raw === "pivotal" ? raw : "active";
}

function normalizeBox(raw: unknown, characterId: string): MemoryEventBox | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Partial<MemoryEventBox>;
    if (typeof item.id !== "string" || !item.id) return null;
    if (typeof item.title !== "string" || !item.title.trim()) return null;
    const now = new Date().toISOString();
    return {
        id: item.id,
        characterId,
        title: item.title.trim(),
        note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined,
        status: normalizeStatus(item.status),
        keywords: Array.isArray(item.keywords) ? item.keywords.map(String).map(s => s.trim()).filter(Boolean) : undefined,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
        digestEntryId: typeof item.digestEntryId === "string" && item.digestEntryId ? item.digestEntryId : undefined,
        digestHistory: Array.isArray(item.digestHistory) ? item.digestHistory : undefined,
    };
}

export function loadEventBoxes(characterId: string): MemoryEventBox[] {
    if (!characterId) return [];
    try {
        const raw = kvGet(boxStorageKey(characterId));
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const list: MemoryEventBox[] = [];
        for (const item of parsed) {
            const box = normalizeBox(item, characterId);
            if (box) list.push(box);
        }
        return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
        return [];
    }
}

export function saveEventBoxes(characterId: string, boxes: MemoryEventBox[]): void {
    if (!characterId) return;
    kvSet(boxStorageKey(characterId), JSON.stringify(boxes));
}

export function createEventBox(
    characterId: string,
    title: string,
    status: EventBoxStatus = "active",
    note?: string,
    keywords?: string[],
): MemoryEventBox {
    const now = new Date().toISOString();
    const cleanKws = Array.isArray(keywords) ? keywords.map(s => s.trim()).filter(Boolean) : [];
    const box: MemoryEventBox = {
        id: `box_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        title: title.trim() || "未命名事件",
        note: note?.trim() || undefined,
        status,
        ...(cleanKws.length > 0 ? { keywords: cleanKws } : {}),
        createdAt: now,
        updatedAt: now,
    };
    const existing = loadEventBoxes(characterId);
    saveEventBoxes(characterId, [box, ...existing]);
    return box;
}

export function updateEventBox(
    characterId: string,
    boxId: string,
    patch: Partial<Pick<MemoryEventBox, "title" | "note" | "status" | "keywords" | "digestEntryId" | "digestHistory">>,
): MemoryEventBox[] {
    const now = new Date().toISOString();
    const next = loadEventBoxes(characterId).map(box =>
        box.id === boxId ? { ...box, ...patch, updatedAt: now } : box
    );
    saveEventBoxes(characterId, next);
    return next;
}

// ── 条目元数据判定工具 ──────────────────────────────────────

export function getEntryBoxId(entry: MemoryEntry): string {
    const v = entry.metadata?.[EVENT_BOX_META_KEYS.boxId];
    return typeof v === "string" ? v : "";
}

export function isEntryBoxDigest(entry: MemoryEntry): boolean {
    const v = entry.metadata?.[EVENT_BOX_META_KEYS.digestOf];
    return typeof v === "string" && v.length > 0;
}

export function isEntryArchived(entry: MemoryEntry): boolean {
    const v = entry.metadata?.[EVENT_BOX_META_KEYS.archivedInto];
    return typeof v === "string" && v.length > 0;
}

/**
 * 过滤可参与 Prompt 召回的记忆条目：
 * - 未归档的条目（含盒内「新事件」、盒外普通记忆、以及事件盒生成的「先前事件总结」digestEntry）正常召回
 * - 已归档的原始条目不再重复注入 Prompt（由对应的事件盒总结条目代表），但如果该事件盒的总结条目被删或不存在，自动兜底放行，绝不丢记忆
 */
export function filterRecallableEntries(entries: MemoryEntry[]): MemoryEntry[] {
    const digestBoxIds = new Set<string>();
    for (const entry of entries) {
        if (isEntryBoxDigest(entry)) {
            const boxId = String(entry.metadata?.[EVENT_BOX_META_KEYS.digestOf] ?? "");
            if (boxId) digestBoxIds.add(boxId);
        }
    }
    return entries.filter(entry => {
        if (!isEntryArchived(entry)) return true;
        const archivedBoxId = String(entry.metadata?.[EVENT_BOX_META_KEYS.archivedInto] ?? "");
        // 只有当该盒子确实存在总结条目时，才由总结条目代替；否则兜底保留原文召回
        return !digestBoxIds.has(archivedBoxId);
    });
}

export function entryDateKey(entry: MemoryEntry): string {
    const eventDate = typeof entry.metadata?.eventDate === "string" ? entry.metadata.eventDate.trim() : "";
    if (eventDate) return eventDate;
    return entry.createdAt.slice(0, 10);
}

/**
 * 拆解某个事件盒内的三层数据：
 * 1. digestEntry: 先前事件的总结（1条或undefined）
 * 2. newEntries: 新事件（放入盒内、尚未总结归档的记忆，按日期从近到远）
 * 3. archivedEntries: 已归档事件（已被总结吸收的记忆，按日期从近到远）
 */
export function getBoxLayers(entries: MemoryEntry[], box: MemoryEventBox): {
    digestEntry: MemoryEntry | undefined;
    newEntries: MemoryEntry[];
    archivedEntries: MemoryEntry[];
    allMemberEntries: MemoryEntry[];
} {
    const digestEntry = entries.find(
        e => (box.digestEntryId && e.id === box.digestEntryId) || e.metadata?.[EVENT_BOX_META_KEYS.digestOf] === box.id
    );
    const allMemberEntries = entries
        .filter(e => getEntryBoxId(e) === box.id && !isEntryBoxDigest(e))
        .sort((a, b) => {
            const da = entryDateKey(a);
            const db = entryDateKey(b);
            if (da !== db) return db.localeCompare(da);
            return b.createdAt.localeCompare(a.createdAt);
        });
    const newEntries = allMemberEntries.filter(e => !isEntryArchived(e));
    const archivedEntries = allMemberEntries.filter(e => isEntryArchived(e));
    return { digestEntry, newEntries, archivedEntries, allMemberEntries };
}

export function formatBoxSpan(entries: MemoryEntry[]): string {
    if (entries.length === 0) return "";
    const dates = entries.map(entryDateKey).filter(Boolean).sort();
    if (dates.length === 0) return "";
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (first === last) return first;
    if (first.slice(0, 4) === last.slice(0, 4)) {
        return `${first} ~ ${last.slice(5)}`;
    }
    return `${first} ~ ${last}`;
}

// ── 条目进出事件盒操作（仅改归属，绝不自动总结）──────────────────

export async function moveEntryToBox(entry: MemoryEntry, boxId: string): Promise<MemoryEntry> {
    const metadata: Record<string, unknown> = {
        ...(entry.metadata ?? {}),
        [EVENT_BOX_META_KEYS.boxId]: boxId,
    };
    // 如果从别的盒子移过来，清除旧盒子的归档状态，作为当前盒子的「新事件」
    if (entry.metadata?.[EVENT_BOX_META_KEYS.archivedInto] && entry.metadata?.[EVENT_BOX_META_KEYS.archivedInto] !== boxId) {
        delete metadata[EVENT_BOX_META_KEYS.archivedInto];
        delete metadata[EVENT_BOX_META_KEYS.archivedAt];
    }
    const next: MemoryEntry = {
        ...entry,
        updatedAt: new Date().toISOString(),
        metadata,
    };
    await saveMemoryEntry(next);
    updateEventBox(entry.characterId, boxId, {});
    return next;
}

export async function removeEntryFromBox(entry: MemoryEntry): Promise<MemoryEntry> {
    const metadata: Record<string, unknown> = { ...(entry.metadata ?? {}) };
    delete metadata[EVENT_BOX_META_KEYS.boxId];
    delete metadata[EVENT_BOX_META_KEYS.archivedInto];
    delete metadata[EVENT_BOX_META_KEYS.archivedAt];
    const next: MemoryEntry = {
        ...entry,
        updatedAt: new Date().toISOString(),
        metadata,
    };
    await saveMemoryEntry(next);
    return next;
}

/** 将已归档的单条记忆取消归档，移回「新事件」层 */
export async function unarchiveSingleBoxEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    const metadata: Record<string, unknown> = { ...(entry.metadata ?? {}) };
    delete metadata[EVENT_BOX_META_KEYS.archivedInto];
    delete metadata[EVENT_BOX_META_KEYS.archivedAt];
    const next: MemoryEntry = {
        ...entry,
        updatedAt: new Date().toISOString(),
        metadata,
    };
    await saveMemoryEntry(next);
    return next;
}

// ── 手动总结事件盒（生成/更新「先前事件的总结」+ 自动向量化 + 原记忆归档）──

export const DEFAULT_EVENT_BOX_SUMMARY_PROMPT = `你是一个角色记忆整理助手。下面是{{char}}与用户围绕「{{title}}」这件事的记忆记录。
请将它们整合总结为一段脉络清晰、事实准确的阶段性事件总结。

角色：{{char}}
事件主题：{{title}}
时间跨度：{{earliest}} 至 {{latest}}
{{previousDigestSection}}
本次需要并入的事件记录（按时间从早到晚）：
{{events}}

严格要求：
1. **融合先前总结与新进展**：如果有「先前事件的总结」，必须保留其中的关键背景、约定与结论，并将新事件的发展自然衔接进去；若新进展推翻或改变了旧状态，以最新进展为准。
2. **严禁编造**：只整合已有记录，绝不虚构任何未发生的细节。
3. **正文不写具体日期时间戳**（系统会自动标注时间跨度）。
4. **第三人称客观叙述**，控制在 100～260 字之间，一段话讲清楚前因后果与当前状态。
5. **末尾固定输出两行元数据**（用于检索与向量化）：
**重要性**：（1-10的整数）
**检索关键词**：关键词1、关键词2、关键词3、关键词4`;

function uniqueKeywords(items: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
        const t = item.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

function readEntryKeywords(entry: MemoryEntry): string[] {
    if (Array.isArray(entry.metadata?.keywords) && entry.metadata.keywords.length > 0) {
        return entry.metadata.keywords.map(String).filter(Boolean);
    }
    return extractMemoryStructuredMeta(entry.content).keywords;
}

/**
 * 用户在事件盒内手动点击「总结新事件 / 更新总结」：
 * - 读取「先前事件的总结」（若有）+ 盒内「新事件」（若无新事件但用户点重新总结，则读取盒内全部事件）
 * - 调用 LLM 生成新的「先前事件的总结」
 * - 立即自动生成 Embedding 向量（拼接检索关键词 + 正文）
 * - 把本次参与总结的条目打上 archivedInto 标记，移入事件盒下方的「已归档事件」
 */
export async function summarizeEventBoxManually(
    characterId: string,
    characterName: string,
    boxId: string,
    allLongTermEntries: MemoryEntry[],
): Promise<{ success: boolean; error?: string; digestEntry?: MemoryEntry }> {
    const boxes = loadEventBoxes(characterId);
    const box = boxes.find(b => b.id === boxId);
    if (!box) return { success: false, error: "未找到该事件盒" };

    const { digestEntry: existingDigest, newEntries, allMemberEntries } = getBoxLayers(allLongTermEntries, box);
    if (allMemberEntries.length === 0) {
        return { success: false, error: "事件盒里还没有放入任何记忆" };
    }

    const apiConfig = resolveSummarizationApiConfig(characterId);
    if (!apiConfig) {
        return { success: false, error: "未配置可用 API（请在设置 → API 设置或辅助API绑定中配置）" };
    }

    // 如果有先前总结且有新事件：把「先前总结」+「新事件」一起喂给模型融合；
    // 如果没有先前总结，或者用户是在没有新事件时点「重新总结全部」：把盒内全部成员条目按时间正序总结
    const hasIncrementalNew = Boolean(existingDigest && newEntries.length > 0);
    const targetEntries = hasIncrementalNew ? newEntries : allMemberEntries;

    const chronologicAll = [...allMemberEntries].sort((a, b) => entryDateKey(a).localeCompare(entryDateKey(b)));
    const chronologicTarget = [...targetEntries].sort((a, b) => entryDateKey(a).localeCompare(entryDateKey(b)));

    const earliest = entryDateKey(chronologicAll[0]);
    const latest = entryDateKey(chronologicAll[chronologicAll.length - 1]);

    const prevDigestClean = existingDigest
        ? (stripMemoryStructuredSections(existingDigest.content) || existingDigest.content).trim()
        : "";
    const previousDigestSection = hasIncrementalNew && prevDigestClean
        ? `\n【先前事件的总结】：\n${prevDigestClean}\n`
        : "";

    const eventsText = chronologicTarget
        .map(entry => {
            const body = (stripMemoryStructuredSections(entry.content) || entry.content).replace(/\s*\n+\s*/g, " ").trim();
            return `- [${entryDateKey(entry)}] ${body}`;
        })
        .join("\n");

    const prompt = DEFAULT_EVENT_BOX_SUMMARY_PROMPT
        .replace(/\{\{char\}\}/gi, characterName || "角色")
        .replace(/\{\{title\}\}/gi, box.title)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{previousDigestSection\}\}/gi, previousDigestSection)
        .replace(/\{\{events\}\}/gi, eventsText);

    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.3, label: `事件盒总结·${box.title}` },
    );

    if (!result.content) {
        return { success: false, error: result.error || "事件盒总结生成失败" };
    }
    if (result.wasTruncated && result.content.trim().length < 40) {
        return { success: false, error: "总结结果被截断，已取消归档，请重试" };
    }

    const rawOutput = result.content.trim();
    const parsedMeta = extractMemoryStructuredMeta(rawOutput);
    const cleanSummaryBody = stripMemoryStructuredSections(rawOutput) || rawOutput;
    if (!cleanSummaryBody) {
        return { success: false, error: "总结内容为空" };
    }

    // 合并模型提取的关键词 + 事件盒已有关键词 + 盒内条目的核心关键词（最多 10 个）
    const combinedKeywords = uniqueKeywords([
        ...parsedMeta.keywords,
        ...(box.keywords ?? []),
        ...allMemberEntries.flatMap(readEntryKeywords),
    ]).slice(0, 10);

    // 重要性取盒内最高重要性与模型评分的较大值
    const maxMemberImp = allMemberEntries.reduce(
        (m, e) => Math.max(m, Number.isFinite(e.importance) ? e.importance : 0.8),
        0.8,
    );
    const finalImportance = Math.max(maxMemberImp, parsedMeta.importance ?? 0.85);

    // 自动做好向量化（Embedding）
    const embeddingInput = combinedKeywords.length > 0
        ? `关键词：${combinedKeywords.join("、")}\n${cleanSummaryBody}`
        : cleanSummaryBody;

    let embedding: number[] | undefined;
    const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            embedding = (await generateEmbedding(embeddingInput, embeddingApiConfig)) ?? undefined;
        } catch {
            embedding = undefined;
        }
    }

    const now = new Date().toISOString();
    const digestId = existingDigest?.id ?? `mem_lt_boxdigest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const digestEntry: MemoryEntry = {
        id: digestId,
        characterId,
        sourceApp: existingDigest?.sourceApp ?? chronologicAll[0]?.sourceApp ?? "chat",
        type: "long_term",
        content: cleanSummaryBody,
        embedding,
        importance: finalImportance,
        accessCount: existingDigest?.accessCount ?? 0,
        // createdAt 沿用最早条目的时间，避免触发重复的核心记忆计数
        createdAt: existingDigest?.createdAt ?? chronologicAll[0].createdAt,
        updatedAt: now,
        metadata: {
            ...(existingDigest?.metadata ?? {}),
            origin: "event_box_digest",
            [EVENT_BOX_META_KEYS.boxId]: box.id,
            [EVENT_BOX_META_KEYS.digestOf]: box.id,
            eventBoxTitle: box.title,
            eventDate: latest,
            timeSpan: earliest === latest ? earliest : `${earliest} ~ ${latest}`,
            keywords: combinedKeywords,
            sourceEntryCount: allMemberEntries.length,
            topicSplitV2: true,
            resplitDone: true,
            ...(embedding ? { embeddingDim: embedding.length } : {}),
        },
    };
    await saveMemoryEntry(digestEntry);

    // 将盒内所有成员条目打上「已归档」标记，显示在事件盒下方的「已归档事件」区
    for (const member of allMemberEntries) {
        if (isEntryArchived(member) && member.metadata?.[EVENT_BOX_META_KEYS.archivedInto] === box.id) {
            continue;
        }
        await saveMemoryEntry({
            ...member,
            updatedAt: now,
            metadata: {
                ...(member.metadata ?? {}),
                [EVENT_BOX_META_KEYS.boxId]: box.id,
                [EVENT_BOX_META_KEYS.archivedInto]: box.id,
                [EVENT_BOX_META_KEYS.archivedAt]: now,
            },
        });
    }

    const prevHistory = box.digestHistory ?? [];
    const nextHistory: EventBoxDigestVersion[] = [
        ...prevHistory,
        {
            version: prevHistory.length + 1,
            text: cleanSummaryBody,
            sourceIds: allMemberEntries.map(e => e.id),
            generatedAt: now,
        },
    ];

    updateEventBox(characterId, box.id, {
        digestEntryId: digestId,
        digestHistory: nextHistory,
        keywords: combinedKeywords,
    });

    return { success: true, digestEntry };
}

/**
 * 撤销总结并恢复：删除「先前事件的总结」条目，把盒内所有「已归档事件」恢复为盒内「新事件」
 */
export async function restoreEventBoxArchivedEntries(
    characterId: string,
    boxId: string,
    allLongTermEntries: MemoryEntry[],
): Promise<{ restoredCount: number }> {
    const boxes = loadEventBoxes(characterId);
    const box = boxes.find(b => b.id === boxId);
    if (!box) return { restoredCount: 0 };

    const { digestEntry, archivedEntries } = getBoxLayers(allLongTermEntries, box);
    const now = new Date().toISOString();
    let restoredCount = 0;

    for (const entry of archivedEntries) {
        const metadata: Record<string, unknown> = { ...(entry.metadata ?? {}) };
        delete metadata[EVENT_BOX_META_KEYS.archivedInto];
        delete metadata[EVENT_BOX_META_KEYS.archivedAt];
        await saveMemoryEntry({ ...entry, updatedAt: now, metadata });
        restoredCount += 1;
    }

    if (digestEntry) {
        await deleteMemoryEntry(digestEntry.id);
    } else if (box.digestEntryId) {
        await deleteMemoryEntry(box.digestEntryId);
    }

    updateEventBox(characterId, boxId, { digestEntryId: undefined });
    return { restoredCount };
}

/**
 * 删除事件盒：保留盒内所有原始记忆并恢复为普通未归盒记忆，同时删除该盒的总结条目
 */
export async function deleteEventBoxAndKeepEntries(
    characterId: string,
    boxId: string,
    allLongTermEntries: MemoryEntry[],
): Promise<{ detachedCount: number }> {
    const boxes = loadEventBoxes(characterId);
    const box = boxes.find(b => b.id === boxId);
    const now = new Date().toISOString();
    let detachedCount = 0;

    for (const entry of allLongTermEntries) {
        if (isEntryBoxDigest(entry) && entry.metadata?.[EVENT_BOX_META_KEYS.digestOf] === boxId) {
            await deleteMemoryEntry(entry.id);
            continue;
        }
        if (getEntryBoxId(entry) === boxId) {
            const metadata: Record<string, unknown> = { ...(entry.metadata ?? {}) };
            delete metadata[EVENT_BOX_META_KEYS.boxId];
            delete metadata[EVENT_BOX_META_KEYS.archivedInto];
            delete metadata[EVENT_BOX_META_KEYS.archivedAt];
            await saveMemoryEntry({ ...entry, updatedAt: now, metadata });
            detachedCount += 1;
        }
    }

    if (box?.digestEntryId) {
        await deleteMemoryEntry(box.digestEntryId);
    }

    saveEventBoxes(characterId, boxes.filter(b => b.id !== boxId));
    return { detachedCount };
}

// ── 智能推荐归盒（只推荐/归入事件盒，绝不自动总结！）─────────────

export type SmartBoxSuggestion = {
    key: string;
    /** 若匹配到已有事件盒，则为已有盒子的 id；若是新聚类事件盒，则为 undefined */
    targetBoxId?: string;
    title: string;
    entries: MemoryEntry[];
    earliest: string;
    latest: string;
};

function calcEntryPairSimilarity(a: MemoryEntry, b: MemoryEntry): number {
    const embA = Array.isArray(a.embedding) && a.embedding.length > 0 ? a.embedding : null;
    const embB = Array.isArray(b.embedding) && b.embedding.length > 0 ? b.embedding : null;
    if (embA && embB && embA.length === embB.length) {
        return cosineSimilarity(embA, embB);
    }
    const kwA = readEntryKeywords(a);
    const kwB = readEntryKeywords(b);
    if (kwA.length > 0 && kwB.length > 0) {
        const setB = new Set(kwB);
        const common = kwA.filter(k => setB.has(k)).length;
        const union = new Set([...kwA, ...kwB]).size || 1;
        return common / union;
    }
    return keywordOverlapRatio(a.content, b.content);
}

/**
 * 智能检索相关记忆归盒方案（纯归组预览，不自动总结）：
 * 1. 先检查未归盒记忆是否与某个「已有事件盒」高度相关（相似度 >= 0.74），归为「并入已有事件盒作为新事件」
 * 2. 剩余未归盒记忆用严格中心团聚类（要求每条记忆与簇中心及簇内平均相似度均 >= 0.74），避免滚雪球把无关记忆连在一起
 */
export async function buildSmartBoxSuggestions(
    characterId: string,
    characterName: string,
    allLongTermEntries: MemoryEntry[],
    existingBoxes: MemoryEventBox[],
): Promise<SmartBoxSuggestion[]> {
    const ungrouped = allLongTermEntries.filter(e => !getEntryBoxId(e) && !isEntryBoxDigest(e));
    if (ungrouped.length === 0) return [];

    const suggestions: SmartBoxSuggestion[] = [];
    const assignedIds = new Set<string>();

    // 第一步：尝试匹配进已有的事件盒（作为该盒的新事件进展）
    for (const box of existingBoxes) {
        if (box.status === "settled") continue;
        const { digestEntry, allMemberEntries } = getBoxLayers(allLongTermEntries, box);
        const anchors = digestEntry ? [digestEntry, ...allMemberEntries] : allMemberEntries;
        if (anchors.length === 0) continue;

        const matchedForBox: MemoryEntry[] = [];
        for (const candidate of ungrouped) {
            if (assignedIds.has(candidate.id)) continue;
            let bestSim = 0;
            for (const anchor of anchors) {
                const sim = calcEntryPairSimilarity(candidate, anchor);
                if (sim > bestSim) bestSim = sim;
            }
            const hasVec = Array.isArray(candidate.embedding) && candidate.embedding.length > 0;
            const threshold = hasVec ? 0.74 : 0.45;
            if (bestSim >= threshold) {
                matchedForBox.push(candidate);
                assignedIds.add(candidate.id);
            }
        }

        if (matchedForBox.length > 0) {
            const dates = matchedForBox.map(entryDateKey).sort();
            suggestions.push({
                key: `existing_${box.id}`,
                targetBoxId: box.id,
                title: box.title,
                entries: matchedForBox,
                earliest: dates[0],
                latest: dates[dates.length - 1],
            });
        }
    }

    // 第二步：把剩余未归盒记忆按严格完全连接团（Complete-linkage）聚成新事件盒候选
    const pool = ungrouped.filter(e => !assignedIds.has(e.id)).slice(0, 300);
    const usedInPool = new Set<string>();
    const rawNewClusters: MemoryEntry[][] = [];

    for (let i = 0; i < pool.length; i++) {
        const seed = pool[i];
        if (usedInPool.has(seed.id)) continue;
        const cluster: MemoryEntry[] = [seed];

        for (let j = i + 1; j < pool.length; j++) {
            const cand = pool[j];
            if (usedInPool.has(cand.id)) continue;
            const hasVec = Array.isArray(seed.embedding) && seed.embedding.length > 0
                && Array.isArray(cand.embedding) && cand.embedding.length === seed.embedding.length;
            const threshold = hasVec ? 0.74 : 0.45;

            // 要求 cand 与当前 cluster 内所有成员的相似度都达标，杜绝 A-B-C 传递误连
            const fitsAll = cluster.every(member => calcEntryPairSimilarity(member, cand) >= threshold);
            if (fitsAll) {
                cluster.push(cand);
            }
        }

        if (cluster.length >= 2) {
            for (const item of cluster) usedInPool.add(item.id);
            rawNewClusters.push(cluster);
        }
    }

    const newSuggestions: SmartBoxSuggestion[] = rawNewClusters.map((members, idx) => {
        const sorted = [...members].sort((a, b) => entryDateKey(a).localeCompare(entryDateKey(b)));
        const dates = sorted.map(entryDateKey);
        const kws = uniqueKeywords(sorted.flatMap(readEntryKeywords)).slice(0, 3);
        return {
            key: `new_${idx}_${sorted[0].id}`,
            title: kws.join(" · ") || sorted[0].content.slice(0, 12),
            entries: sorted,
            earliest: dates[0],
            latest: dates[dates.length - 1],
        };
    });

    // 为新建的候选盒起一个简短的事件盒标题
    if (newSuggestions.length > 0) {
        const apiConfig = resolveSummarizationApiConfig(characterId);
        if (apiConfig) {
            try {
                const blocks = newSuggestions.map((s, i) => {
                    const lines = s.entries
                        .map(e => `  - ${(stripMemoryStructuredSections(e.content) || e.content).replace(/\s*\n+\s*/g, " ").trim().slice(0, 100)}`)
                        .join("\n");
                    return `【第${i + 1}组】\n${lines}`;
                }).join("\n\n");
                const prompt = `下面是{{char}}与用户之间围绕同一件事的多组记忆记录，请为每组起一个简短的中文事件盒名称（4～12个字，如“筹备生日惊喜”、“学法语的约定”）。
严格按“序号. 标题”每行输出一条，不要包含书名号、引号或多余解释：

${blocks}`.replace(/\{\{char\}\}/gi, characterName || "角色");
                const res = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.3 });
                if (res.content) {
                    for (const line of res.content.split("\n")) {
                        const m = line.match(/^\s*(\d+)\s*[.、．:：]\s*(.+?)\s*$/);
                        if (!m) continue;
                        const idx = Number(m[1]) - 1;
                        const cleanTitle = m[2].replace(/[《》「」"“”]/g, "").trim();
                        if (idx >= 0 && idx < newSuggestions.length && cleanTitle) {
                            newSuggestions[idx].title = cleanTitle.slice(0, 20);
                        }
                    }
                }
            } catch {
                // fallback to keyword title
            }
        }
    }

    return [...suggestions, ...newSuggestions];
}
