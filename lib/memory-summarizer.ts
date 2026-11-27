// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT, DEFAULT_MANUAL_TEXT_CLEAN_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbeddingsBatch, resolveEmbeddingModel, cosineSimilarity, tokenJaccardRatio } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";
import {
    buildSupersededMetadata,
    computeSupersededSpans,
    effectiveImportance,
    isEntrySuperseded,
    REVISION_CROSS_DAY_THRESHOLD,
    REVISION_EXACT_THRESHOLD,
    REVISION_KEYWORD_FALLBACK_THRESHOLD,
    REVISION_MATCH_THRESHOLD,
    REVISION_META_KEYS,
} from "./memory-revision";

import { loadBindingConfig, loadApiConfigs, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { loadCharacters } from "./character-storage";
import {
    resolveMemoryProvenance,
    saveProvenanceBatch,
    toProvenanceEntry,
} from "./memory-provenance";
import { isEntryTrashed, trashMemoryEntry } from "./memory-trash";
import {
    isEntryEvictable,
    isEntryLegacyCleanupEligible,
    resolveMemoryEntryState,
} from "./memory-entry-state";

/**
 * 提取角色的基础身份与人称代词提示，专门提供给长期记忆、事件盒与核心记忆总结 Prompt，
 * 彻底杜绝模型在只看到角色名字（尤其古风/中性名）时把男性角色默认写成「她」的问题。
 */
export function buildCharacterSummaryProfile(characterId: string, fallbackName?: string): string {
    const char = loadCharacters().find(c => c.id === characterId);
    const charName = char?.name?.trim() || fallbackName?.trim() || "角色";
    const userIdentity = resolveUserIdentity(characterId);
    const userName = userIdentity?.name?.trim() || "";

    if (!char) {
        return `角色名称：${charName}（若不确定性别，请直接称呼名字「${charName}」，勿随意假设为「她」）`;
    }

    const tagsText = Array.isArray(char.tags) ? char.tags.map(t => String(t).trim()).filter(Boolean).join("、") : "";
    const rawPersona = [char.briefPersona, char.persona, char.personality, tagsText].filter(Boolean).join("\n");

    let pronounHint = "";
    // 优先匹配显式性别字段或明确男女性别描述
    const explicitMale = /(?:性别\s*[：:是为]?\s*男|(?:\b|[^女])男性|男生|少年|男人|青年男|公子|先生|少爷|兄长|哥哥|男友|丈夫|老公|帝王|将军|师尊.*男|人称\s*[：:]?\s*他)/.test(rawPersona)
        || (rawPersona.includes("他") && !rawPersona.includes("她"));
    const explicitFemale = /(?:性别\s*[：:是为]?\s*女|(?:\b|[^男])女性|女生|少女|女人|小姐|姑娘|姐姐|妹妹|女友|妻子|老婆|人称\s*[：:]?\s*她)/.test(rawPersona)
        || (rawPersona.includes("她") && !rawPersona.includes("他"));

    if (explicitMale && !explicitFemale) {
        pronounHint = `性别与代词铁律：「${charName}」是**男性角色**，总结中指代「${charName}」时**必须统一使用第三人称「他」或直接称呼「${charName}」，绝对严禁写成「她」**！`;
    } else if (explicitFemale && !explicitMale) {
        pronounHint = `性别与代词铁律：「${charName}」是**女性角色**，总结中指代「${charName}」时使用「她」或直接称呼「${charName}」。`;
    } else {
        // 统计人设里「他」与「她」出现频次做辅助判断
        const heCount = (rawPersona.match(/他/g) ?? []).length;
        const sheCount = (rawPersona.match(/她/g) ?? []).length;
        if (heCount >= sheCount + 2) {
            pronounHint = `性别与代词铁律：「${charName}」为**男性角色**，指代「${charName}」时**必须使用「他」或直接写名字「${charName}」，严禁误写为「她」**！`;
        } else if (sheCount >= heCount + 2) {
            pronounHint = `性别与代词铁律：「${charName}」为**女性角色**，指代「${charName}」时请使用「她」或直接写名字「${charName}」。`;
        } else {
            pronounHint = `代词规范：请严格按下方设定判断「${charName}」的性别代词；若无法100%确认性别，请直接称呼名字「${charName}」，切勿盲目默认使用「她」。`;
        }
    }

    const snippetSource = (char.briefPersona?.trim() || char.persona?.trim() || "").replace(/\s+/g, " ").slice(0, 260);
    const lines: string[] = [pronounHint];
    if (tagsText) lines.push(`角色标签：${tagsText}`);
    if (snippetSource) lines.push(`角色设定摘要：${snippetSource}${snippetSource.length >= 260 ? "…" : ""}`);
    if (userName) lines.push(`互动对象（用户）名称：${userName}`);
    return lines.join("\n");
}

/**
 * 将角色基本信息注入任意总结模板：若模板含 {{charProfile}} 则原地替换，
 * 若用户使用了旧版自定义模板未写 {{charProfile}}，则自动补充在「角色：XXX」行下方或模板开头。
 */
export function injectCharacterProfileIntoPrompt(
    prompt: string,
    charProfile: string,
): string {
    if (!charProfile.trim()) return prompt.replace(/\{\{charProfile\}\}/gi, "");
    if (/\{\{charProfile\}\}/i.test(prompt)) {
        return prompt.replace(/\{\{charProfile\}\}/gi, charProfile);
    }
    if (/角色\s*[：:][^\n]*/.test(prompt)) {
        return prompt.replace(/(角色\s*[：:][^\n]*)/, `$1\n${charProfile}`);
    }
    return `【角色身份与代词基准】\n${charProfile}\n\n${prompt}`;
}

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

/** Legacy default prompt before Markdown + keywords + unresolved issues upgrade */
const LEGACY_SUMMARIZATION_PROMPT_SIGNATURE = "不要包含格式标记";

export type ParsedMemoryMetadata = {
    keywords: string[];
    importance?: number; // 0-1 normalized
    eventDate?: string;  // YYYY-MM-DD extracted from resplit output
};

/**
 * Strip inline date/time headers and timestamps from memory body so the stored text itself
 * does not contain time markers (the entry's eventDate metadata carries the date).
 */
export function stripInlineMemoryTimeMarkers(content: string): string {
    return content
        .replace(/^(?:#+\s*)?(?:\d{4}年)?\d{1,2}月\d{1,2}日(?:[上中下]午|早[上晨]|傍晚|晚上|深夜|凌晨|中午|夜里|夜间)?\s*$/gm, "")
        .replace(/^(?:#+\s*)?\d{4}-\d{2}-\d{2}(?:\s+(?:[上中下]午|早[上晨]|傍晚|晚上|深夜|凌晨))?\s*$/gm, "")
        .replace(/^(\s*[-*•]?\s*)(?:\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]|\(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\)|\d{1,2}:\d{2}(?:\s*[-~至]\s*\d{1,2}:\d{2})?)\s*[-—:：]?\s*/gm, "$1")
        .replace(/^(\s*[-*•]?\s*)(?:\d{4}年)?\d{1,2}月\d{1,2}日(?:[上中下]午|早[上晨]|傍晚|晚上|深夜|凌晨|中午)?[，,、：\s]+/gm, "$1")
        .replace(/【未解决[^】]*】/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Strip the trailing structured sections (**重要性**, **检索关键词**, legacy ### 未解决问题 / ### 事件总结) from display body
 * so they aren't rendered twice when the card already displays them as metadata badges/chips.
 */
export function stripMemoryStructuredSections(content: string): string {
    const stripped = content
        .replace(/^###\s*事件总结\s*\n+/i, "")
        .replace(/\n*###\s*未解决问题[\s\S]*?(?=\n###|\n\*\*事件日期\*\*|\n事件日期|\n\*\*重要性\*\*|\n重要性|\n\*\*检索关键词\*\*|\n检索关键词|$)/gi, "")
        .replace(/\n*(?:\*\*事件日期\*\*|事件日期|所属日期|日期)\s*[：:][^\n]*/gi, "")
        .replace(/\n*(?:\*\*重要性\*\*|重要性|重要程度)\s*[：:][^\n]*/gi, "")
        .replace(/\n*(?:\*\*检索关键词\*\*|检索关键词|关键词)\s*[：:][^\n]*/gi, "")
        .trim();
    return stripInlineMemoryTimeMarkers(stripped);
}

/**
 * Extract first natural date from arbitrary raw text and normalize to YYYY-MM-DD.
 * Supports: 2025-10-23, 2025/10/23, 2025.10.23, 2025年10月23日, 10月23日 (uses fallbackYear).
 */
export function extractDateFromRawText(text: string, fallbackYear?: number): string | undefined {
    const year = fallbackYear ?? new Date().getFullYear();
    // 1. Explicit structured field first
    const fieldMatch = text.match(/(?:\*\*事件日期\*\*|事件日期|所属日期|日期)\s*[：:]\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/i);
    if (fieldMatch) {
        const y = Number(fieldMatch[1]);
        const m = Number(fieldMatch[2]);
        const d = Number(fieldMatch[3]);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        }
    }
    // 2. Full YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYY年M月D日 anywhere in text
    const fullMatch = text.match(/(?:^|[^\d])(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?=$|[^\d])/);
    if (fullMatch) {
        const y = Number(fullMatch[1]);
        const m = Number(fullMatch[2]);
        const d = Number(fullMatch[3]);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        }
    }
    // 3. M月D日 or M月D号
    const mdMatch = text.match(/(?:^|[^\d])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
    if (mdMatch) {
        const m = Number(mdMatch[1]);
        const d = Number(mdMatch[2]);
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
            return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        }
    }
    return undefined;
}

/**
 * Extract vector retrieval keywords, importance, and optional eventDate from Markdown memory content.
 */
export function extractMemoryStructuredMeta(content: string): ParsedMemoryMetadata {
    const keywords: string[] = [];
    let importance: number | undefined;
    const eventDate = extractDateFromRawText(content);

    // 1. Extract importance (supports 1-10 or 0-1 or percentage)
    const impMatch = content.match(/(?:\*\*重要性\*\*|重要性|重要程度)\s*[：:]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*10|%)?/i);
    if (impMatch?.[1]) {
        const rawNum = parseFloat(impMatch[1]);
        if (Number.isFinite(rawNum)) {
            if (rawNum > 1 && rawNum <= 10) {
                importance = Math.max(0.1, Math.min(1, Number((rawNum / 10).toFixed(2))));
            } else if (rawNum > 10 && rawNum <= 100) {
                importance = Math.max(0.1, Math.min(1, Number((rawNum / 100).toFixed(2))));
            } else if (rawNum >= 0 && rawNum <= 1) {
                importance = Math.max(0.1, Math.min(1, Number(rawNum.toFixed(2))));
            }
        }
    }

    // 2. Extract keywords from **检索关键词**：... or 检索关键词：... or [关键词：...]
    const kwMatch = content.match(/(?:\*\*检索关键词\*\*|检索关键词|关键词)\s*[：:]\s*([^\n]+)/i);
    if (kwMatch?.[1]) {
        const rawList = kwMatch[1]
            .replace(/^[`[\]【】\s]+|[`[\]【】\s]+$/g, "")
            .split(/[、，,；;|/]+/)
            .map(s => s.replace(/^[-*#`]+|[-*#`]+$/g, "").trim())
            .filter(Boolean);
        for (const kw of rawList) {
            if (!keywords.includes(kw)) keywords.push(kw);
        }
    }

    // Fallback keyword extraction if LLM omitted the explicit line
    if (keywords.length === 0) {
        const boldMatches = content.match(/\*\*([^*]{2,12})\*\*/g) || [];
        for (const m of boldMatches) {
            const word = m.replace(/\*\*/g, "").trim();
            if (word && !/^(事件日期|所属日期|重要性|检索关键词|关键词|事件总结|未解决问题)$/.test(word) && !keywords.includes(word)) {
                keywords.push(word);
                if (keywords.length >= 6) break;
            }
        }
    }

    return { keywords, importance, eventDate };
}

/**
 * Split a day's LLM summary output into multiple topic-level memory segments.
 * Supports `---` horizontal rules or multiple blocks each ending with `**检索关键词**`.
 */
export function splitMultiTopicSummaries(rawOutput: string): string[] {
    const trimmed = rawOutput.trim();
    if (!trimmed) return [];

    const byHr = trimmed
        .split(/\n\s*---+\s*\n/)
        .map(s => s.trim())
        .filter(Boolean);
    if (byHr.length > 1) return byHr;

    const kwRegex = /(?:\*\*检索关键词\*\*|检索关键词|关键词)\s*[：:][^\n]+(?:\n|$)/gi;
    const matches = Array.from(trimmed.matchAll(kwRegex));
    if (matches.length > 1) {
        const blocks: string[] = [];
        let lastIndex = 0;
        for (const m of matches) {
            const endIdx = (m.index ?? 0) + m[0].length;
            const chunk = trimmed.slice(lastIndex, endIdx).trim();
            if (chunk) blocks.push(chunk);
            lastIndex = endIdx;
        }
        const tail = trimmed.slice(lastIndex).trim();
        if (tail && stripMemoryStructuredSections(tail).length > 10) {
            blocks.push(tail);
        }
        if (blocks.length > 1) return blocks;
    }

    return [trimmed];
}

/**
 * Convert an ISO timestamp into local date key "YYYY-MM-DD".
 */
function toLocalDayKey(isoStr: string): string {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.slice(0, 10) || "未知日期";
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Resolve API config for memory summarization with character-level fallback:
 * 1. Auxiliary binding `memorySummaryApiConfigId`
 * 2. Global default `apiConfigId`
 * 3. Character's bound `apiConfigId` (chat / default)
 * 4. First valid configured API
 */
export function resolveSummarizationApiConfig(characterId: string) {
    const aux = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (aux && aux.apiKey) return aux;
    const bindingCfg = loadBindingConfig();
    const apiConfigs = loadApiConfigs();
    const charSlot = resolveBinding(bindingCfg, characterId, "chat");
    if (charSlot.apiConfigId) {
        const found = apiConfigs.find(c => c.id === charSlot.apiConfigId && c.apiKey);
        if (found) return found;
    }
    return apiConfigs.find(c => Boolean(c.apiKey)) ?? aux ?? null;
}

/**
 * Check if summarization should run based on event counter OR unsummarized timeline count, then execute.
 * Fixes the bug where counter was out of sync with actual unsummarized events or failed silently after threshold.
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const interval = Math.max(4, config.summarizationEventInterval || 80);
    let counter = getEventCounter(characterId);

    // Self-healing check: even if counter was reset or missed (e.g. native tools or page reload),
    // check actual unsummarized timeline entries since last watermark.
    if (counter < interval) {
        try {
            const afterTimestamp = getLastSummarizedTimestamp(characterId) ?? undefined;
            const unsummarizedCount = filterTimelineByAllowedSources(
                loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
                config.shortTermAllowedSources,
            ).length;
            if (unsummarizedCount >= interval) {
                counter = unsummarizedCount;
            }
        } catch { /* ignore */ }
    }

    if (counter < interval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        const res = await runSummarizationPipeline(characterId, characterName);
        if (!res.success) {
            console.warn(`[MemorySummarizer] Auto-summarization failed for ${characterName}: ${res.error}`);
        }
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding (with fallback to character/global API config)
    const apiConfig = resolveSummarizationApiConfig(characterId);
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    let allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );

    if (allEntries.length < 4) {
        // 不要在事件不足 4 条时直接把 counter 清零——否则用户刚过阈值但因时间戳微差或过滤后
        // 暂时不足 4 条时，计数器归零会导致后续再发几十条都不触发总结！
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    // Cap batch size for automatic background trigger so a huge backlog doesn't block in one go
    const MAX_AUTO_BATCH_ENTRIES = 160;
    const isManualRange = Boolean(options?.force || options?.sinceTimestamp);
    if (!isManualRange && allEntries.length > MAX_AUTO_BATCH_ENTRIES) {
        allEntries = allEntries.slice(0, MAX_AUTO_BATCH_ENTRIES);
    }

    // Group entries by local calendar day (YYYY-MM-DD) so each day's events are summarized
    // independently instead of mixing multiple days into one messy wall of text.
    const dayBuckets = new Map<string, typeof allEntries>();
    for (const entry of allEntries) {
        const dayKey = toLocalDayKey(entry.timestamp);
        const list = dayBuckets.get(dayKey);
        if (list) list.push(entry);
        else dayBuckets.set(dayKey, [entry]);
    }

    const sortedDays = Array.from(dayBuckets.keys()).sort((a, b) => a.localeCompare(b));

    // Use user-editable prompt template from config; auto-upgrade legacy default prompt
    const rawSavedPrompt = config.summarizationPrompt?.trim() || "";
    const isLegacyDefault = rawSavedPrompt.includes(LEGACY_SUMMARIZATION_PROMPT_SIGNATURE)
        || rawSavedPrompt.includes("### 未解决问题")
        || rawSavedPrompt.includes("时间跨度：{{earliest}}")
        || rawSavedPrompt.includes("控制在 80-200 字左右");
    let promptTemplate = (!rawSavedPrompt || isLegacyDefault)
        ? DEFAULT_SUMMARIZATION_PROMPT
        : rawSavedPrompt;

    const charProfile = buildCharacterSummaryProfile(characterId, characterName);

    // Enforce our core rules even when the user has a custom summarization prompt:
    const ruleEnforcement = `\n\n【硬性事实与格式要求（最高优先级）】：\n1. **严格核对角色性别代词与玩笑边界**：严格依据角色设定使用正确的「他/她」（男性角色严禁写成「她」）；凡是调侃、玩笑、打比方、假设（如“调侃他扮作某人也没人看出”），必须写明是“调侃/开玩笑”，严禁脱离语境改写成“曾经真实做过某事”！\n2. **按独立话题拆条，严禁强加因果**：同一天或同一场景中发生的多件互不相关的事、不同机制或独立话题，必须用单独一行的 \`---\` 拆成多条独立记忆；除非原始记录中明确写明了因果或前提关系，否则严禁将两件独立的事合并成一条，也严禁自行补出原文不存在的因果关联。\n3. **记忆正文中严禁出现任何日期或具体时间**（如“10月23日”、“上午”、“18:03”等一律不写，系统会自动记录该记忆所属日期）。\n4. 每条记忆末尾必须各自单独输出两行：\n**重要性**：（1-10的整数）\n**检索关键词**：关键词1、关键词2、关键词3`;
    if (!promptTemplate.includes("假戏真做") && !promptTemplate.includes("玩笑边界")) {
        promptTemplate += ruleEnforcement;
    }

    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    const canEmbed = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig));

    // Load existing active long-term entries for deduplication check (exclude trashed entries!)
    const existingLongTerm = (await loadMemoryEntriesByType(characterId, "long_term"))
        .filter(e => !isEntryTrashed(e));

    let summarizedDayCount = 0;
    let savedEntryCount = 0;
    let lastError = "";
    let latestSummarizedTs = "";
    // 本轮（这一次总结任务）亲手创建/合并过的条目 id。
    // 同批拆出来的第 N 条会立刻出现在候选池里，如果不排除，第 1 条就可能被它判成「旧版本」。
    const runCreatedIds = new Set<string>();

    for (let dayIdx = 0; dayIdx < sortedDays.length; dayIdx++) {
        const dayKey = sortedDays[dayIdx];
        const dayEntries = dayBuckets.get(dayKey)!;
        // Format events with timeAware=false so individual event timestamps are stripped before sending to LLM
        const formatted = formatTimelineForSummarization(dayEntries, { timeAware: false });
        if (!formatted) continue;

        const { eventsText, earliest, latest } = formatted;
        const summaryPrompt = injectCharacterProfileIntoPrompt(
            promptTemplate
                .replace(/\{\{char\}\}/gi, characterName)
                .replace(/\{\{earliest\}\}/gi, dayKey)
                .replace(/\{\{latest\}\}/gi, dayKey)
                .replace(/\{\{events\}\}/gi, eventsText),
            charProfile,
        );

        let result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: summaryPrompt }],
            { temperature: 0.3, label: `记忆总结·${characterName}·${dayKey}` },
        );
        if (!result.content && !result.wasTruncated) {
            await new Promise(r => setTimeout(r, 1200));
            result = await simpleLLMCall(
                apiConfig,
                [{ role: "user", content: summaryPrompt }],
                { temperature: 0.3, label: `记忆总结重试·${characterName}·${dayKey}` },
            );
        }

        if (!result.content) {
            lastError = result.error || `总结 ${dayKey} 时 LLM 返回了空内容`;
            continue;
        }

        if (result.wasTruncated && result.content.trim().length < 40) {
            lastError = `总结 ${dayKey} 结果疑似被截断`;
            continue;
        }

        const rawSummary = result.content.trim();
        const topicBlocks = splitMultiTopicSummaries(rawSummary);

        // Determine dominant sourceApp for this day's entries
        const sourceCounts = new Map<string, number>();
        for (const e of dayEntries) {
            sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
        }
        let dominantSource = "chat";
        let maxCount = 0;
        for (const [src, count] of sourceCounts) {
            if (count > maxCount) { dominantSource = src; maxCount = count; }
        }
        const sourceSessionIds = Array.from(new Set(
            dayEntries
                .map(entry => entry.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId)),
        ));

        // 原文存档：把这批拆条所依据的原始事件完整留档，
        // 之后每条记忆都能顺着 batchId 回看「这句话是从哪些原话里炼出来的」。
        // 存档写在独立 kv 里，不进记忆库、不占记忆注入预算。
        const provenanceBatchId = saveProvenanceBatch({
            characterId,
            dayKey,
            entries: dayEntries.map(toProvenanceEntry),
            earliest,
            latest,
        });

        // Parse all blocks for this day first so we can batch-generate embeddings
        const parsedTopics: Array<{
            cleanBody: string;
            keywords: string[];
            importance: number;
            embeddingInput: string;
        }> = [];

        for (const block of topicBlocks) {
            const { keywords, importance } = extractMemoryStructuredMeta(block);
            const cleanSummaryBody = stripMemoryStructuredSections(block) || stripInlineMemoryTimeMarkers(block);
            if (!cleanSummaryBody) continue;
            const embeddingInput = keywords.length > 0
                ? `关键词：${keywords.join("、")}\n${cleanSummaryBody}`
                : cleanSummaryBody;
            parsedTopics.push({
                cleanBody: cleanSummaryBody,
                keywords,
                importance: importance ?? 0.8,
                embeddingInput,
            });
        }

        if (parsedTopics.length === 0) continue;

        let batchEmbeddings: Array<number[] | null> = [];
        if (canEmbed && embeddingApiConfig) {
            try {
                batchEmbeddings = await generateEmbeddingsBatch(
                    parsedTopics.map(t => t.embeddingInput),
                    embeddingApiConfig,
                );
            } catch { /* ignore */ }
        }

        for (let topicIdx = 0; topicIdx < parsedTopics.length; topicIdx++) {
            const topic = parsedTopics[topicIdx];
            const embedding = batchEmbeddings[topicIdx] ?? undefined;
            // createdAt 用真实写入时间：原先按 dayIdx * 100 加偏移，会造出「未来时间」，
            // 任何按 createdAt 判新旧的逻辑都会错位（天级信息只应该放在 metadata.eventDate）。
            const createdAtIso = new Date(Date.now() + topicIdx).toISOString();

            // 相似记忆处理，分两种情形：
            // 1. 几乎一字不差（相似度 >= REVISION_EXACT_THRESHOLD）：合并进旧条目，沿用原行为；
            // 2. 部分或全部被改写：旧条目保留，把被改掉的字句标成「划掉」并降权，新记忆独立入库。
            //    这样「原来住城东」改成「搬去城西」时，旧记忆不会连着新事实一起消失。
            const match = findNearDuplicateMemory(
                existingLongTerm,
                dayKey,
                topic.cleanBody,
                topic.keywords,
                embedding,
                runCreatedIds,
            );
            // 划掉区间的基准必须是「显示用的正文」而不是原始 content：
            // 卡片渲染时展示的是 stripMemoryStructuredSections 之后的内容，
            // 用原始 content 算偏移会因为末尾元数据段被剥掉而错位。
            const oldBaseText = match
                ? (stripMemoryStructuredSections(match.entry.content) || match.entry.content)
                : "";
            // 只有「向量口径命中 + 不是本批刚建 + 不是几乎一字不差」才允许算划线区间；
            // 关键词兜底命中、以及同批拆条之间，一律按重复合并处理，绝不划线降权。
            const canRevise = Boolean(
                match
                && match.source === "vector"
                && !match.sameRun
                && match.similarity < REVISION_EXACT_THRESHOLD
            );
            const revision = canRevise && match
                ? computeSupersededSpans(oldBaseText, topic.cleanBody)
                : null;
            const duplicate = match && (!revision || revision.spans.length === 0) ? match.entry : null;
            // 兜底闸门：绝不把「比这条新记忆更新」的条目标成被改写。
            // 补总结 / 强制重跑 / 水位线重置时，命中更晚日期的记忆就是这个闸门拦住的情况。
            const oldCreatedMs = match ? Date.parse(match.entry.createdAt) : 0;
            const newCreatedMs = Date.parse(createdAtIso);
            // 时间戳缺失/畸形时不拦（方向门槛已由 eventDate 兜住），只在能确定「旧条目更新」时放弃标注
            const oldIsNotNewer = Number.isNaN(oldCreatedMs) || Number.isNaN(newCreatedMs) || oldCreatedMs <= newCreatedMs;
            const willSupersedeOld = Boolean(
                match
                && revision
                && revision.spans.length > 0
                && oldIsNotNewer
            );
            if (duplicate) {
                const existingKws = Array.isArray(duplicate.metadata?.keywords)
                    ? (duplicate.metadata.keywords as unknown[]).map(String)
                    : [];
                const mergedKeywords = Array.from(new Set([...existingKws, ...topic.keywords])).slice(0, 10);
                // 合并时以「这次模型新总结的正文」为准。
                // 原先取「谁长用谁」，而旧条目若来自更早版本、正文还带着 **重要性**/**检索关键词** 段，
                // 天然比剥离元数据后的新总结更长，于是新总结被静默丢弃、只刷新了元数据（用户看到的就是
                // 「记忆被改了却没更新内容」）。只有当新正文明显更短（说明这次是压缩版，丢掉会损信息）时才保留旧正文。
                const previousBody = stripMemoryStructuredSections(duplicate.content) || duplicate.content;
                const keepNewBody = topic.cleanBody.length >= previousBody.length * 0.6;
                const mergedContent = keepNewBody ? topic.cleanBody : previousBody;
                // 正文被换成新文本时，旧的划掉区间（按老正文下标算的）已经失效，必须一并清掉，
                // 否则删除线会画到毫不相干的位置上。
                const contentReplaced = mergedContent !== duplicate.content;
                const mergedMetadata: Record<string, unknown> = {
                    ...(duplicate.metadata ?? {}),
                    // 日期只允许往后推：补总结/重跑时若把已有记忆的日期改早，它在时间线和召回排序里
                    // 就会「凭空变旧」，这也是「刚总结的记忆却显示成旧记忆」的来源之一。
                    eventDate: dayKey > entryEventDateOf(duplicate) ? dayKey : entryEventDateOf(duplicate),
                    keywords: mergedKeywords,
                    // 合并进旧条目时同步刷新溯源指向，否则详情里看到的是上一批原文
                    provenanceBatchId,
                    ...(embedding ? { embeddingDim: embedding.length } : {}),
                };
                if (contentReplaced) {
                    delete mergedMetadata[REVISION_META_KEYS.by];
                    delete mergedMetadata[REVISION_META_KEYS.at];
                    delete mergedMetadata[REVISION_META_KEYS.spans];
                    delete mergedMetadata[REVISION_META_KEYS.ratio];
                    delete mergedMetadata[REVISION_META_KEYS.similarity];
                    // 权重也还原：这条现在就是最新版本
                    delete mergedMetadata[REVISION_META_KEYS.weight];
                }
                const mergedEntry: MemoryEntry = {
                    ...duplicate,
                    content: mergedContent,
                    embedding: embedding ?? duplicate.embedding,
                    importance: Math.max(duplicate.importance ?? 0.8, topic.importance),
                    updatedAt: createdAtIso,
                    metadata: mergedMetadata,
                };
                await saveMemoryEntry(mergedEntry);
                const idx = existingLongTerm.findIndex(e => e.id === duplicate.id);
                if (idx !== -1) existingLongTerm[idx] = mergedEntry;
                // 合并过的条目等同于本轮产出：后面的拆条不能再把它判成「旧版本」
                runCreatedIds.add(mergedEntry.id);
                savedEntryCount += 1;
                continue;
            }

            const newEntryId = `mem_lt_${Date.now()}_${dayIdx}_${topicIdx}_${Math.random().toString(36).slice(2, 7)}`;
            const longTermEntry: MemoryEntry = {
                id: newEntryId,
                characterId,
                sourceApp: dominantSource as MemoryEntry["sourceApp"],
                type: "long_term",
                content: topic.cleanBody,
                embedding,
                importance: topic.importance,
                accessCount: 0,
                createdAt: createdAtIso,
                updatedAt: createdAtIso,
                metadata: {
                    eventDate: dayKey,
                    summarizedEvents: dayEntries.length,
                    timeSpan: `${earliest} ~ ${latest}`,
                    sourceSessionIds,
                    accessCount: 0,
                    keywords: topic.keywords,
                    topicSplitV2: true,
                    // 原文溯源：指向本批原始事件的存档，记忆库详情里可展开回看
                    provenanceBatchId,
                    // 这条记忆改写了哪条旧记忆：点进详情时能顺着找回去
                    ...(willSupersedeOld && match ? { revisesMemoryId: match.entry.id } : {}),
                    ...(embedding ? { embeddingDim: embedding.length } : {}),
                },
            };
            await saveMemoryEntry(longTermEntry);

            // 旧记忆不让位：把被改写的字句标成划掉并降权，其余内容照旧可用。
            if (willSupersedeOld && match && revision) {
                const supersededEntry: MemoryEntry = {
                    ...match.entry,
                    updatedAt: createdAtIso,
                    metadata: buildSupersededMetadata(match.entry, newEntryId, revision, undefined, oldBaseText.length),
                };
                await saveMemoryEntry(supersededEntry);
                const oldIdx = existingLongTerm.findIndex(e => e.id === match.entry.id);
                if (oldIdx !== -1) existingLongTerm[oldIdx] = supersededEntry;
            }

            existingLongTerm.unshift(longTermEntry);
            runCreatedIds.add(longTermEntry.id);
            savedEntryCount += 1;
        }

        latestSummarizedTs = latest;
        summarizedDayCount += 1;
        incrementCoreMemoryCounter(characterId);
    }

    if (summarizedDayCount === 0 || savedEntryCount === 0) {
        return { success: false, error: lastError || "未能生成有效的记忆总结" };
    }

    // Update last summarized timestamp + reset counter
    // When summarizing a manual recent window (sinceTimestamp), only advance the watermark
    // if there wasn't an older unsummarized gap before sinceTimestamp, and never move the watermark backwards.
    if (latestSummarizedTs) {
        const prevWatermark = getLastSummarizedTimestamp(characterId);
        const skipsUnsummarizedGap = Boolean(
            options?.sinceTimestamp && (!prevWatermark || options.sinceTimestamp > prevWatermark)
        );
        if (!skipsUnsummarizedGap && (!prevWatermark || latestSummarizedTs > prevWatermark)) {
            setLastSummarizedTimestamp(characterId, latestSummarizedTs);
        }
    }
    resetEventCounter(characterId);

    // Enforce long-term limit (only on ordinary active long_term entries.
    // Never count or evict: trashed / core memories / 事件盒相关条目!)
    const activeLongTerm = (await loadMemoryEntriesByType(characterId, "long_term"))
        .filter(e => !isEntryTrashed(e));
    // 事件盒是用户亲手策展的档案，盒总结条目与盒内条目一律不参与淘汰与计数。
    // 原先它们和其他条目一起排队：盒总结的 createdAt 被设成盒内最早那条的时间、已归档条目也保留
    // 原始的早年时间，而淘汰是「越老越先删」，于是一个时间久远的事件盒会被整盒清空，
    // 盒记录（存在独立 kv 里）却还在，界面就只剩一个空壳。
    const evictableEntries = activeLongTerm.filter(e => isEntryEvictable(resolveMemoryEntryState(e)));
    if (evictableEntries.length > config.maxLongTermEntries) {
        const evictionSorted = [...evictableEntries].sort((a, b) => {
            // 用「修订后的有效重要性」排序：已被改写的旧版本会先被淘汰，
            // 不会因为原始重要性高就赖在库里占额度。
            const impA = effectiveImportance(a, 0.8);
            const impB = effectiveImportance(b, 0.8);
            // Protect milestone memories (>= 0.9) from eviction unless everything is a milestone
            const milestoneA = impA >= 0.9 ? 1 : 0;
            const milestoneB = impB >= 0.9 ? 1 : 0;
            if (milestoneA !== milestoneB) return milestoneA - milestoneB;
            return a.createdAt.localeCompare(b.createdAt);
        });
        const excess = evictionSorted.slice(0, evictableEntries.length - config.maxLongTermEntries);
        // 超限淘汰走「最近删除」而不是硬删：此前是 deleteMemoryEntries 直接 drop，
        // 一次总结就可能让一批老记忆彻底消失且无法找回。软删除后不再注入 Prompt，
        // 用户仍能在回收站里恢复，满 TRASH_RETENTION_DAYS 天才真正清理。
        // （回收站只认 user / character 两种操作者，系统动作归到 user 并在理由里写明）
        for (const entry of excess) {
            await trashMemoryEntry(entry, { by: "user", reason: "长期记忆数量超出上限，已自动移入最近删除" });
        }
    }

    await maybeRunCoreMemoryPipeline(characterId, characterName);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries across ${summarizedDayCount} day(s) into ${savedEntryCount} memory entries`);
    return { success: true };
}

/** 单次溯源重总结最多允许拆出的独立条数：防止模型把同一件事按句子切碎 */
const MAX_RESPLIT_BLOCKS = 4;

/**
 * 溯源重总结（拆分与因果纠偏）：
 * 针对某条把互不相关的事揉在一起、或强加了虚假因果的长期记忆，回溯它对应的原始对话/事件记录重新提炼：
 * 1. 【硬性铁律：无原文绝不总结】若无法追溯到任何原始事件记录（批次存档与本地原生历史均无对应原文），
 *    立即拒绝重总结，绝不对着可能已经写歪的记忆正文二次脑补！
 * 2. 若原文证明确实是两件或多件互不相关的独立事件/机制，拆成多条独立记忆入库；
 *    若原本就是一件事但旧总结强加了原文不存在的因果或写错了事实，按原文纠正为准确的 1 条；
 * 3. 新生成的条目当场补齐 Embedding 向量；原条目移入「最近删除」并记录 resplitInto，
 *    一旦用户在回收站恢复原条目，新生成的派生条目会自动一并撤回，绝不留双份重复垃圾。
 */
export async function resplitMergedMemory(
    characterId: string,
    characterName: string,
    entryId: string,
): Promise<{ success: boolean; error?: string; createdCount?: number; entryIds?: string[] }> {
    const apiConfig = resolveSummarizationApiConfig(characterId);
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    const allLongTerm = await loadMemoryEntriesByType(characterId, "long_term");
    const target = allLongTerm.find(e => e.id === entryId);
    if (!target) return { success: false, error: "找不到这条记忆，可能已被删除" };
    if (isEntryTrashed(target)) {
        return { success: false, error: "这条记忆已在「最近删除」里，请先恢复后再操作" };
    }
    if (isEntrySuperseded(target)) {
        return { success: false, error: "这条记忆已被更新版本接替，请直接处理最新的那条记忆" };
    }

    const body = (stripMemoryStructuredSections(target.content) || target.content).trim();
    if (!body) return { success: false, error: "这条记忆正文为空" };

    // 铁律：必须追溯到原始对话/事件记录才允许重总结；无原文一律中止，绝不凭旧总结二次臆测
    const provenance = resolveMemoryProvenance(characterId, target);
    if (!provenance || provenance.entries.length === 0) {
        return {
            success: false,
            error: "无法追溯到这条记忆对应的原始对话/事件记录，已中止重总结（防止无原文依据二次编造，如需调整请手动编辑）",
        };
    }

    const sourceText = provenance.entries
        .slice(-80)
        .map(item => `- [${item.sourceApp}] ${item.content}`)
        .join("\n");

    const charProfile = buildCharacterSummaryProfile(characterId, characterName);

    const prompt = [
        `你是一个严谨的记忆溯源纠偏与重总结助手。角色：${characterName || "角色"}。`,
        charProfile,
        "",
        "用户指出下方这条【待修正的旧记忆】存在总结偏差（例如：人称代词性别写错、把玩笑调侃写成了真实发生过的往事、把互不相干的两件事揉在了一起、或强加了虚假因果）。",
        "请你**严格且唯一依据下方【原始对话/事件记录】**，对这条旧记忆涉及的内容进行重新核对、拆分或修正重总结。",
        "",
        "【待修正的旧记忆（仅用于定位它原本想记哪几件事，其中违背原文的因果、错误代词或失真细节一律作废）】：",
        body,
        "",
        `【原始对话/事件记录（唯一事实依据，共 ${provenance.entries.length} 条）】：`,
        sourceText,
        "",
        "═══ 溯源重总结规则（最高优先级）═══",
        "1. **核对性别代词与玩笑语境**：严格使用正确的性别代词（男性角色必须用「他」，严禁写成「她」）；若原文只是调侃、开玩笑、假设或打比方，必须明确写出“调侃/打趣”，严禁写成真实发生过的往事！",
        "2. **只针对该旧记忆涉及的话题范围重总结**：原始记录中可能还包含当天其它已经单独建过记忆的无关话题，不要把其它无关话题重复总结进来，只核对并重写与这条旧记忆相关的内容。",
        "3. **拆开互不相干的事，剔除虚构因果**：",
        "   - 如果原始记录表明旧记忆把两件互不相关的事、两套独立机制或两个独立话题硬凑在了一起，必须用单独一行的 `---` 拆成多条独立记忆！",
        "   - 严禁补出原文没明确说过的「通过A就能达成B / 做A是为了B」等因果关联。",
        "4. **保留真正连贯的一件事**：如果原文确实是同一件事的起因、经过、回应与结果，不要按句子切碎；只需把旧记忆里错误的代词、编造的因果或失真表述按原文修正为准确的 1 条。",
        "5. **写作规范**：使用第三人称描述，每条正文控制在 40-120 字左右，正文中严禁写入任何日期或具体时间字样。",
        "",
        "═══ 输出格式（不要输出思考过程或解释）═══",
        "多条记忆之间用单独一行的 `---` 分隔；每条末尾必须各自单独输出两行：",
        "**重要性**：（1-10的整数）",
        "**检索关键词**：关键词1、关键词2、关键词3",
    ].join("\n");

    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.2, label: `溯源重总结·${characterName || characterId}` },
    );
    if (!result.content) {
        return { success: false, error: result.error || "重总结失败：模型没有返回内容" };
    }

    const blocks = splitMultiTopicSummaries(result.content);
    if (blocks.length > MAX_RESPLIT_BLOCKS) {
        return {
            success: false,
            error: `模型输出了 ${blocks.length} 段（超过 ${MAX_RESPLIT_BLOCKS} 段上限），疑似把单件事过度切碎，已取消覆盖并保持原样`,
        };
    }

    const dayKey = typeof target.metadata?.eventDate === "string" && target.metadata.eventDate.trim()
        ? target.metadata.eventDate.trim()
        : (provenance.dayKey || target.createdAt.slice(0, 10));

    const parsedItems: Array<{
        cleanBody: string;
        keywords: string[];
        importance: number;
        embeddingInput: string;
    }> = [];

    for (const block of blocks) {
        const { keywords, importance } = extractMemoryStructuredMeta(block);
        const cleanBody = stripMemoryStructuredSections(block) || stripInlineMemoryTimeMarkers(block);
        if (!cleanBody || cleanBody.length < 6) continue;
        const resolvedKeywords = keywords.length > 0
            ? keywords
            : (Array.isArray(target.metadata?.keywords) ? (target.metadata?.keywords as unknown[]).map(String).filter(Boolean) : []);
        const embeddingInput = resolvedKeywords.length > 0
            ? `关键词：${resolvedKeywords.join("、")}\n${cleanBody}`
            : cleanBody;
        parsedItems.push({
            cleanBody,
            keywords: resolvedKeywords,
            importance: importance ?? target.importance ?? 0.8,
            embeddingInput,
        });
    }

    if (parsedItems.length === 0) {
        return { success: false, error: "未能从模型返回内容中解析出有效记忆，已保持原样" };
    }

    // 若只生成了 1 条且正文与原记忆完全一致，无需产生垃圾历史
    if (parsedItems.length === 1 && parsedItems[0].cleanBody.trim() === body) {
        return { success: false, error: "核对原文后内容与当前记忆一致，无需重总结" };
    }

    // 为重总结产出的新条目当场计算 Embedding 向量，确保向量召回立刻有效
    const config = loadMemoryConfig();
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    const canEmbed = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig));
    let embeddings: Array<number[] | null> = [];
    if (canEmbed && embeddingApiConfig) {
        try {
            embeddings = await generateEmbeddingsBatch(
                parsedItems.map(item => item.embeddingInput),
                embeddingApiConfig,
            );
        } catch { /* ignore */ }
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const createdIds: string[] = [];

    for (let i = 0; i < parsedItems.length; i++) {
        const item = parsedItems[i];
        const emb = embeddings[i] ?? undefined;
        const newId = `mem_lt_resum_${nowMs}_${i}_${Math.random().toString(36).slice(2, 7)}`;
        const childMetadata: Record<string, unknown> = {
            ...(target.metadata ?? {}),
            eventDate: dayKey,
            keywords: item.keywords,
            resplitFrom: entryId,
            topicSplitV2: true,
            ...(emb ? { embeddingDim: emb.length } : {}),
        };
        delete childMetadata.resplitInto;
        delete childMetadata.resplitDetachedBy;
        delete childMetadata.mergeSuspect;
        delete childMetadata.mergeSuspectReasons;
        delete childMetadata.mergeSuspectVersion;

        const next: MemoryEntry = {
            id: newId,
            characterId,
            sourceApp: target.sourceApp,
            type: "long_term",
            content: item.cleanBody,
            embedding: emb,
            importance: item.importance,
            accessCount: i === 0 ? (target.accessCount ?? 0) : 0,
            createdAt: new Date(nowMs + i).toISOString(),
            updatedAt: new Date(nowMs + i).toISOString(),
            metadata: childMetadata,
        };
        await saveMemoryEntry(next);
        createdIds.push(newId);
    }

    // 原条目移入「最近删除」并记录 resplitInto：
    // 若用户对重总结结果不满意，在「最近删除」里点「恢复」时会自动删除 createdIds 回到原状。
    await trashMemoryEntry(
        {
            ...target,
            updatedAt: nowIso,
            metadata: {
                ...(target.metadata ?? {}),
                resplitInto: createdIds,
            },
        },
        {
            by: "user",
            reason: createdIds.length > 1
                ? `已溯源重总结并拆分为 ${createdIds.length} 条独立记忆`
                : "已根据原始记录重新总结修正",
        },
    );

    return { success: true, createdCount: createdIds.length, entryIds: createdIds };
}

/**
 * 识别此前旧版「批量拆分」遗留的碎片条目（mem_lt_resplit_ 前缀），供用户按需一键移入回收站清理。
 */
export function isLegacyResplitFragment(entry: MemoryEntry): boolean {
    return entry.id.startsWith("mem_lt_resplit_");
}

export async function trashAllLegacyResplitFragments(
    entries: MemoryEntry[],
): Promise<{ count: number; ids: string[] }> {
    const targets = entries.filter(entry => !isEntryTrashed(entry) && isLegacyResplitFragment(entry));
    for (const entry of targets) {
        await trashMemoryEntry(entry, { by: "user", reason: "清理旧版拆分遗留碎片" });
    }
    return { count: targets.length, ids: targets.map(entry => entry.id) };
}

/** 取一条记忆的事件日期（YYYY-MM-DD），缺失时退回 createdAt */
function entryEventDateOf(entry: MemoryEntry): string {
    const raw = typeof entry.metadata?.eventDate === "string" ? entry.metadata.eventDate.trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return (entry.createdAt || "").slice(0, 10);
}

/**
 * Find if a newly summarized topic is a near-duplicate of an existing long-term memory.
 *
 * 判定口径（逐条短路，宁可不合并，也不要把「同一话题的两次独立总结」错判成「同一事实的新版本」）：
 * 1. 方向门槛：晚于本次总结日的条目属于更新版本，不能反过来被更早的总结改写；
 * 2. 有向量时按余弦相似度，同日 REVISION_MATCH_THRESHOLD、跨日 REVISION_CROSS_DAY_THRESHOLD；
 * 3. 无向量时退化为集合重合（tokenJaccardRatio，分母取并集），达到
 *    REVISION_KEYWORD_FALLBACK_THRESHOLD 才认为同一件事，且只按「重复合并」处理、不产生划线；
 * 4. 同一次总结里刚创建的条目（sameRun）只参与「几乎一字不差」的合并，绝不被判成被改写。
 */
type NearDuplicateMatch = {
    entry: MemoryEntry;
    similarity: number;
    /** 命中口径：vector=向量余弦；keyword=关键词/正文集合重合兜底 */
    source: "vector" | "keyword";
    /** 是否是本轮总结刚创建/合并出来的条目 */
    sameRun: boolean;
};

function findNearDuplicateMemory(
    existingEntries: MemoryEntry[],
    dayKey: string,
    newBody: string,
    newKeywords: string[],
    newEmbedding?: number[],
    runCreatedIds?: Set<string>,
): NearDuplicateMatch | null {
    let best: NearDuplicateMatch | null = null;
    let bestRank = -1;
    const newKeywordsText = newKeywords.filter(Boolean).join(" ");
    for (const item of existingEntries) {
        const itemDate = entryEventDateOf(item);
        const sameDay = itemDate === dayKey;
        // 方向门槛：YYYY-MM-DD 可直接字符串比较
        if (!sameDay && itemDate && dayKey && itemDate > dayKey) continue;
        const sameRun = Boolean(runCreatedIds?.has(item.id));
        let similarity = 0;
        let source: NearDuplicateMatch["source"] = "vector";
        if (
            newEmbedding &&
            newEmbedding.length > 0 &&
            Array.isArray(item.embedding) &&
            item.embedding.length === newEmbedding.length
        ) {
            const threshold = sameDay ? REVISION_MATCH_THRESHOLD : REVISION_CROSS_DAY_THRESHOLD;
            const sim = cosineSimilarity(newEmbedding, item.embedding);
            if (sim >= threshold) similarity = sim;
        }
        if (similarity === 0) {
            // 兜底：检索关键词 + 正文的集合重合（Jaccard，分母取并集）。
            // 原先用的 keywordOverlapRatio 分母取 min，短的新总结几乎全能被长条目包含，重合率虚高，
            // 于是「同一话题」被错判成「同一件事」。
            const itemKeywords = Array.isArray(item.metadata?.keywords)
                ? (item.metadata.keywords as unknown[]).map(String).filter(Boolean)
                : [];
            const keywordScore = newKeywordsText && itemKeywords.length > 0
                ? tokenJaccardRatio(newKeywordsText, itemKeywords.join(" "))
                : 0;
            const bodyScore = tokenJaccardRatio(newBody, item.content);
            if (Math.max(keywordScore, bodyScore) >= REVISION_KEYWORD_FALLBACK_THRESHOLD) {
                // 映射到「几乎一字不差」区间：走重复合并，绝不据此算划线区间
                similarity = REVISION_EXACT_THRESHOLD;
                source = "keyword";
            }
        }
        if (similarity <= 0) continue;
        // 已经被修订过的旧版本再被改写时，优先挂在「最新那一版」上；
        // 否则划掉区间会一层层叠在最早的文本上，越叠越乱。
        const alreadySuperseded = typeof item.metadata?.[REVISION_META_KEYS.by] === "string";
        const rank = similarity - (alreadySuperseded ? 0.02 : 0) - (sameRun ? 0.01 : 0);
        if (rank > bestRank) {
            bestRank = rank;
            best = { entry: item, similarity, source, sameRun };
        }
    }
    return best;
}

export type CleanedManualMemoryDraft = {
    cleanBody: string;
    eventDate: string;
    importance: number; // 1-10 integer for UI display/editing
    keywords: string[];
};

/**
 * 判断一条已有长期记忆是否属于「修改前未清洗/未拆条的旧长文本记忆」：
 * 包含多段落、内嵌日期/旧标题、正文超过 145 字、或缺少检索关键词。
 */
export function isLegacyUnorganizedMemory(entry: MemoryEntry): boolean {
    if (entry.type !== "long_term") return false;
    if (entry.metadata?.resplitDone === true) return false;
    // 事件盒生成的总结条目不走旧记忆拆条清洗
    if (entry.metadata?.origin === "event_box_digest" || entry.metadata?.eventBoxDigestOf) return false;

    // 只整理「用户自己带进来的内容」和「没有总结管道痕迹的历史格式条目」。
    // 自动总结产出的条目本来就按当前格式生成，偶尔超字数或带换行并不代表它需要被清洗；
    // 之前这里不分来源，导致模型刚总结的记忆被算进「一键清洗旧记忆(N)」的计数里。
    // 来源/归档/删除状态的判定统一交给 memory-entry-state，这里只负责形态检查。
    const entryState = resolveMemoryEntryState(entry);
    if (!isEntryLegacyCleanupEligible(entryState)) return false;

    const cleanBody = stripMemoryStructuredSections(entry.content) || entry.content.trim();
    const kws = Array.isArray(entry.metadata?.keywords)
        ? (entry.metadata.keywords as unknown[]).filter(Boolean)
        : extractMemoryStructuredMeta(entry.content).keywords;

    const hasMultipleParagraphs = cleanBody.split(/\n+/).filter(line => line.trim().length > 8).length >= 2;
    const hasInlineDateMarkers = /(?:\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}日|###\s*未解决问题|###\s*事件总结)/.test(entry.content);
    const isTooLong = cleanBody.length > 145;
    const missingKeywords = kws.length === 0;

    if (entry.metadata?.topicSplitV2 === true && !isTooLong && !hasMultipleParagraphs && !missingKeywords) {
        return false;
    }

    return isTooLong || hasMultipleParagraphs || hasInlineDateMarkers || missingKeywords;
}

/**
 * 将单条旧版长文本/混杂长期记忆通过 LLM 清洗并拆分为 1~N 条规范记忆，自动提取日期、重要性与关键词并生成向量。
 */
export async function cleanLegacyMemoryEntry(
    entry: MemoryEntry,
    characterName: string
): Promise<{ success: boolean; newEntries?: MemoryEntry[]; error?: string }> {
    const config = loadMemoryConfig();
    const fallbackDate = typeof entry.metadata?.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.metadata.eventDate.trim())
        ? entry.metadata.eventDate.trim()
        : toLocalDayKey(entry.createdAt);

    const res = await cleanAndSplitManualMemoryText(
        entry.characterId,
        characterName,
        entry.content,
        fallbackDate,
    );
    if (!res.success || !res.drafts || res.drafts.length === 0) {
        return { success: false, error: res.error || "旧记忆清洗失败" };
    }

    const drafts = res.drafts;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    const canEmbed = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig));
    let embeddings: Array<number[] | null> = [];
    if (canEmbed && embeddingApiConfig) {
        try {
            embeddings = await generateEmbeddingsBatch(
                drafts.map(d => d.keywords.length > 0 ? `关键词：${d.keywords.join("、")}\n${d.cleanBody}` : d.cleanBody),
                embeddingApiConfig,
            );
        } catch { /* ignore */ }
    }

    const nowMs = Date.now();
    const baseAccessCount = typeof entry.accessCount === "number"
        ? entry.accessCount
        : (typeof entry.metadata?.accessCount === "number" ? Number(entry.metadata.accessCount) : 0);
    const baseCreatedTime = new Date(entry.createdAt).getTime();

    const createdEntries: MemoryEntry[] = [];
    for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        const emb = embeddings[i] ?? undefined;
        const entryCreatedIso = !isNaN(baseCreatedTime)
            ? new Date(baseCreatedTime + i * 10).toISOString()
            : new Date(nowMs + i * 10).toISOString();
        const normalizedImportance = Math.max(0.1, Math.min(1, Number((d.importance / 10).toFixed(2))));

        const newEntry: MemoryEntry = {
            id: drafts.length === 1
                ? entry.id
                : `mem_lt_${nowMs}_cl_${i}_${Math.random().toString(36).slice(2, 7)}`,
            characterId: entry.characterId,
            sourceApp: entry.sourceApp || "chat",
            type: "long_term",
            content: d.cleanBody,
            embedding: emb,
            importance: normalizedImportance,
            accessCount: i === 0 ? baseAccessCount : 0,
            createdAt: entryCreatedIso,
            updatedAt: new Date(nowMs + i * 10).toISOString(),
            metadata: {
                ...(entry.metadata ?? {}),
                eventDate: d.eventDate || fallbackDate,
                keywords: d.keywords,
                accessCount: i === 0 ? baseAccessCount : 0,
                resplitDone: true,
                topicSplitV2: true,
                ...(emb ? { embeddingDim: emb.length } : {}),
            },
        };
        await saveMemoryEntry(newEntry);
        createdEntries.push(newEntry);
    }

    if (drafts.length > 1) {
        await trashMemoryEntry(
            {
                ...entry,
                metadata: {
                    ...(entry.metadata ?? {}),
                    resplitInto: createdEntries.map(e => e.id),
                },
            },
            { by: "user", reason: `旧长文本记忆已清洗拆分为 ${createdEntries.length} 条独立记忆` },
        );
    }

    return { success: true, newEntries: createdEntries };
}

/**
 * 一键批量清洗某个角色下所有混杂/长文本旧记忆。
 */
export async function runBatchCleanLegacyMemories(
    characterId: string,
    characterName: string,
    options?: {
        targetEntries?: MemoryEntry[];
        onProgress?: (done: number, total: number, newCount: number) => void;
    }
): Promise<{ success: boolean; processedCount: number; newTotalCount: number; error?: string }> {
    const targets = options?.targetEntries
        ?? (await loadMemoryEntriesByType(characterId, "long_term")).filter(e => !isEntryTrashed(e) && isLegacyUnorganizedMemory(e));

    if (targets.length === 0) {
        return { success: true, processedCount: 0, newTotalCount: 0 };
    }

    let processedCount = 0;
    let newTotalCount = 0;
    let lastError = "";

    for (let i = 0; i < targets.length; i++) {
        const res = await cleanLegacyMemoryEntry(targets[i], characterName);
        if (res.success && res.newEntries) {
            processedCount += 1;
            newTotalCount += res.newEntries.length;
        } else if (res.error) {
            lastError = res.error;
        }
        options?.onProgress?.(i + 1, targets.length, newTotalCount);
    }

    if (processedCount === 0) {
        return { success: false, processedCount: 0, newTotalCount: 0, error: lastError || "一键清洗旧记忆失败" };
    }

    return { success: true, processedCount, newTotalCount };
}

/**
 * 调用 LLM 对用户手动录入的长文本进行清洗、按独立话题拆分、自动提取事件日期、重要性和检索关键词。
 */
export async function cleanAndSplitManualMemoryText(
    characterId: string,
    characterName: string,
    rawText: string,
    defaultEventDate: string
): Promise<{ success: boolean; drafts?: CleanedManualMemoryDraft[]; error?: string }> {
    const apiConfig = resolveSummarizationApiConfig(characterId);
    if (!apiConfig) {
        return { success: false, error: "未配置可用 API（请在设置 → API 设置或辅助API绑定中配置）" };
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
        return { success: false, error: "请先输入需要清洗的记忆文本" };
    }

    const fallbackDate = /^\d{4}-\d{2}-\d{2}$/.test(defaultEventDate.trim())
        ? defaultEventDate.trim()
        : toLocalDayKey(new Date().toISOString());
    const fallbackYear = Number(fallbackDate.slice(0, 4)) || new Date().getFullYear();

    const charProfile = buildCharacterSummaryProfile(characterId, characterName);
    const prompt = injectCharacterProfileIntoPrompt(
        DEFAULT_MANUAL_TEXT_CLEAN_PROMPT
            .replace(/\{\{char\}\}/gi, characterName || "角色")
            .replace(/\{\{eventDate\}\}/gi, fallbackDate)
            .replace(/\{\{content\}\}/gi, trimmed),
        charProfile,
    );

    let result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.25, label: `手动记忆清洗拆分·${characterName}` },
    );
    if (!result.content && !result.wasTruncated) {
        await new Promise(r => setTimeout(r, 1000));
        result = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: prompt }],
            { temperature: 0.25, label: `手动记忆清洗重试·${characterName}` },
        );
    }

    if (!result.content) {
        return { success: false, error: result.error || "模型未返回有效清洗结果" };
    }

    const blocks = splitMultiTopicSummaries(result.content.trim());
    const drafts: CleanedManualMemoryDraft[] = [];

    for (const block of blocks) {
        const meta = extractMemoryStructuredMeta(block);
        const cleanBody = stripMemoryStructuredSections(block) || stripInlineMemoryTimeMarkers(block);
        if (!cleanBody || cleanBody.length < 2) continue;
        const resolvedDate = meta.eventDate
            || extractDateFromRawText(block, fallbackYear)
            || extractDateFromRawText(trimmed, fallbackYear)
            || fallbackDate;
        const impScore = meta.importance !== undefined
            ? Math.max(1, Math.min(10, Math.round(meta.importance * 10)))
            : 8;
        drafts.push({
            cleanBody,
            eventDate: resolvedDate,
            importance: impScore,
            keywords: meta.keywords,
        });
    }

    if (drafts.length === 0) {
        return { success: false, error: "未能从模型返回内容中解析出有效记忆条目" };
    }

    return { success: true, drafts };
}
