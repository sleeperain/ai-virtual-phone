// lib/memory-provenance.ts
// 长期记忆的「原文溯源」引擎：同时支持批次快照存档与手机原生时间线（聊天/事件历史）回溯。
//
// 设计原则：
// 1. 新总结的记忆除了记录 provenanceBatchId 快照，还会记录 timeSpan / eventDate；
// 2. 任何长期记忆（包括以前生成的旧记忆、或超过快照保留上限的记忆），只要手机本地的
//    聊天/事件记录尚未清空，都能直接从原生时间线（loadNativeTimeline）里精准捞回当天的原始记录；
// 3. 「溯源重总结」严格依赖本模块的 resolveMemoryProvenance：一旦返回空（即快照与原生历史均无原文），
//    上层必须拒绝重总结，绝不对着可能写歪的旧记忆正文做无证据二次编造。

import type { MemoryEntry } from "./memory-types";
import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";
import { loadNativeTimeline } from "./short-term-assembler";

export const PROVENANCE_KV_PREFIX = "ai_phone_memory_provenance_";
registerDynamicPrefix(PROVENANCE_KV_PREFIX);

/** 单批原文存档的字数上限：超出后从最早的开始丢，只保留最近的部分 */
const MAX_PROVENANCE_CHARS = 24000;
/** 每批最多保留的原始事件条数 */
const MAX_PROVENANCE_ENTRIES = 200;
/** 存档保留批次数（按角色）：更早的批次自动回退走原生时间线查询 */
const MAX_PROVENANCE_BATCHES = 50;

export type ProvenanceEntry = {
    id: string;
    timestamp: string;
    sourceApp: string;
    content: string;
};

export type ProvenanceBatch = {
    batchId: string;
    characterId: string;
    /** 该批总结对应的日历日 */
    dayKey: string;
    createdAt: string;
    /** 原始事件总条数（存档可能截断，这里是真实总数） */
    totalEntries: number;
    earliest: string;
    latest: string;
    entries: ProvenanceEntry[];
};

export type ResolvedProvenance = {
    source: "batch" | "timeline";
    dayKey: string;
    earliest: string;
    latest: string;
    totalEntries: number;
    entries: ProvenanceEntry[];
};

function batchStorageKey(characterId: string): string {
    return `${PROVENANCE_KV_PREFIX}${characterId}`;
}

type ProvenanceStore = {
    batches: ProvenanceBatch[];
};

function loadStore(characterId: string): ProvenanceStore {
    if (!characterId) return { batches: [] };
    try {
        const raw = kvGet(batchStorageKey(characterId));
        if (!raw) return { batches: [] };
        const parsed = JSON.parse(raw) as Partial<ProvenanceStore>;
        if (!Array.isArray(parsed.batches)) return { batches: [] };
        return { batches: parsed.batches.filter((b): b is ProvenanceBatch => Boolean(b && typeof b.batchId === "string")) };
    } catch {
        return { batches: [] };
    }
}

function saveStore(characterId: string, store: ProvenanceStore): void {
    if (!characterId) return;
    try {
        kvSet(batchStorageKey(characterId), JSON.stringify(store));
    } catch {
        // 存档失败不影响记忆本身，后续仍可通过原生时间线回溯
    }
}

