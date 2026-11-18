// lib/memory-manage-tools.ts
// 角色主动管理自己记忆库的工具实现（配合 internal-capability-storage 的「记忆管理」能力）
//
// 安全边界（设计上刻意收紧）：
// 1. 入参绝不接受 characterId——角色只能动「当前角色」的记忆库，防止跨角色串改；
// 2. 不提供硬删除：只能「弃用」，弃用后不再注入 Prompt，但会进「最近删除」等用户裁决；
// 3. 用户手写的核心设定（origin=user_manual）只读，角色不能改也不能弃用；
// 4. 改动前留快照（preEditContent），用户在回收站可一键还原；
// 5. 单轮最多改 MEMORY_MANAGE_MAX_OPS 条，防止模型刷写。

import type { MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, saveMemoryEntry } from "./memory-storage";
import { isEntrySuperseded } from "./memory-revision";
import { stripMemoryStructuredSections } from "./memory-summarizer";
import {
    TRASH_META_KEYS,
    isEntryTrashed,
    trashMemoryEntry,
} from "./memory-trash";

export const MEMORY_MANAGE_MAX_OPS = 5;
export const MEMORY_MANAGE_MAX_CONTENT = 600;

export type MemoryManageOutcome = {
    ok: boolean;
    text: string;
};

