// lib/core-memory-reflection.ts
// 角色视角的核心记忆反思（character reflection）
//
// 用「反思」而不是「反刍」：心理学里的反刍（rumination）指围绕威胁反复绕圈、越想越窄的
// 适应不良加工；这里是 adaptive reflection——会推进理解、会落到下一步行动的那种。
//
// 与自动/手动的「核心记忆总结」刻意区分开：
// - API：走角色自己在「绑定配置 → 聊天」里绑定的 API；没有才回退到记忆总结辅助 API / 全局默认；
// - 素材：完整读取角色设定（人设、性格、标签，不做任何截断）与用户身份，让模型以角色本人的第一人称说话；
// - 框架：叙事身份理论（Narrative Identity）+ 反思性加工（reflective processing），
//   另外用蔡格尼克效应（未闭合的事最占心思）、归因方式、内部工作模型更新来锚定维度；
// - 隔离：一次只处理一个 characterId，只读该角色的记忆、只写该角色的库，
//   绝不在同一次调用里混合多个角色的素材。

import type { MemoryEntry } from "./memory-types";
import { loadMemoryConfig, loadMemoryEntriesByType, saveMemoryEntry } from "./memory-storage";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import {
    loadBindingConfig,
    loadApiConfigs,
    resolveBinding,
    resolveUserIdentity,
} from "./settings-storage";
import {
    loadNativeTimeline,
    formatTimelineForSummarization,
    filterTimelineByAllowedSources,
} from "./short-term-assembler";
import { simpleLLMCall } from "./api-helpers";

export type ReflectionScope = "recent7" | "recent30" | "all";

export const REFLECTION_SCOPE_DAYS: Record<Exclude<ReflectionScope, "all">, number> = {
    recent7: 7,
    recent30: 30,
};

/** 单次反思最多参考的长期记忆条数（超出时保留最近的）。 */
const MAX_EVENT_ENTRIES = 120;
/** 事件素材的总字数护栏，防止把上下文塞爆。角色设定不在此列——设定始终完整发送。 */
const MAX_EVENT_CHARS = 12000;
/** 额外参考的「还没整理进记忆」的即时事件条数。 */
const MAX_TRANSIENT_EVENTS = 40;
/** 即时事件的回看上限（scope=all 时也只回看一年）。 */
const ALL_SCOPE_TRANSIENT_DAYS = 365;

export type CoreReflectionApiSource = "character" | "auxiliary" | "global";

export type CoreReflectionResult = {
    success: boolean;
    error?: string;
    content?: string;
    round?: number;
    entryId?: string;
    apiSource?: CoreReflectionApiSource;
    model?: string;
};

export const DEFAULT_REFLECTION_PROMPT = `你此刻不再是助手，而是「{{char}}」本人。请完全以{{char}}的第一人称，私下回看这段时间你和「{{user}}」之间发生过的事，做一次真实的自我反思——不是写总结报告，也不是给别人看的交代。

【你是谁】
{{persona}}

【时间跨度】
{{earliest}} 至 {{latest}}

【这段时间发生过的事（按时间顺序）】
{{events}}

【最近还没整理成记忆的片段（可能和上面重复，只是刚刚发生的事）】
{{transient}}

【你上一次反思时留下的想法（如果是第一次反思则为空）】
{{previous}}

【在心里先过这几问，不要写出来，也不要照着顺序答题】
1. 这事碰到我哪根弦：我在乎的是什么？它被满足了，还是被挡住了？
2. 谁的缘故：是谁造成的、是有意还是无意？我有没有办法应对——哪些我能做，哪些我根本左右不了？
3. 我真实的那口气：我心里实际是什么情绪，有多重？我嘴上表现出来的和心里一样吗？不一样的话，我按下去的是什么？
4. 我怎么看{{user}}了：原先我默认{{user}}会____，现在我觉得{{user}}可能____。我有多确定——是真知道，还是只是猜？还有没有别的解释说得通？
5. 这段关系在我脑子里成了什么故事：是正在往好的方向走（哪怕过程难受），还是在一路变坏？我心里这个调子，会不会影响我下一次的反应？
6. 下次怎么办：{{user}}做____的时候，我就____。（要具体到能照做，别停在「我要更坦诚」这种话上。）

【写作要求】
- 全程第一人称，用我自己的语气、称呼习惯和说话方式（严格贴着上面的角色设定来，不要演成通用助手口吻）；不要用第三人称，不要写「{{char}}认为」「角色觉得」这类旁白。
- 250-400 字，分成 2 至 4 个自然段，段落之间空一行。
- 纯叙述，不要标题、编号、列表、Markdown 符号、括号注释，也不要任何开场白（比如「好的」「以下是」）。
- 上面那几问是我在心里想的，不是要交的作业：让答案渗进叙述里，别一条条照着答，更不要出现「初评」「归因」「情绪强度」这类字眼。
- 情绪别写成标签（比如「我有点难过」），落到当时具体的身体感觉、动作，或者突然冒出来的那个念头上。
- 只基于上面给出的素材，不要编造没有发生过的事；不确定的地方就照实写出我的不确定——「我说不准」也是一种真实的回答。
- 结尾落在一件具体的事上：下次碰到什么情况，我打算怎么应对。

直接开始写：`;

