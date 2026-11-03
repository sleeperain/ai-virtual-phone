// lib/memory-event-boxes.ts
// 事件盒：把围绕同一件事的多条长期记忆归到一个盒子里。
//
// 解决两个不同的问题：
//   1. 浏览 —— 记忆多了列表要滑很久，按事归拢后一眼能看到有哪些事
//   2. 召回 —— 同一件事的多条记忆各自参与打分，既挤占预算又容易自相矛盾；
//      归档后由一条盒子摘要代表整件事参与召回
//
// 关键设计：归档只写 metadata 标记 + 生成一条摘要记忆，源条目**永不物理删除**，
// 随时可恢复（清标记即可）。所有函数都不发起 LLM 调用，纯存储 + 纯计算；
// 需要模型参与的重总结在 lib/memory-event-box-digest.ts。

import type { MemoryEntry } from "./memory-types";
import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";

/** 每个角色一份盒子表，跟着角色走（记忆是角色私有的，盒子也不跨角色共享） */
export const EVENT_BOX_KV_PREFIX = "ai_phone_memory_boxes_";
// 注册后旧版本存在 localStorage 里的同名键会被迁进 kv（IDB）
registerDynamicPrefix(EVENT_BOX_KV_PREFIX);

export type EventBoxStatus = "active" | "settled" | "pivotal";

export const EVENT_BOX_STATUS_META: Record<EventBoxStatus, { label: string; hint: string }> = {
    active: { label: "进行中", hint: "这件事还在发展，以后可能还有新记忆进来" },
    settled: { label: "已结束", hint: "这件事已经告一段落，不再有新的进展" },
    pivotal: { label: "关键转折", hint: "对关系影响很大，建议保留在上下文里" },
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
    /** 一句话说明，盒子里没摘要时当副标题显示 */
    note?: string;
    status: EventBoxStatus;
    createdAt: string;
    updatedAt: string;
    /** 当前是否处于「已归档」：源条目退出召回，由摘要条目代表这件事 */
    archived: boolean;
    digest?: {
        current: string;
        /** 历次摘要全部保留，重新总结不覆盖历史 */
        versions: EventBoxDigestVersion[];
    };
    /** 摘要记忆条目在 memories 表里的 id，归档态下召回注入的是它 */
    digestEntryId?: string;
};

/**
 * 条目侧只加这一组 metadata，不动 memories 表的索引和版本。
 * 注意：归档不复用 memory-revision 的 supersededBy —— 那是「同一件事说了新版本」，
 * 这里是「整组被折叠成摘要」，语义不同，混用会让界面两种提示打架。
 */
export const EVENT_BOX_META_KEYS = {
    /** 属于哪个盒子 */
    boxId: "eventBoxId",
    /** 这条是某个盒子生成的摘要（不是原始记忆） */
    digestOf: "eventBoxDigestOf",
    /** 被归档的时间 */
    archivedAt: "eventBoxArchivedAt",
    /** 被归档进哪个盒子 */
    archivedInto: "eventBoxArchivedInto",
} as const;

function boxKey(characterId: string): string {
    return `${EVENT_BOX_KV_PREFIX}${characterId}`;
}

function normalizeStatus(raw: unknown): EventBoxStatus {
    return raw === "settled" || raw === "pivotal" ? raw : "active";
}

function normalizeBox(raw: unknown, characterId: string): MemoryEventBox | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Partial<MemoryEventBox>;
    if (typeof item.id !== "string" || !item.id) return null;
    if (typeof item.title !== "string") return null;
    const now = new Date().toISOString();
    const digest = item.digest && typeof item.digest.current === "string"
        ? {
            current: item.digest.current,
            versions: Array.isArray(item.digest.versions) ? item.digest.versions : [],
        }
        : undefined;
    return {
        id: item.id,
        characterId,
        title: item.title,
        note: typeof item.note === "string" ? item.note : undefined,
        status: normalizeStatus(item.status),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
        archived: Boolean(item.archived),
        digest,
        digestEntryId: typeof item.digestEntryId === "string" ? item.digestEntryId : undefined,
    };
}

/** 读某角色的全部事件盒。数据坏了就返回空表，不抛给 UI。 */
export function loadEventBoxes(characterId: string): MemoryEventBox[] {
    if (!characterId) return [];
    try {
        const raw = kvGet(boxKey(characterId));
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const boxes: MemoryEventBox[] = [];
        for (const item of parsed) {
            const box = normalizeBox(item, characterId);
            if (box) boxes.push(box);
        }
        return boxes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
        return [];
    }
}

export function saveEventBoxes(characterId: string, boxes: MemoryEventBox[]): void {
    if (!characterId) return;
    kvSet(boxKey(characterId), JSON.stringify(boxes));
}

