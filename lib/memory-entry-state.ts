// lib/memory-entry-state.ts
// 记忆条目的统一状态判定 —— 「这条记忆现在到底算什么」的唯一事实来源。
//
// 为什么需要它：
// 一条记忆身上叠着五套互相独立的标记（事件盒 boxId / 归档 archivedInto / 修订 supersededBy /
// 回收站 trashedAt / 来源 origin），原先每个消费方（召回注入、上限淘汰、旧格式整理、角色管理工具、
// 界面标记）各自挑自己要的那几个键、写各自的 if。于是判断变成「N 个消费方 × M 个标记」的矩阵，
// 任何一格漏判就冒出一个「莫名其妙」的症状：
//   - 淘汰只排除 trashed、没排除 eventBox* → 时间久的事件盒被整盒删空，只剩一个壳；
//   - 重复判定没排除本轮新建 → 刚总结出来的记忆被判成旧记忆；
//   - 旧格式整理只看形态、不看来源 → 自动总结的条目被算进「整理旧格式记忆(N)」。
// 这三处症状根子是同一个错误：判断散落在各处，谁也看不全别的层的标记。
//
// 本模块只做一件事：给一条条目算出一份完整的状态快照，之后所有地方都读同一份快照。
// 纯函数、不碰存储、不 import 任何 storage / event-box 模块（避免循环依赖），谁都能安全引用。

import type { MemoryEntry } from "./memory-types";

/**
 * 状态判定用到的 metadata 键。
 * 注意：这些键与 memory-event-boxes.ts 的 EVENT_BOX_META_KEYS、memory-trash.ts 的 TRASH_META_KEYS、
 * memory-revision.ts 的 REVISION_META_KEYS 必须保持一致。之所以在这里另列一份而不直接 import，
 * 是为了让本模块保持「零依赖」——一旦 import 那些模块，就会和它们反过来引用本模块形成循环。
 */
export const ENTRY_META_KEYS = {
    boxId: "eventBoxId",
    digestOf: "eventBoxDigestOf",
    archivedInto: "eventBoxArchivedInto",
    archivedAt: "eventBoxArchivedAt",
    supersededBy: "supersededBy",
    supersededAt: "supersededAt",
    revisionWeight: "revisionWeight",
    trashedAt: "trashedAt",
    trashedBy: "trashedBy",
    origin: "origin",
    editedByUser: "editedByUser",
    importedFrom: "importedFrom",
    provenanceBatchId: "provenanceBatchId",
    resplitFrom: "resplitFrom",
    summarizedEvents: "summarizedEvents",
    topicSplitV2: "topicSplitV2",
} as const;

/** 用户亲手产生（或亲手改过）的条目来源 */
const USER_OWNED_ORIGINS = new Set(["user_manual", "user_edited"]);

/**
 * 一条记忆的完整状态快照。
 * 所有字段都是「算出来的」，不做任何写操作；调用方只读。
 */
export type MemoryEntryState = {
    entryId: string;
    /** 长期记忆还是核心记忆 */
    isCore: boolean;

    /** 在「最近删除」里：不注入、不进主列表、不参与任何统计与淘汰 */
    trashed: boolean;
    /** 事件盒总结条目（由盒内成员归纳而来，代表已归档事件参与召回） */
    boxDigest: boolean;
    /** 已被吸收进某个盒的总结：由盒总结代表，不再单独注入 Prompt */
    boxArchived: boolean;
    /** 属于某个事件盒（盒总结或盒内成员）——事件盒是用户策展的档案，不参与上限淘汰 */
    inEventBox: boolean;
    /** 被新版本接替：正文仍有价值，但检索时应降权排到新版本后面，且不再被角色改写 */
    superseded: boolean;

    /** 用户亲手写/改/导入的条目 */
    userOwned: boolean;
    /** 由总结管道产出（自动总结、拆分、旧格式整理）——格式问题不代表它需要被重新整理 */
    pipelineGenerated: boolean;
    /** 角色反思旧条目（功能已移除，不应再参与展示与改写） */
    characterReflection: boolean;
    /** 用户手写的核心设定（角色只读） */
    userManual: boolean;

    /** 所属事件盒 id（盒内成员 / 盒总结都有） */
    boxId: string;
    /** 盒总结条目所属的盒 id */
    digestOfBoxId: string;
    /** 被归档进的盒 id */
    archivedIntoBoxId: string;
};

function readStr(meta: Record<string, unknown> | undefined, key: string): string {
    const raw = meta?.[key];
    return typeof raw === "string" && raw.length > 0 ? raw : "";
}

/**
 * 算出这条记忆的完整状态。**所有消费方都应该读这个结果，而不是自己去翻 metadata。**
 * 新增判定维度时只改这里一处，所有调用方自动同步。
 */