export function createProvenanceBatchId(dayKey: string): string {
    return `prov_${dayKey}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 原文条目 → 存档用的精简结构 */
export function toProvenanceEntry(entry: {
    id: string;
    timestamp: string;
    sourceApp: string;
    content: string;
}): ProvenanceEntry {
    return {
        id: entry.id,
        timestamp: entry.timestamp,
        sourceApp: entry.sourceApp,
        content: String(entry.content ?? ""),
    };
}

/**
 * 存档一批总结所依据的原始事件。
 * 字数超限时从最早的开始丢，保留最近的（与总结素材的取舍方向一致）。
 */
export function saveProvenanceBatch(input: {
    characterId: string;
    dayKey: string;
    entries: ProvenanceEntry[];
    earliest: string;
    latest: string;
}): string {
    const batchId = createProvenanceBatchId(input.dayKey);
    const totalEntries = input.entries.length;
    const kept: ProvenanceEntry[] = [];
    let total = 0;
    for (let i = input.entries.length - 1; i >= 0; i--) {
        const entry = input.entries[i];
        const size = (entry.content?.length ?? 0) + 64;
        if (total + size > MAX_PROVENANCE_CHARS && kept.length > 0) break;
        total += size;
        kept.unshift(entry);
        if (kept.length >= MAX_PROVENANCE_ENTRIES) break;
    }

    const batch: ProvenanceBatch = {
        batchId,
        characterId: input.characterId,
        dayKey: input.dayKey,
        createdAt: new Date().toISOString(),
        totalEntries,
        earliest: input.earliest,
        latest: input.latest,
        entries: kept,
    };

    const store = loadStore(input.characterId);
    store.batches.unshift(batch);
    if (store.batches.length > MAX_PROVENANCE_BATCHES) {
        store.batches = store.batches.slice(0, MAX_PROVENANCE_BATCHES);
    }
    saveStore(input.characterId, store);
    return batchId;
}

export function loadProvenanceBatch(characterId: string, batchId: string): ProvenanceBatch | null {
    if (!characterId || !batchId) return null;
    const store = loadStore(characterId);
    return store.batches.find(b => b.batchId === batchId) ?? null;
}

/** 该角色的原文存档批次数量 */
export function countProvenanceBatches(characterId: string): number {
    return loadStore(characterId).batches.length;
}

/** 清掉某个角色的全部原文存档（记忆本体不受影响） */
export function clearProvenanceBatches(characterId: string): void {
    if (!characterId) return;
    try {
        kvSet(batchStorageKey(characterId), JSON.stringify({ batches: [] }));
    } catch { /* ignore */ }
}

function toLocalDayKey(isoStr: string): string {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.slice(0, 10) || "";
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIsoSpan(rawSpan: unknown): { startIso: string; endIso: string } | null {
    if (typeof rawSpan !== "string" || !rawSpan.includes("~")) return null;
    const parts = rawSpan.split("~").map(s => s.trim());
    if (parts.length !== 2) return null;
    const [left, right] = parts;
    // 只有完整的 ISO 时间戳（含 T 与时间）才用于精确时间窗切片；纯 YYYY-MM-DD 走按日匹配
    if (!left.includes("T") || !right.includes("T")) return null;
    const t1 = Date.parse(left);
    const t2 = Date.parse(right);
    if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 < t1) return null;
    return { startIso: left, endIso: right };
}

/**
 * 统一解析某条记忆对应的原始事件记录（支持新旧所有记忆）：
 * 1. 优先读取 metadata.provenanceBatchId 对应的批次快照；
 * 2. 若无快照（例如此前总结的旧记忆，或快照已轮转过期），自动从手机原生时间线（loadNativeTimeline）
 *    中按 metadata.timeSpan（精确起止时间戳）或 eventDate（所属本地自然日）回溯原始对话与事件；
 * 3. 若快照与本地原生记录均已被清空、找不到任何对应原文，返回 null。
 */
export function resolveMemoryProvenance(
    characterId: string,
    entry: MemoryEntry,
): ResolvedProvenance | null {
    if (!characterId || !entry) return null;

    // 1. 优先命中精确存档批次
    const batchId = typeof entry.metadata?.provenanceBatchId === "string"
        ? entry.metadata.provenanceBatchId.trim()
        : "";
    if (batchId) {
        const batch = loadProvenanceBatch(characterId, batchId);
        if (batch && batch.entries.length > 0) {
            return {
                source: "batch",
                dayKey: batch.dayKey,
                earliest: batch.earliest,
                latest: batch.latest,
                totalEntries: batch.totalEntries,
                entries: batch.entries,
            };
        }
    }

    // 2. 回退查询手机原生聊天与跨应用时间线（支持所有历史旧记忆）
    const eventDateRaw = typeof entry.metadata?.eventDate === "string" ? entry.metadata.eventDate.trim() : "";
    const targetDayKey = /^\d{4}-\d{2}-\d{2}$/.test(eventDateRaw)
        ? eventDateRaw
        : toLocalDayKey(entry.createdAt);

    let timelineEntries: ReturnType<typeof loadNativeTimeline> = [];
    try {
        timelineEntries = loadNativeTimeline(characterId);
    } catch {
        return null;
    }
    if (timelineEntries.length === 0) return null;

    const isoSpan = parseIsoSpan(entry.metadata?.timeSpan);
    const sessionIds = Array.isArray(entry.metadata?.sourceSessionIds)
        ? new Set((entry.metadata.sourceSessionIds as unknown[]).map(String).filter(Boolean))
        : null;

    let matched = isoSpan
        ? timelineEntries.filter(item => item.timestamp >= isoSpan.startIso && item.timestamp <= isoSpan.endIso)
        : [];

    // 若精确 ISO 区间未命中（例如手改过日期或跨时区导入），按事件所属本地自然日匹配
    if (matched.length === 0 && targetDayKey) {
        const sameDay = timelineEntries.filter(item => toLocalDayKey(item.timestamp) === targetDayKey);
        if (sessionIds && sessionIds.size > 0) {
            const bySession = sameDay.filter(item => !item.sessionId || sessionIds.has(item.sessionId));
            matched = bySession.length > 0 ? bySession : sameDay;
        } else {
            matched = sameDay;
        }
    }

    if (matched.length === 0) return null;

    const totalEntries = matched.length;
    const earliest = matched[0].timestamp;
    const latest = matched[matched.length - 1].timestamp;

    // 控制单次返回的体积上限，防止超长聊天刷爆详情区或重总结上下文
    const kept: ProvenanceEntry[] = [];
    let totalChars = 0;
    for (let i = matched.length - 1; i >= 0; i--) {
        const item = toProvenanceEntry(matched[i]);
        const size = item.content.length + 64;
        if (totalChars + size > MAX_PROVENANCE_CHARS && kept.length > 0) break;
        totalChars += size;
        kept.unshift(item);
        if (kept.length >= MAX_PROVENANCE_ENTRIES) break;
    }

    if (kept.length === 0) return null;

    return {
        source: "timeline",
        dayKey: targetDayKey || toLocalDayKey(earliest),
        earliest,
        latest,
        totalEntries,
        entries: kept,
    };
}
