// lib/memory-event-boxes.ts
// 事件盒（Event Boxes）：把围绕同一件事的长期记忆放在一起管理。
//
// 盒内三层结构：
//   1. 先前事件的总结（digestEntry：由用户在盒内手动点击「总结」生成，自动完成向量化，代表已归档事件参与召回）
//   2. 新事件（已放入该事件盒、但尚未被总结归档的长期记忆，正常参与召回）
//   3. 已归档事件（已被手动总结吸收过的原始长期记忆，在事件盒下方显示「已归档」，不再重复注入 Prompt，但仍保留在主列表和盒内，随时可恢复）

import type { MemoryEntry } from "./memory-types";
import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";
import { saveMemoryEntry, deleteMemoryEntry, loadMemoryConfig } from "./memory-storage";
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
    /** 事件盒重要性（0-1，界面显示为 1-10） */
    importance?: number;
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
    const rawImp = typeof item.importance === "number" && Number.isFinite(item.importance)
        ? (item.importance > 1 ? Math.max(0.1, Math.min(1, item.importance / 10)) : Math.max(0.1, Math.min(1, item.importance)))
        : undefined;
    return {
        id: item.id,
        characterId,
        title: item.title.trim(),
        note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined,
        status: normalizeStatus(item.status),
        keywords: Array.isArray(item.keywords) ? item.keywords.map(String).map(s => s.trim()).filter(Boolean) : undefined,
        ...(rawImp !== undefined ? { importance: Number(rawImp.toFixed(2)) } : {}),
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
    importance?: number,
): MemoryEventBox {
    const now = new Date().toISOString();
    const cleanKws = Array.isArray(keywords) ? keywords.map(s => s.trim()).filter(Boolean) : [];
    const normImp = typeof importance === "number" && Number.isFinite(importance)
        ? Number((importance > 1 ? Math.max(0.1, Math.min(1, importance / 10)) : Math.max(0.1, Math.min(1, importance))).toFixed(2))
        : 0.8;
    const box: MemoryEventBox = {
        id: `box_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        title: title.trim() || "未命名事件",
        note: note?.trim() || undefined,
        status,
        ...(cleanKws.length > 0 ? { keywords: cleanKws } : {}),
        importance: normImp,
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
    patch: Partial<Pick<MemoryEventBox, "title" | "note" | "status" | "keywords" | "importance" | "digestEntryId" | "digestHistory">>,
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
    const box = loadEventBoxes(entry.characterId).find(b => b.id === boxId);
    if (box?.title) {
        metadata.eventBoxTitle = box.title;
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
    delete metadata.eventBoxTitle;
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

export const DEFAULT_EVENT_BOX_SUMMARY_PROMPT = `你是一个擅长梳理叙事脉络的角色记忆整理专家。下面是{{char}}与用户围绕同一事件脉络的记忆记录。
请对这些记录进行**深度提炼与因果重构**，写成一段逻辑连贯、主线清晰的事件总结，并根据完整脉络更新精准的事件盒标题与重要性评分。

角色：{{char}}
当前事件盒名称：{{title}}
时间跨度：{{earliest}} 至 {{latest}}
{{previousDigestSection}}
本次需要整合的事件记录（按时间从早到晚）：
{{events}}

严格要求（核心铁律）：
1. **严禁机械拼接与原样复述**：
   - 绝对禁止把各条记录里的句子按顺序抄写或生硬拼接在一起！
   - 必须先通读全部记录，找出「这条事件的核心主线是什么」，用统一的叙事语言**重写整合**，合并重复动作与反复拉扯的过程，压缩为精炼的叙事脉络。
2. **串联前因后果（起因 → 经过/转折 → 结果与当前状态）**：
   - 明确交代事情因何而起（起因/背景）、中间经历了怎样的推进或转折（关键行动、分歧或互动）、最终达成了什么结果或约定（当前定论与后续影响）。
   - 如果有「先前事件的总结」，需将其与新进展打通重构为一篇完整的连贯脉络；若新进展推翻或改变了旧状态，直接以最新进展修正结论。
3. **果断剔除无关枝节与噪音**：
   - 单条日常记忆中往往夹杂着顺带提及的闲聊、与本事件主线无关的琐碎插曲、一时的情绪寒暄或场景枝节（例如：讨论正事时顺便聊起晚饭吃什么、随口开的一句无关玩笑等）。
   - **凡是不影响该事件核心起因、推进转折与最终结果的支线细节，必须彻底剔除**，只保留推动主线发展的关键事实、核心约定与实质性的情感/关系变化。
4. **同步更新事件标题**：根据重构后的核心主线，提炼一个 5～14 字的中文事件标题（必须用动宾短语或主谓短语点明具体发生了什么事，如“筹备海边生日惊喜”、“胃痛急诊与悉心照料”；**严禁使用“XX与XX”、“XX和XX”、“关于XX”这种名词堆砌格式**，不要带人名作并列主语，不要加引号或书名号）。
5. **重新评估重要性（1-10整数）**：根据该事件整条脉络对角色关系、核心设定或关键约定的实际影响程度，客观给出 1-10 的重要性评分（日常小事推进 5-6，重要约定/深层互动 7-8，关系重大转折/关键里程碑 9-10）。
6. **严禁编造 & 不写具体时间戳**：只基于已有记录提炼，绝不虚构未发生的细节；正文中不要出现具体日期或时间字样（系统会自动记录时间跨度）；使用第三人称客观叙述，控制在 100～240 字之间，一段话讲透前因后果。
7. **末尾固定输出三行元数据**（用于同步更新标题、重要性与检索向量）：
**事件标题**：更新后的事件标题
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

    // 用用户在「记忆库 → 设置 → 事件盒提示词」里保存的模板；没配过就回退内置默认
    const promptTemplate = (loadMemoryConfig().eventBoxSummaryPrompt ?? "").trim() || DEFAULT_EVENT_BOX_SUMMARY_PROMPT;
    const prompt = promptTemplate
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

    // 提取模型生成的更新标题（**事件标题**：...），并从总结正文中剥离该元数据行
    const titleMatch = rawOutput.match(/(?:\*\*事件标题\*\*|事件标题|更新标题)\s*[：:]\s*([^\n]+)/i);
    let resolvedTitle = box.title;
    if (titleMatch?.[1]) {
        let candidateTitle = titleMatch[1].replace(/[《》「」"“”*`]/g, "").trim();
        if (/^[\u4e00-\u9fa5]{1,5}[与和及][\u4e00-\u9fa5]{1,5}$/.test(candidateTitle)) {
            candidateTitle = candidateTitle.replace(/[与和及]/, "");
        }
        if (candidateTitle.length >= 2) {
            resolvedTitle = candidateTitle.slice(0, 20);
        }
    }

    const strippedOutput = rawOutput
        .replace(/^\s*(?:\*\*事件标题\*\*|事件标题|更新标题)\s*[：:][^\n]*\n*/gim, "")
        .trim();
    const cleanSummaryBody = stripMemoryStructuredSections(strippedOutput) || strippedOutput;
    if (!cleanSummaryBody) {
        return { success: false, error: "总结内容为空" };
    }

    // 合并模型提取的关键词 + 事件盒已有关键词 + 盒内条目的核心关键词（最多 10 个）
    const combinedKeywords = uniqueKeywords([
        ...parsedMeta.keywords,
        ...(box.keywords ?? []),
        ...allMemberEntries.flatMap(readEntryKeywords),
    ]).slice(0, 10);

    // 每次重新总结都对应生成并修改重要性：优先采用本次模型根据完整事件脉络评估出的重要性，缺失时才回退盒内成员最高值
    const maxMemberImp = allMemberEntries.reduce(
        (m, e) => Math.max(m, Number.isFinite(e.importance) ? e.importance : 0.8),
        0.8,
    );
    const rawFinalImp = typeof parsedMeta.importance === "number" && Number.isFinite(parsedMeta.importance)
        ? parsedMeta.importance
        : (typeof box.importance === "number" && Number.isFinite(box.importance) ? box.importance : maxMemberImp);
    const finalImportance = Math.max(0.1, Math.min(1, Number(rawFinalImp.toFixed(2))));

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
            eventBoxTitle: resolvedTitle,
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

    // 将盒内所有成员条目打上「已归档」标记，并同步更新最新事件盒标题
    for (const member of allMemberEntries) {
        if (isEntryArchived(member) && member.metadata?.[EVENT_BOX_META_KEYS.archivedInto] === box.id && member.metadata?.eventBoxTitle === resolvedTitle) {
            continue;
        }
        await saveMemoryEntry({
            ...member,
            updatedAt: now,
            metadata: {
                ...(member.metadata ?? {}),
                [EVENT_BOX_META_KEYS.boxId]: box.id,
                eventBoxTitle: resolvedTitle,
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
        title: resolvedTitle,
        importance: finalImportance,
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
            delete metadata.eventBoxTitle;
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

/**
 * 批量总结所有存在待总结「新事件」（或从未总结过但有成员事件）的事件盒
 */
export async function summarizeAllPendingEventBoxes(
    characterId: string,
    characterName: string,
    allLongTermEntries: MemoryEntry[],
    targetBoxIds?: string[],
    onProgress?: (done: number, total: number, currentTitle: string) => void,
): Promise<{ summarizedCount: number; failedCount: number; lastError?: string }> {
    const boxes = loadEventBoxes(characterId);
    const idFilter = targetBoxIds ? new Set(targetBoxIds) : null;
    const pendingBoxes = boxes.filter(box => {
        if (idFilter && !idFilter.has(box.id)) return false;
        const { digestEntry, newEntries, allMemberEntries } = getBoxLayers(allLongTermEntries, box);
        return newEntries.length > 0 || (!digestEntry && allMemberEntries.length > 0);
    });

    if (pendingBoxes.length === 0) {
        return { summarizedCount: 0, failedCount: 0 };
    }

    let summarizedCount = 0;
    let failedCount = 0;
    let lastError: string | undefined;
    let currentEntries = [...allLongTermEntries];

    for (let i = 0; i < pendingBoxes.length; i++) {
        const box = pendingBoxes[i];
        onProgress?.(i + 1, pendingBoxes.length, box.title);
        const res = await summarizeEventBoxManually(characterId, characterName, box.id, currentEntries);
        if (res.success && res.digestEntry) {
            summarizedCount += 1;
            const digest = res.digestEntry;
            const now = digest.updatedAt;
            const hasDigest = currentEntries.some(e => e.id === digest.id);
            currentEntries = hasDigest
                ? currentEntries.map(e => (e.id === digest.id ? digest : e))
                : [digest, ...currentEntries];
            const latestBoxTitle = typeof digest.metadata?.eventBoxTitle === "string" && digest.metadata.eventBoxTitle
                ? digest.metadata.eventBoxTitle
                : box.title;
            currentEntries = currentEntries.map(e => {
                if (getEntryBoxId(e) === box.id && !isEntryBoxDigest(e)) {
                    return {
                        ...e,
                        updatedAt: now,
                        metadata: {
                            ...(e.metadata ?? {}),
                            [EVENT_BOX_META_KEYS.boxId]: box.id,
                            eventBoxTitle: latestBoxTitle,
                            [EVENT_BOX_META_KEYS.archivedInto]: box.id,
                            [EVENT_BOX_META_KEYS.archivedAt]: now,
                        },
                    };
                }
                return e;
            });
        } else {
            failedCount += 1;
            if (res.error) lastError = res.error;
        }
    }

    return { summarizedCount, failedCount, lastError };
}

// ── 智能推荐归盒（只推荐/归入事件盒，或由用户选择归盒后一键批量总结）─────────────

export type SmartBoxSuggestion = {
    key: string;
    /** 若匹配到已有事件盒，则为已有盒子的 id；若是新聚类事件盒，则为 undefined */
    targetBoxId?: string;
    title: string;
    entries: MemoryEntry[];
    earliest: string;
    latest: string;
};

/** 泛化日常词过滤：这些词几乎每条日常互动都会出现，绝不能当成“同一具体事件”的判定依据 */
const GENERIC_DAILY_KEYWORDS = new Set([
    "睡觉", "休息", "晚安", "早安", "午睡", "困倦", "熬夜", "起床",
    "生气", "哄人", "撒娇", "委屈", "吃醋", "退让", "心软", "调侃", "拌嘴", "打趣", "安慰", "关心", "心疼", "嫌弃", "烦躁",
    "聊天", "日常", "消息", "微信", "关心", "陪伴", "思念", "想念", "亲密", "暧昧", "互动",
    "吃饭", "喝水", "外卖", "下课", "下班", "上课", "上班",
]);

function filterSpecificKeywords(kws: string[], characterName?: string): string[] {
    const charClean = (characterName ?? "").trim();
    return kws.filter(k => {
        const t = k.trim();
        if (t.length < 2) return false;
        if (GENERIC_DAILY_KEYWORDS.has(t)) return false;
        if (charClean && (t === charClean || charClean.includes(t))) return false;
        return true;
    });
}

function stripNamesAndGenericWords(text: string, characterName?: string): string {
    let out = stripMemoryStructuredSections(text) || text;
    if (characterName && characterName.trim().length >= 2) {
        const nameTrim = characterName.trim();
        out = out.split(nameTrim).join("");
    }
    for (const gw of GENERIC_DAILY_KEYWORDS) {
        out = out.split(gw).join(" ");
    }
    return out;
}

function dayDiffBetween(dateA: string, dateB: string): number {
    const tA = new Date(dateA).getTime();
    const tB = new Date(dateB).getTime();
    if (isNaN(tA) || isNaN(tB)) return 0;
    return Math.abs(tA - tB) / 86400000;
}

/**
 * 判断两条记忆是否在讲「同一件具体事件」：
 * - 剔除角色名和泛化日常词（如“睡觉”、“撒娇”、“生气”）后，必须仍有具体事件锚点重合；
 * - 跨度越远（如相隔超过 3 天、7 天），对向量和字面重合的要求越严苛，杜绝把不同时期偶然都提到“去睡觉/拌嘴”的日常硬塞进同一个事件盒。
 */
function areEntriesSameConcreteEvent(
    a: MemoryEntry,
    b: MemoryEntry,
    characterName?: string,
): { matched: boolean; score: number } {
    const daysApart = dayDiffBetween(entryDateKey(a), entryDateKey(b));
    // 相隔超过 21 天的零散日常，除非手动归盒，否则不自动聚成新事件盒
    if (daysApart > 21) return { matched: false, score: 0 };

    const kwA = filterSpecificKeywords(readEntryKeywords(a), characterName);
    const kwB = filterSpecificKeywords(readEntryKeywords(b), characterName);
    const setB = new Set(kwB);
    const sharedSpecificKws = kwA.filter(k => setB.has(k));

    const cleanTextA = stripNamesAndGenericWords(a.content, characterName);
    const cleanTextB = stripNamesAndGenericWords(b.content, characterName);
    const lexicalOverlap = keywordOverlapRatio(cleanTextA, cleanTextB);

    const embA = Array.isArray(a.embedding) && a.embedding.length > 0 ? a.embedding : null;
    const embB = Array.isArray(b.embedding) && b.embedding.length > 0 ? b.embedding : null;
    const hasVec = Boolean(embA && embB && embA.length === embB.length);
    const vecSim = hasVec ? cosineSimilarity(embA!, embB!) : 0;

    // 跨天数惩罚：间隔 > 2 天起逐步提高门槛
    const spanPenalty = daysApart <= 2 ? 0 : Math.min(0.12, (daysApart - 2) * 0.015);

    if (hasVec) {
        // 哪怕向量相似度因为同角色同文风偏高（0.74~0.80），也必须有具体关键词重合或去噪后字面重合 >= 0.22
        const hasConcreteAnchor = sharedSpecificKws.length >= 1 || lexicalOverlap >= 0.22;
        if (!hasConcreteAnchor) return { matched: false, score: vecSim };
        const requiredVec = (sharedSpecificKws.length >= 2 ? 0.78 : 0.83) + spanPenalty;
        return { matched: vecSim >= requiredVec, score: vecSim };
    }

    // 无向量时：必须至少有 2 个具体事件关键词重合，或 1 个具体关键词 + 高字面重合
    const kwUnion = new Set([...kwA, ...kwB]).size || 1;
    const kwJaccard = sharedSpecificKws.length / kwUnion;
    const combined = kwJaccard * 0.6 + lexicalOverlap * 0.4;
    const matched = (sharedSpecificKws.length >= 2 && combined >= 0.42 + spanPenalty)
        || (sharedSpecificKws.length >= 1 && lexicalOverlap >= 0.45 + spanPenalty);
    return { matched, score: combined };
}

/**
 * 智能检索相关记忆归盒方案（宁缺毋滥，绝不强行凑盒）：
 * 1. 先检查未归盒记忆是否与某个「已有事件盒」存在明确的具体事件延续关系；
 * 2. 剩余未归盒记忆用严格完全连接团（Complete-linkage）初筛；
 * 3. 初筛候选交给 LLM 做「是否为同一具体事件主线」的淘汰校验——日常拌嘴、各自催睡觉等非同一事件直接剔除或整组放弃！
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
            const fitsAnchor = anchors.some(anchor => areEntriesSameConcreteEvent(candidate, anchor, characterName).matched);
            if (fitsAnchor) {
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

    // 第二步：把剩余未归盒记忆按严格完全连接团（Complete-linkage）初筛候选簇
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

            // 要求 cand 与当前 cluster 内所有成员都满足「同一具体事件」判定，且整组最大时间跨度不超过 14 天
            const fitsAll = cluster.every(member => {
                if (dayDiffBetween(entryDateKey(member), entryDateKey(cand)) > 14) return false;
                return areEntriesSameConcreteEvent(member, cand, characterName).matched;
            });
            if (fitsAll) {
                cluster.push(cand);
            }
        }

        if (cluster.length >= 2) {
            for (const item of cluster) usedInPool.add(item.id);
            rawNewClusters.push(cluster);
        }
    }

    const draftSuggestions: SmartBoxSuggestion[] = rawNewClusters.map((members, idx) => {
        const sorted = [...members].sort((a, b) => entryDateKey(a).localeCompare(entryDateKey(b)));
        const dates = sorted.map(entryDateKey);
        const firstClean = (stripMemoryStructuredSections(sorted[0].content) || sorted[0].content)
            .replace(/\s*\n+\s*/g, " ")
            .trim();
        const kws = filterSpecificKeywords(uniqueKeywords(sorted.flatMap(readEntryKeywords)), characterName).slice(0, 2);
        const fallbackTitle = firstClean.split(/[，。；！？,.;!?]/)[0]?.slice(0, 14)
            || (kws.length > 0 ? `${kws[0]}事件` : "关联事件");
        return {
            key: `new_${idx}_${sorted[0].id}`,
            title: fallbackTitle,
            entries: sorted,
            earliest: dates[0],
            latest: dates[dates.length - 1],
        };
    });

    // 第三步：交给 LLM 做「宁缺毋滥」的事件同一性审核 + 精准起名
    // 如果某组只是不同时候的日常拌嘴/哄睡觉/情绪互动，并非围绕同一件具体事务的连续进展，直接返回 SKIP 丢弃该组，或只保留真正同属一件事的子集编号！
    let verifiedNewSuggestions = draftSuggestions;
    if (draftSuggestions.length > 0) {
        const apiConfig = resolveSummarizationApiConfig(characterId);
        if (apiConfig) {
            try {
                const blocks = draftSuggestions.map((s, i) => {
                    const lines = s.entries
                        .map((e, eIdx) => `  [${eIdx + 1}] (${entryDateKey(e)}) ${(stripMemoryStructuredSections(e.content) || e.content).replace(/\s*\n+\s*/g, " ").trim().slice(0, 110)}`)
                        .join("\n");
                    return `【候选第${i + 1}组】\n${lines}`;
                }).join("\n\n");
                const prompt = `你是一个严格的记忆归档审核助手。下面是系统初筛出的几组候选记忆，请判断每组记忆是否真正围绕「同一件具体事件/同一个连续事项」展开，并过滤掉强行拼凑的组。

审核与命名铁律（宁缺毋滥！）：
1. **什么才算同一件具体事件**：必须是有明确因果承接或同一具体事务的连续推进（例如：都在筹备同一次生日、同一场生病照料、同一个约定/旅行的前后进展）。
2. **什么必须直接淘汰（输出 SKIP）**：
   - 只是情绪/相处模式相似的日常互动（比如：一次是因为天热嫌烦让对方睡觉，另一次是试探生没生气带撒娇让对方去睡——这只是两次普通的日常拌嘴/哄睡，根本不是同一件连续事件！）；
   - 时间跨度较大、字面和具体事情关联很弱，只是恰好都提到了“睡觉”、“买东西”、“生气”、“撒娇”等日常词；
   - 强行归纳反而显得生硬的零散日常，**一律输出 SKIP，绝不要为了凑数而归纳！**
3. **如果组内只有部分条目属于同一具体事件**（至少 2 条），只保留那几条的序号（如 \`1,2\`），剔除混入的无关条目。
4. **合格组的标题要求（5～14个字）**：
   - 必须用动宾短语或主谓短语点明“具体发生了什么事”（如“筹备海边生日惊喜”、“胃痛急诊与照料”）；
   - **严禁使用“XX与XX”、“XX和XX”、“关于XX”这种名词拼接格式**，严禁把人名放进标题。

输出格式（每组严格占一行，不要有任何多余解释）：
- 若该组不适合合并：\`组号. SKIP\`
- 若该组适合合并：\`组号. 保留的条目序号(逗号分隔) | 事件盒标题\`
示例：
1. SKIP
2. 1,2,3 | 筹备海边生日惊喜

待审核候选组：
${blocks}`.replace(/\{\{char\}\}/gi, characterName || "角色");

                const res = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.2 });
                if (res.content) {
                    const nextVerified: SmartBoxSuggestion[] = [];
                    const decisionMap = new Map<number, { skip: boolean; keepIndices?: number[]; title?: string }>();

                    for (const rawLine of res.content.split("\n")) {
                        const line = rawLine.trim();
                        const m = line.match(/^(\d+)\s*[.、．:：]\s*(.+)$/);
                        if (!m) continue;
                        const groupIdx = Number(m[1]) - 1;
                        const rest = m[2].trim();
                        if (/^SKIP\b/i.test(rest) || rest.includes("不合并") || rest.includes("淘汰")) {
                            decisionMap.set(groupIdx, { skip: true });
                            continue;
                        }
                        const pipeParts = rest.split(/\s*[|｜]\s*/);
                        let keepIndices: number[] | undefined;
                        let rawTitle = rest;
                        if (pipeParts.length >= 2) {
                            const nums = (pipeParts[0].match(/\d+/g) ?? []).map(n => Number(n) - 1);
                            if (nums.length > 0) keepIndices = nums;
                            rawTitle = pipeParts.slice(1).join(" ");
                        }
                        let cleanTitle = rawTitle.replace(/[《》「」"“”*]/g, "").trim();
                        if (/^[\u4e00-\u9fa5]{1,5}[与和及][\u4e00-\u9fa5]{1,5}$/.test(cleanTitle)) {
                            cleanTitle = cleanTitle.replace(/[与和及]/, "");
                        }
                        decisionMap.set(groupIdx, { skip: false, keepIndices, title: cleanTitle });
                    }

                    for (let i = 0; i < draftSuggestions.length; i++) {
                        const item = draftSuggestions[i];
                        const dec = decisionMap.get(i);
                        if (dec?.skip) continue;
                        let finalEntries = item.entries;
                        if (dec?.keepIndices && dec.keepIndices.length >= 2) {
                            const filtered = dec.keepIndices
                                .filter(idx => idx >= 0 && idx < item.entries.length)
                                .map(idx => item.entries[idx]);
                            if (filtered.length >= 2) finalEntries = filtered;
                        }
                        if (finalEntries.length < 2) continue;
                        const dates = finalEntries.map(entryDateKey).sort();
                        nextVerified.push({
                            ...item,
                            title: dec?.title ? dec.title.slice(0, 20) : item.title,
                            entries: finalEntries,
                            earliest: dates[0],
                            latest: dates[dates.length - 1],
                        });
                    }
                    verifiedNewSuggestions = nextVerified;
                }
            } catch {
                // fallback to strict rule-based draftSuggestions
            }
        }
    }

    return [...suggestions, ...verifiedNewSuggestions];
}
