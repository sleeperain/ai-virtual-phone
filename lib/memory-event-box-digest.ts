// lib/memory-event-box-digest.ts
// 事件盒的重总结 / 归档 / 恢复。
//
// 归档做的事：把盒内所有原始记忆喂给模型压成一条摘要记忆，
//   - 摘要条目作为普通长期记忆参与召回（代表整件事）
//   - 原始条目只写 metadata 标记，退出召回但**不删除**
// 恢复做的事：删摘要条目 + 清标记，原始条目原样回到独立召回。
//
// 刻意不做全自动聚合：把「聊养猫」和「聊养狗」折成一条，模型拿到错的事实
// 而且不知道自己拿的是错的，比漏折叠糟糕得多。所以只允许用户手动触发。

import type { MemoryEntry } from "./memory-types";
import { saveMemoryEntry, deleteMemoryEntry } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { resolveSummarizationApiConfig } from "./memory-summarizer";
import {
    EVENT_BOX_META_KEYS,
    getBoxEntries,
    getEntryBoxId,
    isEntryArchived,
    loadEventBoxes,
    saveEventBoxes,
    entryDateKey,
    type MemoryEventBox,
} from "./memory-event-boxes";

export const DEFAULT_EVENT_BOX_DIGEST_PROMPT = `你是一个事件整理助手。下面是{{char}}和用户之间围绕同一件事的一系列记忆记录，请把它们整理成一段连贯的事件摘要。

角色：{{char}}
事件：{{title}}
时间跨度：{{earliest}} 至 {{latest}}

记忆记录：
{{events}}

严格要求：
1. **按发展顺序叙述**：讲清楚这件事怎么开始、中间发生了什么、现在是什么状态。
2. **只合并，不新增**：不得虚构记录里没有的事实、对话或细节。
3. **以最新说法为准**：后来的记录推翻了先前的说法时（例如先说不吃辣、后来能吃微辣），只保留最新的，不要同时写上互相矛盾的表述。
4. **保留关键信息**：承诺、约定、关系变化、明确的偏好与结论必须留下；寒暄和流水账可以丢。
5. **不要写任何日期或时间字样**（如“10月23日”“上午”“傍晚”），系统另有字段记录时间。
6. 第三人称描述，80-200 字，不要列表符号、标题或任何格式标记，直接输出摘要正文。`;

const MAX_DIGEST_KEYWORDS = 10;

function uniqueStrings(items: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}

function readKeywords(entry: MemoryEntry): string[] {
    const raw = entry.metadata?.keywords;
    if (!Array.isArray(raw)) return [];
    return raw.map(String).filter(Boolean);
}