export function createEventBoxId(): string {
    return `box_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createEventBox(
    characterId: string,
    title: string,
    note?: string,
): MemoryEventBox {
    const now = new Date().toISOString();
    return {
        id: createEventBoxId(),
        characterId,
        title: title.trim() || "未命名事件",
        note: note?.trim() || undefined,
        status: "active",
        createdAt: now,
        updatedAt: now,
        archived: false,
    };
}

/** 整表读改写：读出来 → 交给 mutate 改 → 写回。盒子数量很少，不需要更细的粒度。 */
export function mutateEventBoxes(
    characterId: string,
    mutate: (boxes: MemoryEventBox[]) => MemoryEventBox[],
): MemoryEventBox[] {
    const next = mutate(loadEventBoxes(characterId));
    saveEventBoxes(characterId, next);
    return next;
}

export function updateEventBox(
    characterId: string,
    boxId: string,
    patch: Partial<Omit<MemoryEventBox, "id" | "characterId" | "createdAt">>,
): MemoryEventBox[] {
    return mutateEventBoxes(characterId, boxes => boxes.map(box => (
        box.id === boxId
            ? { ...box, ...patch, updatedAt: new Date().toISOString() }
            : box
    )));
}

/**
 * 删盒子。记忆条目原样保留，只把归属清掉（不然会留下指向不存在盒子的孤儿 id）。
 * 如果盒子处于归档态，调用方应先用 restoreEventBox 恢复源条目再删。
 */
export function removeEventBox(characterId: string, boxId: string): MemoryEventBox[] {
    return mutateEventBoxes(characterId, boxes => boxes.filter(box => box.id !== boxId));
}

// ── 条目侧判定（纯函数，被召回链路共用）──────────────────────────

/** 条目所属的盒子 id，没归组返回空串 */
export function getEntryBoxId(entry: MemoryEntry): string {
    const raw = entry.metadata?.[EVENT_BOX_META_KEYS.boxId];
    return typeof raw === "string" ? raw : "";
}

/** 这条记忆是否已被归档（不再单独参与召回） */
export function isEntryArchived(entry: MemoryEntry): boolean {
    const raw = entry.metadata?.[EVENT_BOX_META_KEYS.archivedInto];
    return typeof raw === "string" && raw.length > 0;
}

/** 这条记忆是不是某个盒子生成的摘要条目 */
export function isEntryBoxDigest(entry: MemoryEntry): boolean {
    const raw = entry.metadata?.[EVENT_BOX_META_KEYS.digestOf];
    return typeof raw === "string" && raw.length > 0;
}

/** 未被归档、可以正常参与召回的条目 */
export function filterRecallableEntries(entries: MemoryEntry[]): MemoryEntry[] {
    return entries.filter(entry => !isEntryArchived(entry));
}

// ── 分组与展示 ────────────────────────────────────────────────

/** 盒内的原始条目（不含摘要条目），按事件日期从近到远 */
export function getBoxEntries(entries: MemoryEntry[], boxId: string): MemoryEntry[] {
    return entries
        .filter(entry => getEntryBoxId(entry) === boxId && !isEntryBoxDigest(entry))
        .sort((a, b) => entryDateKey(b).localeCompare(entryDateKey(a)));
}

/** 还没归进任何盒子的条目（含摘要条目之外的散条） */
export function getUngroupedEntries(entries: MemoryEntry[]): MemoryEntry[] {
    return entries.filter(entry => !getEntryBoxId(entry) && !isEntryBoxDigest(entry));
}

export function entryDateKey(entry: MemoryEntry): string {
    const eventDate = typeof entry.metadata?.eventDate === "string" ? entry.metadata.eventDate.trim() : "";
    if (eventDate) return eventDate;
    return entry.createdAt.slice(0, 10);
}

/** 盒子的日期跨度，例如「2025-10-12 ~ 10-28」；只有一个日期时只显示它 */
export function formatBoxSpan(entries: MemoryEntry[]): string {
    if (entries.length === 0) return "";
    const dates = entries.map(entryDateKey).filter(Boolean).sort();
    if (dates.length === 0) return "";
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (first === last) return first;
    // 同年只显示一次年份，省一点宽度
    if (first.slice(0, 4) === last.slice(0, 4)) {
        return `${first} ~ ${last.slice(5)}`;
    }
    return `${first} ~ ${last}`;
}

/** 盒内条目的最高重要性，用来给盒子卡片排序 / 标关键事件 */
export function getBoxImportance(entries: MemoryEntry[]): number {
    let max = 0;
    for (const entry of entries) {
        const value = Number.isFinite(entry.importance) ? entry.importance : 0.8;
        if (value > max) max = value;
    }
    return max;
}
