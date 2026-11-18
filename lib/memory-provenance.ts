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

/**
 * 强推断连词：这些词会把两件事「焊」成因果关系，是最典型的编造因果信号。
 * 只把它们计入可疑判定——「于是/所以/为了」这类叙述里本来就常用，人人都写，不算证据。
 */
const STRONG_INFERENCE_CONNECTORS = /(?:通过|就能|才能|从而|导致|使得|达成|前提是|条件是|以便)/g;
/** 弱因果连词：只作为辅助信息返回，不单独构成可疑 */
const WEAK_CAUSAL_CONNECTORS = /(?:于是|因此|所以|顺便|借此|好在|为了)/g;
/** 并列分隔符：一条记忆里出现多个分隔 + 篇幅明显偏长时才可疑 */
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
 * 纯启发式、不调模型。口径刻意保守：相关联的事被误标一下，用户可能真的去拆，
 * 把好记忆拆散比漏检糟糕得多，所以宁可漏检。
 */
export function detectMergeSuspicion(content: string): MergeSuspicion {
    const body = String(content || "").trim();
    const reasons: string[] = [];
    if (!body) return { suspect: false, reasons, connectors: [] };

    const strong = Array.from(new Set(body.match(STRONG_INFERENCE_CONNECTORS) ?? []));
    const weak = Array.from(new Set(body.match(WEAK_CAUSAL_CONNECTORS) ?? []));
    const connectors = Array.from(new Set([...strong, ...weak]));

    // 口径刻意保守：相关联的事（起因→经过→结果、同一场景的连续动作、有真实因果的约定）
    // 本来就是一条好记忆，不该被标成「疑似合并」再被拆散。
    // 1. 强推断连词本身就很可疑（「通过A就能B」「A是B的前提」几乎都是模型自己焊出来的），出现 2 个以上直接认定；
    // 2. 出现 1 个强推断词 + 至少 1 个弱因果词，也认定（两层因果叠在一起）；
    // 3. 弱因果词单独出现一律不认定——那是正常叙述，人人都会用。
    if (strong.length >= 2) {
        reasons.push(`含 ${strong.length} 个强推断词（${strong.slice(0, 4).join("、")}），原文未必有这层因果关系`);
    } else if (strong.length === 1 && weak.length >= 1) {
        reasons.push(`同时出现推断词「${strong[0]}」与「${weak[0]}」，像是把两件事焊成了因果`);
    }

    // 罗列多个动作且篇幅明显偏长：只有「；」这种明确分句、且分段够多时才可疑
    const semicolons = (body.match(/[;；]/g) ?? []).length;
    const separators = body.match(ENUM_SEPARATORS) ?? [];
    if (semicolons >= 2 && body.length >= 90) {
        reasons.push(`用分号罗列了 ${semicolons + 1} 段以上内容且篇幅偏长，可能混了几件事`);
    } else if (separators.length >= 3 && body.length >= 140) {
        reasons.push("顿号并列项过多且篇幅很长，可能混了几件事");
    }

    return { suspect: reasons.length > 0, reasons, connectors };
}

/**
 * 判定规则版本号。规则一收紧，就要把旧版留下的标记全部作废——
 * 上一版几乎给所有带「所以/于是」的记忆都盖了「疑似合并」，那些标记不能继续驱动拆分。
 */
export const MERGE_SUSPECT_VERSION = 2;

/** 把可疑标记写进记忆元数据（只标不改正文，人工在记忆库里裁决） */
export function withMergeSuspicionMetadata(
    metadata: Record<string, unknown>,
    suspicion: MergeSuspicion,
): Record<string, unknown> {
    if (!suspicion.suspect) {
        const next = { ...metadata };
        delete next.mergeSuspect;
        delete next.mergeSuspectReasons;
        delete next.mergeSuspectVersion;
        return next;
    }
    return {
        ...metadata,
        mergeSuspect: true,
        mergeSuspectReasons: suspicion.reasons,
        mergeSuspectVersion: MERGE_SUSPECT_VERSION,
    };
}

/**
 * 读取某条记忆的疑似合并标记。
 * 旧版规则（无版本号或版本号不符）留下的标记一律忽略，由界面按新规则重新检测。
 */
export function readMergeSuspicion(entry: MemoryEntry): string[] {
    if (entry.metadata?.mergeSuspectVersion !== MERGE_SUSPECT_VERSION) return [];
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
