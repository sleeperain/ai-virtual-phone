// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.

import type { MemoryEntry } from "./memory-types";
import { stripMemoryStructuredSections } from "./memory-summarizer";
import { effectiveImportance, isEntrySuperseded } from "./memory-revision";
import { filterRecallableEntries, getEntryBoxId, isEntryBoxDigest, loadEventBoxes } from "./memory-event-boxes";

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
    const recallable = filterRecallableEntries(memories);
    if (recallable.length === 0) return "";

    const sorted = sortMemoriesByDateThenImportance(recallable, 0.8);

    // 预加载角色事件盒标题映射，确保哪怕旧条目没写 metadata.eventBoxTitle 也能串联显示事件盒脉络
    const charId = sorted[0]?.characterId ?? "";
    const boxTitleMap = new Map<string, string>();
    if (charId) {
        for (const box of loadEventBoxes(charId)) {
            boxTitleMap.set(box.id, box.title);
        }
    }

    // 统计本次注入中每个事件盒出现的条目数：若同一事件盒同时召回了「先前事件总结 + 新进展」或多条进展，
    // 自动把同盒条目聚拢串联，避免同一件事的前因后果散落在不同日期行里割裂。
    const boxGroupEntries = new Map<string, MemoryEntry[]>();
    for (const entry of sorted) {
        const boxId = getEntryBoxId(entry) || (isEntryBoxDigest(entry) ? String(entry.metadata?.eventBoxDigestOf ?? "") : "");
        if (!boxId) continue;
        const arr = boxGroupEntries.get(boxId) ?? [];
        arr.push(entry);
        boxGroupEntries.set(boxId, arr);
    }

    const lines: string[] = [];
    const emittedIds = new Set<string>();

    for (const entry of sorted) {
        if (emittedIds.has(entry.id)) continue;
        const boxId = getEntryBoxId(entry) || (isEntryBoxDigest(entry) ? String(entry.metadata?.eventBoxDigestOf ?? "") : "");
        const boxTitle = (typeof entry.metadata?.eventBoxTitle === "string" && entry.metadata.eventBoxTitle.trim())
            ? entry.metadata.eventBoxTitle.trim()
            : (boxId ? (boxTitleMap.get(boxId) ?? "") : "");

        const group = boxId ? boxGroupEntries.get(boxId) : undefined;
        if (boxId && group && group.length > 1) {
            // 同一事件盒被召回了多条（例如阶段总结 + 近期新事件），按时间正序串联在同一事件脉络下输出
            const chronological = [...group].sort((a, b) => {
                // 阶段性总结放在该事件脉络最前面打底，后续跟上按日期从早到晚的新事件进展
                const aDigest = isEntryBoxDigest(a) ? 0 : 1;
                const bDigest = isEntryBoxDigest(b) ? 0 : 1;
                if (aDigest !== bDigest) return aDigest - bDigest;
                return resolveEntryDateKey(a).localeCompare(resolveEntryDateKey(b));
            });
            const subParts: string[] = [];
            for (const member of chronological) {
                emittedIds.add(member.id);
                const dKey = resolveEntryDateKey(member);
                const timeSpan = typeof member.metadata?.timeSpan === "string" && member.metadata.timeSpan.trim()
                    ? member.metadata.timeSpan.trim()
                    : dKey;
                const cleanBody = (stripMemoryStructuredSections(member.content) || member.content).replace(/\s*\n+\s*/g, " ").trim();
                const staleMark = isEntrySuperseded(member) ? "（部分说法已更正）" : "";
                if (isEntryBoxDigest(member)) {
                    subParts.push(`[前情总结 ${timeSpan}]${staleMark} ${cleanBody}`);
                } else {
                    subParts.push(`[进展 ${dKey}]${staleMark} ${cleanBody}`);
                }
            }
            const headerLabel = boxTitle ? `【事件脉络：${boxTitle}】` : `【关联事件脉络】`;
            lines.push(`- ${headerLabel}${subParts.join(" → ")}`);
            continue;
        }

        emittedIds.add(entry.id);
        const eventDate = resolveEntryDateKey(entry);
        const timeSpan = isEntryBoxDigest(entry) && typeof entry.metadata?.timeSpan === "string" && entry.metadata.timeSpan.trim()
            ? entry.metadata.timeSpan.trim()
            : eventDate;
        const cleanBody = (stripMemoryStructuredSections(entry.content) || entry.content).replace(/\s*\n+\s*/g, " ").trim();
        const staleMark = isEntrySuperseded(entry) ? "（其中部分说法已被后来的记忆更正）" : "";
        const boxPrefix = boxTitle
            ? (isEntryBoxDigest(entry) ? `【事件总结：${boxTitle}】` : `【事件：${boxTitle}】`)
            : "";
        lines.push(`- [${timeSpan}]${boxPrefix}${staleMark} ${cleanBody}`);
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
