// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.

import type { MemoryEntry } from "./memory-types";
import { stripMemoryStructuredSections } from "./memory-summarizer";
import { effectiveImportance, isEntrySuperseded } from "./memory-revision";

function formatLocalDay(isoOrDateStr: string): string {
    if (!isoOrDateStr) return "未知日期";
    if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDateStr.trim())) {
        return isoOrDateStr.trim();
    }
    const d = new Date(isoOrDateStr);
    if (isNaN(d.getTime())) return isoOrDateStr.slice(0, 10);
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function resolveEntryDateKey(entry: MemoryEntry): string {
    if (typeof entry.metadata?.eventDate === "string" && entry.metadata.eventDate.trim()) {
        return formatLocalDay(entry.metadata.eventDate);
    }
    return formatLocalDay(entry.createdAt);
}

/**
 * 统一的记忆注入排序规则：
 * 1. 先按事件日期（eventDate / createdAt 本地日期）从近到远排序（最新日期在前，时间脉络清晰）
 * 2. 同一天内的多条记忆，按重要性（importance）从高到低排序
 * 3. 若日期与重要性均相同，按 createdAt 降序排列
 */
export function sortMemoriesByDateThenImportance(
    memories: MemoryEntry[],
    defaultImportance = 0.8
): MemoryEntry[] {
    return [...memories].sort((a, b) => {
        const dateA = resolveEntryDateKey(a);
        const dateB = resolveEntryDateKey(b);
        if (dateA !== dateB) {
            return dateB.localeCompare(dateA);
        }
        // 同一天内按「修订后的有效重要性」排：被改写的旧版本沉到新版本后面
        const impA = effectiveImportance(a, defaultImportance);
        const impB = effectiveImportance(b, defaultImportance);
        if (Math.abs(impB - impA) > 0.001) return impB - impA;
        return b.createdAt.localeCompare(a.createdAt);
    });
}

/**
 * Format long-term memories for prompt injection.
 * Orders memories by event date first (newest date at the top), then by importance descending
 * within the same day, and only prefixes the date the event happened.
 */
export function formatLongTermMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const sorted = sortMemoriesByDateThenImportance(memories, 0.8);

    const lines: string[] = [];
    for (const entry of sorted) {
        const eventDate = resolveEntryDateKey(entry);
        const cleanBody = (stripMemoryStructuredSections(entry.content) || entry.content).replace(/\s*\n+\s*/g, " ").trim();
        // 被后续记忆改写过的旧条目：正文照给，但标一句「部分已过时」，
        // 让模型知道其中被改写的说法不能再当事实用。
        const staleMark = isEntrySuperseded(entry) ? "（其中部分说法已被后来的记忆更正）" : "";
        lines.push(`- [${eventDate}]${staleMark} ${cleanBody}`);
    }
    return lines.join("\n");
}

export function formatCoreMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const sorted = sortMemoriesByDateThenImportance(memories, 0.95);

    const lines: string[] = [];
    for (const entry of sorted) {
        const eventDate = resolveEntryDateKey(entry);
        const cleanBody = (stripMemoryStructuredSections(entry.content) || entry.content).replace(/\s*\n+\s*/g, " ").trim();
        lines.push(`- [${eventDate}] ${cleanBody}`);
    }
    return lines.join("\n");
}
