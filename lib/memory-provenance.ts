// lib/memory-provenance.ts
// 长期记忆的「原文溯源」与「疑似合并」后置校验
//
// 背景：总结是「一批原始事件 → 拆成若干条长期记忆」，模型在拆条时经常把
// 同一时段、同一场景发生的两件互不相干的事编成一条，并自己补出因果
// （例如「打关卡」与「攒代币」本是两套机制，却被写成「打通关就能攒满代币」）。
// 提示词能压制但压不死，所以这里做两件事：
//
// 1. 溯源：把这批拆条所依据的原始事件原文完整存档到独立 kv（不占记忆库空间），
//    每条记忆记住自己的批次号，记忆库详情里可以回看「这条是从哪些原话里炼出来的」。
// 2. 后置校验：用纯规则扫描每条新记忆，命中可疑特征就标一个「疑似合并」，
//    让你在记忆库里一眼挑出来手动拆，不必逐条通读。

import type { MemoryEntry } from "./memory-types";
import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";

export const PROVENANCE_KV_PREFIX = "ai_phone_memory_provenance_";
registerDynamicPrefix(PROVENANCE_KV_PREFIX);

/** 单批原文存档的字数上限：超出后从最早的开始丢，只保留最近的部分 */
const MAX_PROVENANCE_CHARS = 24000;
/** 每批最多保留的原始事件条数 */
const MAX_PROVENANCE_ENTRIES = 200;
/** 存档保留批次数（按角色）：更早的批次自动清理，避免无限增长 */
const MAX_PROVENANCE_BATCHES = 40;

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
        // 存档失败不影响记忆本身，静默跳过
    }
}

export function createProvenanceBatchId(dayKey: string): string {
    return `prov_${dayKey}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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

/** 该角色的原文存档批次数量，用于设置页显示占用情况 */
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

// ── 疑似合并的后置校验 ──────────────────────────────

/** 因果连词：一条纯记录不应该出现「因为/所以/就能/从而」这类推断 */
const CAUSAL_CONNECTORS = /(?:通过|只要|就能|才能|从而|于是|因此|所以|顺便|借此|好在|为了|以便|导致|使得|达成|前提是|条件是)/g;
/** 并列分隔符：一条记忆里出现多个分隔 + 不同主体时更可疑 */
const ENUM_SEPARATORS = /[；;]|、(?=.{4,})/g;

export type MergeSuspicion = {
    /** 是否命中可疑特征 */
    suspect: boolean;
    /** 命中的规则说明，供界面展示 */
    reasons: string[];
    /** 命中的因果连词（去重） */
    connectors: string[];
};

/**
 * 规则扫描一条长期记忆正文，判断是否疑似把两件事合并成一条。
 * 纯启发式、不调模型：宁可误报让人扫一眼，也不要把编造的因果直接喂给角色。
 */
export function detectMergeSuspicion(content: string): MergeSuspicion {
    const body = String(content || "").trim();
    const reasons: string[] = [];
    if (!body) return { suspect: false, reasons, connectors: [] };

    const connectors = Array.from(new Set(body.match(CAUSAL_CONNECTORS) ?? []));
    // 「为了/只要」单独出现可能只是复述用户原话，累积到 2 个以上才认定可疑
    if (connectors.length >= 2) {
        reasons.push(`含 ${connectors.length} 个因果/推论连词（${connectors.slice(0, 4).join("、")}）`);
    } else if (connectors.length === 1 && /(?:就能|才能|从而|因此|所以|导致|使得)/.test(connectors[0])) {
        reasons.push(`含因果推断词「${connectors[0]}」，原文未必有这层关系`);
    }

    // 分号分隔多个动作、且句子偏长：典型的两件事拼在一起
    const separators = body.match(ENUM_SEPARATORS) ?? [];
    if (separators.length >= 1 && body.length >= 60) {
        reasons.push("用分号/顿号罗列了多个动作且篇幅偏长，可能混了两件事");
    }

    return { suspect: reasons.length > 0, reasons, connectors };
}

/** 把可疑标记写进记忆元数据（只标不改正文，人工在记忆库里裁决） */
export function withMergeSuspicionMetadata(
    metadata: Record<string, unknown>,
    suspicion: MergeSuspicion,
): Record<string, unknown> {
    if (!suspicion.suspect) {
        const next = { ...metadata };
        delete next.mergeSuspect;
        delete next.mergeSuspectReasons;
        return next;
    }
    return {
        ...metadata,
        mergeSuspect: true,
        mergeSuspectReasons: suspicion.reasons,
    };
}

/** 读取某条记忆的疑似合并标记 */
export function readMergeSuspicion(entry: MemoryEntry): string[] {
    const raw = entry.metadata?.mergeSuspectReasons;
    if (!Array.isArray(raw)) return entry.metadata?.mergeSuspect ? ["疑似混入了多件事"] : [];
    return raw.map(String).filter(Boolean);
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