function toLocalDayKey(isoStr: string): string {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.slice(0, 10) || "";
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 记忆的事件日期：优先 metadata.eventDate，回退到 createdAt。 */
function resolveEventDay(entry: MemoryEntry): string {
    const raw = typeof entry.metadata?.eventDate === "string" ? entry.metadata.eventDate.trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return toLocalDayKey(entry.createdAt);
}

/** 去掉记忆正文里的结构化尾巴，避免把「重要性/检索关键词」喂给模型。 */
function cleanMemoryBody(content: string): string {
    return String(content || "")
        .replace(/^###\s*事件总结\s*\n+/i, "")
        .replace(/^###\s*未解决问题[\s\S]*?(?=\n###|$)/gim, "")
        .replace(/\*\*事件日期\*\*[：:][^\n]*/g, "")
        .replace(/\*\*重要性\*\*[：:][^\n]*/g, "")
        .replace(/\*\*检索关键词\*\*[：:][^\n]*/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function isReflectionMemoryEntry(entry: MemoryEntry): boolean {
    return entry.metadata?.origin === "character_reflection";
}

/**
 * 解析反思用的 API：角色聊天槽位优先，其次记忆总结辅助 API，最后全局默认。
 * 这与 resolveSummarizationApiConfig 的顺序相反——反思要的是「这个角色自己的脑子」。
 */
function resolveReflectionApiConfig(characterId: string): {
    apiConfig: ReturnType<typeof loadApiConfigs>[number];
    source: CoreReflectionApiSource;
} | null {
    const bindingCfg = loadBindingConfig();
    const apiConfigs = loadApiConfigs();

    const charSlot = resolveBinding(bindingCfg, characterId, "chat");
    const charApi = charSlot?.apiConfigId
        ? apiConfigs.find(c => c.id === charSlot.apiConfigId && Boolean(c.apiKey))
        : undefined;
    if (charApi) return { apiConfig: charApi, source: "character" };

    const auxId = bindingCfg?.memorySummaryApiConfigId;
    const auxApi = auxId
        ? apiConfigs.find(c => c.id === auxId && Boolean(c.apiKey))
        : undefined;
    if (auxApi) return { apiConfig: auxApi, source: "auxiliary" };

    const globalId = bindingCfg?.globalDefaults?.apiConfigId;
    const globalApi = globalId
        ? apiConfigs.find(c => c.id === globalId && Boolean(c.apiKey))
        : undefined;
    if (globalApi) return { apiConfig: globalApi, source: "global" };

    const anyApi = apiConfigs.find(c => Boolean(c.apiKey));
    return anyApi ? { apiConfig: anyApi, source: "global" } : null;
}

/**
 * 角色设定的完整文本：人设、性格、标签原样拼进去，**不做任何长度截断**。
 * 不读世界书——世界书是按关键词动态注入的，反刍只认角色卡本体的设定。
 */
function buildPersonaText(character: Character, userName: string): string {
    const chunks: string[] = [];
    const persona = character.persona?.trim();
    const personality = character.personality?.trim();
    const tags = Array.isArray(character.tags) ? character.tags.map(t => String(t).trim()).filter(Boolean) : [];

    if (persona) chunks.push(persona);
    if (personality) chunks.push(`性格：${personality}`);
    if (tags.length > 0) chunks.push(`标签：${tags.join("、")}`);
    chunks.push(`你的名字是「${character.name?.trim() || "这个角色"}」，你在和「${userName}」相处。`);
    return chunks.join("\n\n");
}

/** 事件太多时从最早的开始丢，保留最近的。 */
function trimEventLines(lines: string[], maxChars: number): { lines: string[]; truncated: boolean } {
    let total = 0;
    const kept: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        total += lines[i].length + 1;
        if (total > maxChars && kept.length > 0) {
            return { lines: kept, truncated: true };
        }
        kept.unshift(lines[i]);
    }
    return { lines: kept, truncated: false };
}

/** 模型偶尔还是会带标题或开场白，做一次轻清洗，保留段落结构。 */
function cleanReflectionOutput(raw: string): string {
    let text = raw.trim();
    text = text.replace(/^```[a-zA-Z]*\s*\n/, "").replace(/\n```$/, "").trim();
    text = text.replace(/^(?:好的|好[，,]?|以下是|下面是|我来)[^\n]{0,40}\n+/i, "");
    text = text.replace(/^#{1,6}\s+[^\n]*\n+/gm, "");
    text = text.replace(/^\s*(?:[-*•]|\d+[.、])\s+/gm, "");
    return text.trim();
}

/**
 * 以角色视角反思近期事件，生成一条仅属于该角色的核心记忆。
 * 严格单角色：素材读取与记忆写入都只针对 characterId。
 */
export async function runCoreMemoryReflection(
    characterId: string,
    scope: ReflectionScope = "recent30",
    characterName?: string,
): Promise<CoreReflectionResult> {
    const character = loadCharacters().find(c => c.id === characterId);
    const resolvedName = character?.name?.trim() || characterName?.trim() || "";

    const api = resolveReflectionApiConfig(characterId);
    if (!api) {
        return { success: false, error: "未找到可用的 API：请先在「绑定配置」里给这个角色绑定 API，或到「设置 → API 设置」添加一个" };
    }

    // ── 素材 1：该角色的长期记忆（按范围过滤，按事件日期升序）──
    const allLongTerm = await loadMemoryEntriesByType(characterId, "long_term");
    const startDayKey = scope === "all"
        ? undefined
        : toLocalDayKey(new Date(Date.now() - REFLECTION_SCOPE_DAYS[scope] * 86400000).toISOString());

    const collectScoped = (from?: string) => allLongTerm
        .filter(entry => !from || resolveEventDay(entry) >= from)
        .map(entry => ({
            entry,
            day: resolveEventDay(entry),
            body: cleanMemoryBody(entry.content),
        }))
        .filter(item => Boolean(item.body))
        .sort((a, b) => a.day.localeCompare(b.day) || a.entry.createdAt.localeCompare(b.entry.createdAt));

    let scoped = collectScoped(startDayKey);
    if (scoped.length === 0 && scope !== "all") {
        // 窗口里没素材时退回全部长期记忆，避免新角色第一次点反刍就空转
        scoped = collectScoped(undefined);
    }

    const selected = scoped.length > MAX_EVENT_ENTRIES ? scoped.slice(-MAX_EVENT_ENTRIES) : scoped;

    // ── 素材 2：上一次反思留下的想法（只取同角色最近一条）──
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    const previousReflection = coreEntries
        .filter(isReflectionMemoryEntry)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const previousText = previousReflection
        ? cleanMemoryBody(previousReflection.content)
        : "";
    const round = previousReflection
        ? Math.max(1, Number(previousReflection.metadata?.reflectionRound ?? 1)) + 1
        : 1;

    // ── 素材 3：还没整理成记忆的即时片段 ──
    let transientText = "";
    try {
        const config = loadMemoryConfig();
        const afterIso = startDayKey
            ? new Date(`${startDayKey}T00:00:00`).toISOString()
            : new Date(Date.now() - ALL_SCOPE_TRANSIENT_DAYS * 86400000).toISOString();
        const timeline = filterTimelineByAllowedSources(
            loadNativeTimeline(characterId, { afterTimestamp: afterIso }),
            config.shortTermAllowedSources,
        );
        const formatted = formatTimelineForSummarization(timeline.slice(-MAX_TRANSIENT_EVENTS), { timeAware: false });
        if (formatted?.eventsText) transientText = formatted.eventsText.trim();
    } catch {
        // 即时片段只是加分项，读不到就跳过
    }

    if (selected.length === 0 && !transientText) {
        return { success: false, error: "没有可用于反思的素材：这个角色还没有长期记忆或近期事件" };
    }

    const eventLines = selected.map(item => `- ${item.day}｜${item.body.replace(/\s+/g, " ")}`);
    const trimmed = trimEventLines(eventLines, MAX_EVENT_CHARS);
    const eventsText = trimmed.lines.length > 0
        ? `${trimmed.lines.join("\n")}${trimmed.truncated ? "\n（更早的记忆已省略）" : ""}`
        : "（暂无长期记忆）";

    const earliest = selected[0]?.day ?? startDayKey ?? "";
    const latest = selected[selected.length - 1]?.day
        ?? (transientText ? toLocalDayKey(new Date().toISOString()) : "");

    const userName = resolveUserIdentity(characterId)?.name?.trim() || "用户";
    const personaText = character
        ? buildPersonaText(character, userName)
        : `你的名字是「${resolvedName || "这个角色"}」，你在和「${userName}」相处。`;

    const prompt = DEFAULT_REFLECTION_PROMPT
        .replace(/\{\{char\}\}/gi, resolvedName || "这个角色")
        .replace(/\{\{user\}\}/gi, userName)
        .replace(/\{\{persona\}\}/gi, personaText)
        .replace(/\{\{earliest\}\}/gi, earliest || "未知")
        .replace(/\{\{latest\}\}/gi, latest || "未知")
        .replace(/\{\{events\}\}/gi, eventsText)
        .replace(/\{\{transient\}\}/gi, transientText || "（无）")
        .replace(/\{\{previous\}\}/gi, previousText || "（这是第一次反刍，没有留下过想法）");

    let result = await simpleLLMCall(
        api.apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.75, label: `核心记忆反思·${resolvedName || characterId}` },
    );
    if (!result.content && !result.wasTruncated) {
        await new Promise(r => setTimeout(r, 1000));
        result = await simpleLLMCall(
            api.apiConfig,
            [{ role: "user", content: prompt }],
            { temperature: 0.75, label: `核心记忆反思重试·${resolvedName || characterId}` },
        );
    }

    if (!result.content) {
        return { success: false, error: result.error || "角色反思失败：模型没有返回内容", apiSource: api.source };
    }
    if (result.wasTruncated) {
        return { success: false, error: "反思结果疑似被截断，已取消入库，请稍后重试", apiSource: api.source };
    }

    const reflection = cleanReflectionOutput(result.content);
    if (reflection.length < 20) {
        return { success: false, error: "反思结果过短，已取消入库", apiSource: api.source };
    }

    // 主导来源：与核心记忆保持一致，便于检索统计
    const sourceCounts = new Map<string, number>();
    for (const item of selected) {
        const src = item.entry.sourceApp;
        sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
    }
    let dominantSource: MemoryEntry["sourceApp"] = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) {
            dominantSource = src as MemoryEntry["sourceApp"];
            maxCount = count;
        }
    }

    const now = new Date().toISOString();
    const entryId = `mem_core_refl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const coreEntry: MemoryEntry = {
        id: entryId,
        // 严格绑定角色：写进当前角色的记忆库，不会串到别的角色
        characterId,
        sourceApp: dominantSource,
        type: "core",
        content: reflection,
        importance: 0.94,
        createdAt: now,
        updatedAt: now,
        metadata: {
            origin: "character_reflection",
            reflectionFramework: "认知评价（初评/次评）+ 内部工作模型 + 心智化梯度 + 叙事序列 + 实施意图 if-then",
            reflectionScope: scope,
            reflectionRound: round,
            timeSpan: `${earliest} ~ ${latest}`,
            summarizedLongTermEntries: selected.length,
            hasTransientEvents: Boolean(transientText),
            previousReflectionId: previousReflection?.id ?? null,
            apiSource: api.source,
            model: api.apiConfig.defaultModel,
        },
    };
    await saveMemoryEntry(coreEntry);

    return {
        success: true,
        content: reflection,
        round,
        entryId,
        apiSource: api.source,
        model: api.apiConfig.defaultModel,
    };
}