function clip(text: string, max: number): string {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

function bodyOf(entry: MemoryEntry): string {
    return (stripMemoryStructuredSections(entry.content) || entry.content).replace(/\s+/g, " ").trim();
}

function isUserManual(entry: MemoryEntry): boolean {
    return String(entry.metadata?.origin ?? "") === "user_manual";
}

/** 当前可被角色管理的记忆：排除已弃用、已被接替、用户手写的核心设定 */
function manageableEntries(entries: MemoryEntry[]): MemoryEntry[] {
    return entries.filter(entry =>
        !isEntryTrashed(entry)
        && !isEntrySuperseded(entry)
        && !(entry.type === "core" && isUserManual(entry)),
    );
}

/**
 * 列表里必须给出真实 id：模型要靠它去调「查看记忆详情 / 修改记忆 / 弃用记忆」。
 * （早先版本只打印 M1、M2 这类序号，模型拿不到 id，后续动作全部无法执行。）
 */
function labelOf(entry: MemoryEntry): string {
    return entry.id;
}

export async function listMemoriesForCharacter(
    characterId: string,
    type: "core" | "long_term" | "all",
    limit: number,
): Promise<MemoryManageOutcome> {
    const max = Math.max(1, Math.min(30, Math.floor(limit) || 15));
    const buckets: MemoryEntry[] = [];
    if (type === "core" || type === "all") {
        buckets.push(...manageableEntries(await loadMemoryEntriesByType(characterId, "core")));
    }
    if (type === "long_term" || type === "all") {
        buckets.push(...manageableEntries(await loadMemoryEntriesByType(characterId, "long_term")));
    }
    if (buckets.length === 0) {
        return { ok: true, text: "记忆库里暂时没有可以管理的记忆。" };
    }
    const shown = buckets.slice(0, max);
    const lines = shown.map(e => {
        const kind = e.type === "core" ? "核心" : "长期";
        const date = String(e.metadata?.eventDate ?? e.createdAt.slice(0, 10));
        return `${labelOf(e)}｜${kind}｜${date}｜${clip(bodyOf(e), 160)}`;
    });
    return {
        ok: true,
        text: [
            `共 ${buckets.length} 条可管理记忆，以下是其中 ${shown.length} 条：`,
            ...lines,
            "",
            "要修改或弃用某条，先按它行首的 id 调「查看记忆详情」读完整原文再动手；id 不要念给用户。",
        ].join("\n"),
    };
}

export async function readMemoryDetail(
    characterId: string,
    memoryId: string,
): Promise<MemoryManageOutcome> {
    const all = [
        ...(await loadMemoryEntriesByType(characterId, "core")),
        ...(await loadMemoryEntriesByType(characterId, "long_term")),
    ];
    const target = all.find(e => e.id === memoryId);
    if (!target) {
        return { ok: false, text: "没找到这条记忆，可能已经不在记忆库里了。" };
    }
    const kind = target.type === "core" ? "核心记忆" : "长期记忆";
    const date = String(target.metadata?.eventDate ?? target.createdAt.slice(0, 10));
    const editable = manageableEntries([target]).length > 0;
    return {
        ok: true,
        text: [
            `id：${target.id}`,
            `类型：${kind}`,
            `事件日期：${date}`,
            `重要性：${Math.max(1, Math.min(10, Math.round((Number.isFinite(target.importance) ? target.importance : 0.8) * 10)))}/10`,
            editable ? "" : "注意：这条记忆受保护（用户手写设定或已被接替），你只能查看，不能修改。",
            "",
            "正文：",
            (stripMemoryStructuredSections(target.content) || target.content).trim(),
        ].filter(Boolean).join("\n"),
    };
}

export async function updateMemoryForCharacter(
    characterId: string,
    memoryId: string,
    updates: { content?: string; importance?: number },
): Promise<MemoryManageOutcome> {
    const all = [
        ...(await loadMemoryEntriesByType(characterId, "core")),
        ...(await loadMemoryEntriesByType(characterId, "long_term")),
    ];
    const target = all.find(e => e.id === memoryId);
    if (!target) {
        return { ok: false, text: "没找到这条记忆，可能已经不在记忆库里了。" };
    }
    if (manageableEntries([target]).length === 0) {
        return {
            ok: false,
            text: isEntryTrashed(target)
                ? "这条记忆已经被弃用了，要先让用户在「最近删除」里恢复才能改。"
                : "这条记忆受保护（用户手写设定或已被更正的版本接替），你不能修改。",
        };
    }

    const nextContent = typeof updates.content === "string" ? updates.content.trim() : "";
    const hasContent = Boolean(nextContent);
    const hasImportance = typeof updates.importance === "number" && Number.isFinite(updates.importance);
    if (!hasContent && !hasImportance) {
        return { ok: false, text: "没有提供要修改的内容或重要性。" };
    }
    if (hasContent && nextContent.length > MEMORY_MANAGE_MAX_CONTENT) {
        return { ok: false, text: `改写后的内容太长了（上限 ${MEMORY_MANAGE_MAX_CONTENT} 字），请压缩后再提交。` };
    }

    const now = new Date().toISOString();
    const metadata: Record<string, unknown> = {
        ...(target.metadata ?? {}),
        // 只在第一次改这条时留快照，避免多次修改把用户真正想要的原文覆盖掉
        [TRASH_META_KEYS.previousContent]: target.metadata?.[TRASH_META_KEYS.previousContent] ?? target.content,
        [TRASH_META_KEYS.previousImportance]: target.metadata?.[TRASH_META_KEYS.previousImportance] ?? target.importance,
        [TRASH_META_KEYS.editedAt]: now,
    };
    const next: MemoryEntry = {
        ...target,
        ...(hasContent ? { content: nextContent } : {}),
        ...(hasImportance ? { importance: Math.max(0.1, Math.min(1, updates.importance as number)) } : {}),
        updatedAt: now,
        metadata,
    };
    await saveMemoryEntry(next);
    return {
        ok: true,
        text: `已更新这条记忆。原内容已留快照，用户可以在记忆库的「最近删除」里看到并还原。`,
    };
}

export async function trashMemoryForCharacter(
    characterId: string,
    memoryId: string,
    reason: string,
): Promise<MemoryManageOutcome> {
    const all = [
        ...(await loadMemoryEntriesByType(characterId, "core")),
        ...(await loadMemoryEntriesByType(characterId, "long_term")),
    ];
    const target = all.find(e => e.id === memoryId);
    if (!target) {
        return { ok: false, text: "没找到这条记忆，可能已经不在记忆库里了。" };
    }
    if (isEntryTrashed(target)) {
        return { ok: true, text: "这条记忆已经是弃用状态了，不用再弃用一次。" };
    }
    if (manageableEntries([target]).length === 0) {
        return { ok: false, text: "这条记忆受保护（用户手写设定），你不能弃用它。" };
    }
    await trashMemoryEntry(target, { by: "character", reason });
    return {
        ok: true,
        text: "已弃用。它不会再出现在你的记忆里，但原文还在，用户可以在「最近删除」里恢复（删除满 60 天后由系统自动清理）。",
    };
}

export { isUserManual as isManualMemoryEntryForTool };