function createDigestEntryId(): string {
    return `mem_lt_boxdigest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 盒子里有没有「归档之后才进来的」新记忆——有的话应当提示重新总结 */
export function eventBoxNeedsRedigest(box: MemoryEventBox, entries: MemoryEntry[]): boolean {
    if (!box.archived) return false;
    return getBoxEntries(entries, box.id).some(entry => !isEntryArchived(entry));
}

/** 把一条记忆放进盒子（已在别的盒子里会先移出）。归档态下不自动归档，留给用户重新总结。 */
export async function moveEntryToBox(entry: MemoryEntry, boxId: string): Promise<MemoryEntry> {
    const next: MemoryEntry = {
        ...entry,
        updatedAt: new Date().toISOString(),
        metadata: {
            ...(entry.metadata ?? {}),
            [EVENT_BOX_META_KEYS.boxId]: boxId,
        },
    };
    await saveMemoryEntry(next);
    return next;
}

/** 把一条记忆移出盒子。如果它原本被归档，同时解除归档，让它立刻能独立参与召回。 */
export async function removeEntryFromBox(entry: MemoryEntry): Promise<MemoryEntry> {
    const metadata = { ...(entry.metadata ?? {}) };
    delete metadata[EVENT_BOX_META_KEYS.boxId];
    delete metadata[EVENT_BOX_META_KEYS.archivedInto];
    delete metadata[EVENT_BOX_META_KEYS.archivedAt];
    const next: MemoryEntry = {
        ...entry,
        updatedAt: new Date().toISOString(),
        metadata,
    };
    await saveMemoryEntry(next);
    return next;
}

/**
 * 重总结并归档。
 *
 * 摘要条目的 createdAt 沿用盒内最早的源条目：core-memory-builder 的增量判断是
 * `createdAt > lastCoreSummarizedTimestamp`，如果摘要用「现在」当 createdAt，
 * 每次重总结都会让同一批内容再进一次核心记忆，出现重复甚至互相矛盾的核心记忆。
 */
export async function runEventBoxDigest(
    characterId: string,
    characterName: string,
    boxId: string,
    entries: MemoryEntry[],
): Promise<{ success: boolean; error?: string; digestEntry?: MemoryEntry }> {
    const box = loadEventBoxes(characterId).find(item => item.id === boxId);
    if (!box) return { success: false, error: "事件盒不存在" };

    const boxEntries = getBoxEntries(entries, boxId);
    if (boxEntries.length === 0) {
        return { success: false, error: "这个事件盒里还没有记忆" };
    }

    const apiConfig = resolveSummarizationApiConfig(characterId);
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    const chronologic = [...boxEntries].sort((a, b) => entryDateKey(a).localeCompare(entryDateKey(b)));
    const earliest = entryDateKey(chronologic[0]);
    const latest = entryDateKey(chronologic[chronologic.length - 1]);
    const eventsText = chronologic
        .map(entry => `- [${entryDateKey(entry)}] ${entry.content.replace(/\s*\n+\s*/g, " ").trim()}`)
        .join("\n");

    const prompt = DEFAULT_EVENT_BOX_DIGEST_PROMPT
        .replace(/\{\{char\}\}/gi, characterName || "角色")
        .replace(/\{\{title\}\}/gi, box.title)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText);

    const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.3 });
    if (!result.content) {
        return { success: false, error: result.error || "事件摘要生成失败" };
    }
    if (result.wasTruncated) {
        return { success: false, error: "事件摘要疑似被截断，已取消归档，请稍后重试" };
    }
    const summaryText = result.content.trim();
    if (!summaryText) {
        return { success: false, error: "事件摘要为空" };
    }

    // 摘要条目要用和普通长期记忆一致的方式算向量：关键词拼在正文前，
    // 否则向量语义和查询侧对不齐，召回会退化成关键词兜底。
    const keywords = uniqueStrings(boxEntries.flatMap(readKeywords)).slice(0, MAX_DIGEST_KEYWORDS);
    const embeddingText = keywords.length > 0
        ? `关键词：${keywords.join("、")}\n${summaryText}`
        : summaryText;

    let embedding: number[] | undefined;
    const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            embedding = await generateEmbedding(embeddingText, embeddingApiConfig) ?? undefined;
        } catch {
            embedding = undefined; // 向量失败不挡归档，只是这条摘要走关键词兜底
        }
    }

    const existingDigest = box.digestEntryId
        ? entries.find(item => item.id === box.digestEntryId)
        : undefined;
    const now = new Date().toISOString();
    const maxImportance = boxEntries.reduce(
        (max, entry) => Math.max(max, Number.isFinite(entry.importance) ? entry.importance : 0.8),
        0.8,
    );

    // 来源 app 取占比最高的那个，便于按来源统计
    const sourceCounts = new Map<string, number>();
    for (const entry of boxEntries) {
        sourceCounts.set(entry.sourceApp, (sourceCounts.get(entry.sourceApp) ?? 0) + 1);
    }
    let dominantSource: MemoryEntry["sourceApp"] = "chat";
    let dominantCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > dominantCount) {
            dominantSource = src as MemoryEntry["sourceApp"];
            dominantCount = count;
        }
    }

    const digestEntry: MemoryEntry = {
        id: existingDigest?.id ?? createDigestEntryId(),
        characterId,
        sourceApp: dominantSource,
        type: "long_term",
        content: summaryText,
        embedding,
        importance: maxImportance,
        accessCount: existingDigest?.accessCount ?? 0,
        createdAt: existingDigest?.createdAt ?? chronologic[0].createdAt,
        updatedAt: now,
        metadata: {
            ...(existingDigest?.metadata ?? {}),
            origin: "event_box_digest",
            [EVENT_BOX_META_KEYS.boxId]: boxId,
            [EVENT_BOX_META_KEYS.digestOf]: boxId,
            eventDate: latest,
            keywords,
            sourceEntryCount: boxEntries.length,
            ...(embedding ? { embeddingDim: embedding.length } : {}),
        },
    };
    await saveMemoryEntry(digestEntry);

    // 源条目只打标记，不删不改正文，随时可恢复
    for (const entry of boxEntries) {
        if (isEntryArchived(entry)) continue;
        await saveMemoryEntry({
            ...entry,
            updatedAt: now,
            metadata: {
                ...(entry.metadata ?? {}),
                [EVENT_BOX_META_KEYS.boxId]: boxId,
                [EVENT_BOX_META_KEYS.archivedInto]: boxId,
                [EVENT_BOX_META_KEYS.archivedAt]: now,
            },
        });
    }

    const previousVersions = box.digest?.versions ?? [];
    const nextVersion = previousVersions.length + 1;
    const boxes = loadEventBoxes(characterId).map(item => (
        item.id === boxId
            ? {
                ...item,
                archived: true,
                digestEntryId: digestEntry.id,
                updatedAt: now,
                digest: {
                    current: summaryText,
                    versions: [
                        ...previousVersions,
                        {
                            version: nextVersion,
                            text: summaryText,
                            sourceIds: boxEntries.map(entry => entry.id),
                            generatedAt: now,
                        },
                    ],
                },
            }
            : item
    ));
    saveEventBoxes(characterId, boxes);

    return { success: true, digestEntry };
}

/**
 * 恢复原始记忆：删掉摘要条目，清掉盒内条目的归档标记。
 * 盒子的 digest 历史留着（用户还能回看当初总结过什么），但归档态解除。
 */
export async function restoreEventBox(
    characterId: string,
    boxId: string,
    entries: MemoryEntry[],
): Promise<{ success: boolean; error?: string; restoredCount: number }> {
    const boxes = loadEventBoxes(characterId);
    const box = boxes.find(item => item.id === boxId);
    if (!box) return { success: false, error: "事件盒不存在", restoredCount: 0 };

    const boxEntries = getBoxEntries(entries, boxId);
    const now = new Date().toISOString();
    let restoredCount = 0;

    for (const entry of boxEntries) {
        if (!isEntryArchived(entry)) continue;
        const metadata = { ...(entry.metadata ?? {}) };
        delete metadata[EVENT_BOX_META_KEYS.archivedInto];
        delete metadata[EVENT_BOX_META_KEYS.archivedAt];
        await saveMemoryEntry({ ...entry, updatedAt: now, metadata });
        restoredCount += 1;
    }

    // 摘要条目本身就是这次折叠的产物，恢复后它没有存在意义（留着会和新恢复的源条目重复注入）
    const digestId = box.digestEntryId;
    if (digestId) {
        await deleteMemoryEntry(digestId);
    }

    saveEventBoxes(characterId, boxes.map(item => (
        item.id === boxId
            ? { ...item, archived: false, digestEntryId: undefined, updatedAt: now }
            : item
    )));

    return { success: true, restoredCount };
}

/** 删除盒子：先把源条目解归档，再删盒子并清掉条目的归属，记忆一条不丢 */
export async function deleteEventBoxKeepEntries(
    characterId: string,
    boxId: string,
    entries: MemoryEntry[],
): Promise<{ success: boolean; detachedCount: number }> {
    const boxEntries = getBoxEntries(entries, boxId).filter(entry => getEntryBoxId(entry) === boxId);
    const boxes = loadEventBoxes(characterId);
    const box = boxes.find(item => item.id === boxId);
    const now = new Date().toISOString();
    let detachedCount = 0;

    for (const entry of boxEntries) {
        const metadata = { ...(entry.metadata ?? {}) };
        delete metadata[EVENT_BOX_META_KEYS.boxId];
        delete metadata[EVENT_BOX_META_KEYS.archivedInto];
        delete metadata[EVENT_BOX_META_KEYS.archivedAt];
        await saveMemoryEntry({ ...entry, updatedAt: now, metadata });
        detachedCount += 1;
    }

    if (box?.digestEntryId) {
        await deleteMemoryEntry(box.digestEntryId);
    }

    saveEventBoxes(characterId, boxes.filter(item => item.id !== boxId));
    return { success: true, detachedCount };
}
