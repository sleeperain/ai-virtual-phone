// lib/memory-trash.ts
// 记忆回收站（最近删除）
//
// 设计原则：
// 1. 「弃用」不是删除。角色或用户把一条记忆弃用后，它只是不再参与任何 Prompt 注入
//    （由 filterRecallableEntries 统一拦截），原文完整留在库里，随时可以恢复。
// 2. 「彻底删除」只发生在回收站里。用户主动在回收站按下删除才真正 drop 记录。
// 3. 回收站按角色隔离：所有读取函数都以 characterId 为第一参数，绝不跨角色返回。
// 4. 「角色修改」也进回收站视野：修改前的内容快照留在 metadata 里，
//    用户可以一键还原到角色动手之前的版本。
//
// 依赖方向：本模块只依赖 memory-types / memory-storage，不依赖 memory-event-boxes，
// 因此可以被 memory-event-boxes 反过来引用而不形成循环。

import type { MemoryEntry } from "./memory-types";
import { deleteMemoryEntries, saveMemoryEntry } from "./memory-storage";

/** 弃用/修改相关的 metadata 键，集中定义避免各处拼字符串。 */
export const TRASH_META_KEYS = {
    /** 弃用时间（ISO）。存在即视为已弃用，不再注入 */
    at: "trashedAt",
    /** 操作者："character" | "user" */
    by: "trashedBy",
    /** 弃用理由（角色给的一句话） */
    reason: "trashReason",
    /** 修改前的正文快照 */
    previousContent: "preEditContent",
    /** 修改前的重要性快照 */
    previousImportance: "preEditImportance",
    /** 角色动手修改的时间（ISO） */
    editedAt: "characterEditedAt",
    /** 修改前的事件日期快照 */
    previousEventDate: "preEditEventDate",
} as const;

export type TrashActor = "character" | "user";

/** 这条记忆是否已被弃用（不再注入 Prompt） */
export function isEntryTrashed(entry: MemoryEntry): boolean {
    return typeof entry.metadata?.[TRASH_META_KEYS.at] === "string";
}

/** 这条记忆是否留有「角色改过」的快照（可用于还原） */
export function hasCharacterEdit(entry: MemoryEntry): boolean {
    return typeof entry.metadata?.[TRASH_META_KEYS.previousContent] === "string";
}

/** 读取修改前快照 */
export function readEditSnapshot(entry: MemoryEntry): {
    content: string;
    importance?: number;
    eventDate?: string;
} | null {
    const raw = entry.metadata?.[TRASH_META_KEYS.previousContent];
    if (typeof raw !== "string") return null;
    const imp = entry.metadata?.[TRASH_META_KEYS.previousImportance];
    const date = entry.metadata?.[TRASH_META_KEYS.previousEventDate];
    const importance = typeof imp === "number" ? imp : Number(imp);
    return {
        content: raw,
        importance: Number.isFinite(importance) ? importance : undefined,
        eventDate: typeof date === "string" && date.trim() ? date.trim() : undefined,
    };
}

/** 弃用理由，用于回收站展示 */
export function readTrashReason(entry: MemoryEntry): string {
    const raw = entry.metadata?.[TRASH_META_KEYS.reason];
    return typeof raw === "string" ? raw.trim() : "";
}

export function readTrashActor(entry: MemoryEntry): TrashActor {
    return entry.metadata?.[TRASH_META_KEYS.by] === "character" ? "character" : "user";
}

export function readTrashedAt(entry: MemoryEntry): string {
    const raw = entry.metadata?.[TRASH_META_KEYS.at];
    return typeof raw === "string" ? raw : "";
}

/**
 * 弃用一条记忆（软删除）：只加标记，正文与 id 都不动。
 * 弃用后该条不再参与任何 Prompt 注入，但会出现在「最近删除」里等待用户裁决。
 */
export async function trashMemoryEntry(
    entry: MemoryEntry,
    options: { by: TrashActor; reason?: string },
): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const next: MemoryEntry = {
        ...entry,
        updatedAt: now,
        metadata: {
            ...(entry.metadata ?? {}),
            [TRASH_META_KEYS.at]: now,
            [TRASH_META_KEYS.by]: options.by,
            ...(options.reason?.trim() ? { [TRASH_META_KEYS.reason]: options.reason.trim().slice(0, 200) } : {}),
        },
    };
    await saveMemoryEntry(next);
    return next;
}

/**
 * 从回收站恢复一条记忆：清掉弃用标记，让它重新参与注入。
 * 注意不清 previousContent —— 如果这条记忆同时带着「角色改过」的快照，
 * 恢复弃用之后用户仍然可以再选择还原到修改前的版本。
 */
export async function restoreTrashedEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    const metadata: Record<string, unknown> = { ...(entry.metadata ?? {}) };
    delete metadata[TRASH_META_KEYS.at];
    delete metadata[TRASH_META_KEYS.by];
    delete metadata[TRASH_META_KEYS.reason];
    const next: MemoryEntry = {
        ...entry,
        updatedAt: new Date().toISOString(),
        metadata,
    };
    await saveMemoryEntry(next);
    return next;
}

/**
 * 把一条记忆还原到「角色修改之前」的样子。
 * 正文、重要性、事件日期都回滚，并清掉快照键，避免重复还原。
 */
export async function revertCharacterEdit(entry: MemoryEntry): Promise<MemoryEntry | null> {
    const snapshot = readEditSnapshot(entry);
    if (!snapshot) return null;
    const metadata: Record<string, unknown> = { ...(entry.metadata ?? {}) };
    delete metadata[TRASH_META_KEYS.previousContent];
    delete metadata[TRASH_META_KEYS.previousImportance];
    delete metadata[TRASH_META_KEYS.previousEventDate];
    delete metadata[TRASH_META_KEYS.editedAt];
    if (snapshot.eventDate) metadata.eventDate = snapshot.eventDate;
    const next: MemoryEntry = {
        ...entry,
        content: snapshot.content,
        importance: snapshot.importance ?? entry.importance,
        updatedAt: new Date().toISOString(),
        metadata,
    };
    await saveMemoryEntry(next);
    return next;
}

/** 从回收站里彻底删除（不可恢复）。只传 id，调用方负责确认这些 id 都来自本角色的回收站。 */
export async function permanentlyDeleteTrashed(ids: string[]): Promise<void> {
    await deleteMemoryEntries(ids);
}

export type TrashBucket = {
    /** 被弃用的记忆（不再注入） */
    trashed: MemoryEntry[];
    /** 被角色改过、新内容仍在生效、可还原到修改前的记忆 */
    edited: MemoryEntry[];
};

/**
 * 把某个角色的核心/长期记忆分成回收站需要的两摞。
 * 纯函数：入参通常是 loadMemoryEntriesByType 的结果，不碰存储。
 */
export function buildTrashBucket(entries: MemoryEntry[]): TrashBucket {
    const trashed: MemoryEntry[] = [];
    const edited: MemoryEntry[] = [];
    for (const entry of entries) {
        if (isEntryTrashed(entry)) {
            trashed.push(entry);
        } else if (hasCharacterEdit(entry)) {
            edited.push(entry);
        }
    }
    const byTimeDesc = (a: MemoryEntry, b: MemoryEntry) =>
        (readTrashedAt(b) || b.updatedAt).localeCompare(readTrashedAt(a) || a.updatedAt);
    trashed.sort(byTimeDesc);
    edited.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { trashed, edited };
}