export function resolveMemoryEntryState(entry: MemoryEntry): MemoryEntryState {
    const meta = entry.metadata ?? {};
    const origin = readStr(meta, ENTRY_META_KEYS.origin);

    const boxId = readStr(meta, ENTRY_META_KEYS.boxId);
    const digestOfBoxId = readStr(meta, ENTRY_META_KEYS.digestOf);
    const archivedIntoBoxId = readStr(meta, ENTRY_META_KEYS.archivedInto);
    const trashed = readStr(meta, ENTRY_META_KEYS.trashedAt).length > 0;
    const boxDigest = digestOfBoxId.length > 0;

    const userManual = origin === "user_manual";
    const userOwned = USER_OWNED_ORIGINS.has(origin)
        || meta[ENTRY_META_KEYS.editedByUser] === true
        || readStr(meta, ENTRY_META_KEYS.importedFrom).length > 0;
    // 总结管道痕迹：有任一项就说明这条是按当前格式生成的，不该再被当成「待整理的历史格式」
    const pipelineGenerated = !userOwned && (
        meta[ENTRY_META_KEYS.topicSplitV2] === true
        || readStr(meta, ENTRY_META_KEYS.provenanceBatchId).length > 0
        || readStr(meta, ENTRY_META_KEYS.resplitFrom).length > 0
        || typeof meta[ENTRY_META_KEYS.summarizedEvents] === "number"
    );

    return {
        entryId: entry.id,
        isCore: entry.type === "core",
        trashed,
        boxDigest,
        boxArchived: archivedIntoBoxId.length > 0,
        // 盒总结本身也必须算「在事件盒里」，否则它会被当成普通记忆淘汰掉，盒子就只剩壳
        inEventBox: boxDigest || boxId.length > 0 || archivedIntoBoxId.length > 0,
        superseded: readStr(meta, ENTRY_META_KEYS.supersededBy).length > 0,
        userOwned,
        pipelineGenerated,
        characterReflection: origin === "character_reflection",
        userManual,
        boxId: boxId || digestOfBoxId || archivedIntoBoxId,
        digestOfBoxId,
        archivedIntoBoxId,
    };
}

// ── 各消费方的判定：全部基于同一份状态快照 ─────────────────────

/**
 * 收集「拥有有效盒总结」的盒子 id。
 * 盒总结被移入最近删除后，该盒子就没有代表条目了，盒内已归档的原始记忆必须兜底恢复召回，绝不丢记忆。
 */
export function collectDigestBoxIds(entries: MemoryEntry[]): Set<string> {
    const ids = new Set<string>();
    for (const entry of entries) {
        const state = resolveMemoryEntryState(entry);
        if (state.boxDigest && !state.trashed && state.digestOfBoxId) {
            ids.add(state.digestOfBoxId);
        }
    }
    return ids;
}

/** 这条记忆是否参与 Prompt 召回 */
export function isEntryRecallable(state: MemoryEntryState, digestBoxIds: Set<string>): boolean {
    // 删除优先级最高：无论归档与否，删除后都不再注入，直到用户从「最近删除」恢复
    if (state.trashed) return false;
    // 未被盒总结吸收的（含盒内新事件、盒外普通记忆、盒总结本身）正常召回
    if (!state.boxArchived) return true;
    // 已归档：只有该盒确实存在有效盒总结时才由总结代表
    return !digestBoxIds.has(state.archivedIntoBoxId);
}

/**
 * 这条记忆是否参与「长期记忆数量上限」的计数与淘汰。
 * 事件盒相关条目一律豁免——它们是用户亲手策展的档案，不该被上限逻辑清掉。
 */
export function isEntryEvictable(state: MemoryEntryState): boolean {
    return !state.trashed && !state.inEventBox;
}

/** 角色能不能通过「记忆管理」工具改动这条记忆 */
export function isEntryManageableByCharacter(state: MemoryEntryState): boolean {
    return !state.trashed
        && !state.superseded
        && !state.characterReflection
        && !(state.isCore && state.userManual);
}

/** 这条记忆是否还需要被「整理旧格式」处理（形态判断仍由调用方按正文做） */
export function isEntryLegacyCleanupEligible(state: MemoryEntryState): boolean {
    // 已删除的不整理；总结管道产出的不需要整理；事件盒条目不在这一层处理
    return !state.trashed && !state.pipelineGenerated && !state.inEventBox;
}

/**
 * 给这条记忆一个人话状态标签，供界面/排查时统一显示。
 * 优先级：删除 > 已归档 > 已被接替 > 盒总结 > 用户录入 > 自动总结。
 */
export function describeEntryState(state: MemoryEntryState): string {
    if (state.trashed) return "已在最近删除";
    if (state.boxArchived) return "已归档进事件盒";
    if (state.superseded) return "已被新版本接替";
    if (state.boxDigest) return "事件盒总结";
    if (state.userOwned) return "用户录入";
    if (state.pipelineGenerated) return "自动总结";
    return "未标记";
}
