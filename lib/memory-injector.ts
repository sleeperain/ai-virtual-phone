// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.

import type { MemoryEntry } from "./memory-types";
import { stripMemoryStructuredSections } from "./memory-summarizer";

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

/**
 * Format long-term memories for prompt injection.
 * Orders memories by importance descending (highest weight at the top where the AI
 * pays the most attention; ties broken by newest first), and only prefixes the date
 * the event happened (no storage timestamp or importance score leaked into the prompt).
 */
export function formatLongTermMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const sorted = [...memories].sort((a, b) => {
        const impA = Number.isFinite(a.importance) ? a.importance : 0.8;
        const impB = Number.isFinite(b.importance) ? b.importance : 0.8;
        if (Math.abs(impB - impA) > 0.001) return impB - impA;
        return b.createdAt.localeCompare(a.createdAt);
    });

    const lines: string[] = [];
    for (const entry of sorted) {
        const eventDate = typeof entry.metadata?.eventDate === "string" && entry.metadata.eventDate.trim()
            ? formatLocalDay(entry.metadata.eventDate)
            : formatLocalDay(entry.createdAt);
        const cleanBody = (stripMemoryStructuredSections(entry.content) || entry.content).replace(/\s*\n+\s*/g, " ").trim();
        lines.push(`- [${eventDate}] ${cleanBody}`);
    }
    return lines.join("\n");
}

export function formatCoreMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const sorted = [...memories].sort((a, b) => {
        const impA = Number.isFinite(a.importance) ? a.importance : 0.95;
        const impB = Number.isFinite(b.importance) ? b.importance : 0.95;
        if (Math.abs(impB - impA) > 0.001) return impB - impA;
        return b.createdAt.localeCompare(a.createdAt);
    });

    const lines: string[] = [];
    for (const entry of sorted) {
        const eventDate = typeof entry.metadata?.eventDate === "string" && entry.metadata.eventDate.trim()
            ? formatLocalDay(entry.metadata.eventDate)
            : formatLocalDay(entry.createdAt);
        const cleanBody = (stripMemoryStructuredSections(entry.content) || entry.content).replace(/\s*\n+\s*/g, " ").trim();
        lines.push(`- [${eventDate}] ${cleanBody}`);
    }
    return lines.join("\n");
}
