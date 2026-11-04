// lib/memory-cognition.ts
// 角色「思考倾向」的存储、构建与注入。
//
// 设计取舍：
// - 不用人格分型（荣格八维 / MBTI）当骨架：分型只给标签，模型拿到标签只会演刻板印象；
// - 用「反刍倾向」这类可评估的维度 + 一段行为规则：分数管强度，规则管形状，两者缺一不可；
// - 只服务反思链路，不外溢到聊天人设——反思是内向独白，把它塞进日常对话会让角色整体变闷；
// - 与事件盒、反思提示词一样，只按 characterId 读写，绝不跨角色混合。

import type { Character } from "./character-types";
import { loadCharacters } from "./character-storage";
import { kvGet, kvSet, registerDynamicPrefix } from "./kv-db";
import { simpleLLMCall } from "./api-helpers";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";

export const COGNITION_KV_PREFIX = "ai_phone_memory_cognition_";
registerDynamicPrefix(COGNITION_KV_PREFIX);

/** 思考倾向构建用的 API 来源，顺序与角色反思一致：角色自己的脑子优先。 */
export type CognitionApiSource = "character" | "auxiliary" | "global";

export type ThinkingTendency = {
    characterId: string;
    /** 沉思倾向 1-10：被触到情绪后越想越窄的程度 */
    brooding: number;
    /** 反思倾向 1-10：能不能把纠结转成理解 */
    reflection: number;
    /** 情绪锐度 1-10：情绪是直给放大，还是压下去变钝 */
    acuity: number;
    /**
     * 旧版字段（已废弃，不参与注入也不再生成）：
     * 任何文字描述都会被模型当成素材搬进反思正文，所以现在只保留三个分数。
     * 留着这两个可选字段只是为了让早期构建过的数据还能正常读出来。
     */
    summary?: string;
    expression?: string;
    createdAt: string;
    updatedAt: string;
    /** ai=构建产生；user=用户手改过 */
    source: "ai" | "user";
    model?: string;
    /** 生成时角色设定的快照，人设改过就提示可重建 */
    personaSnapshot?: string;
};

export type ThinkingTendencyResult = {
    success: boolean;
    error?: string;
    tendency?: ThinkingTendency;
    apiSource?: CognitionApiSource;
    model?: string;
};

function cognitionKey(characterId: string): string {
    return `${COGNITION_KV_PREFIX}${characterId}`;
}

function clampScore(raw: unknown): number {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return 5;
    return Math.max(1, Math.min(10, Math.round(n)));
}

function normalizeTendency(raw: unknown, characterId: string): ThinkingTendency | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Partial<ThinkingTendency>;
    // 只认分数：旧数据里可能带 summary/expression，读出来也直接丢掉
    const hasScores = typeof item.brooding === "number" || typeof item.reflection === "number";
    if (!hasScores) return null;
    const now = new Date().toISOString();
    return {
        characterId,
        brooding: clampScore(item.brooding),
        reflection: clampScore(item.reflection),
        acuity: clampScore(item.acuity),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
        source: item.source === "user" ? "user" : "ai",
        model: typeof item.model === "string" ? item.model : undefined,
        personaSnapshot: typeof item.personaSnapshot === "string" ? item.personaSnapshot : undefined,
    };
}

export function loadThinkingTendency(characterId: string): ThinkingTendency | null {
    if (!characterId) return null;
    try {
        const raw = kvGet(cognitionKey(characterId));
        if (!raw) return null;
        return normalizeTendency(JSON.parse(raw), characterId);
    } catch {
        return null;
    }
}

export function saveThinkingTendency(tendency: ThinkingTendency): ThinkingTendency {
    const next = { ...tendency, updatedAt: new Date().toISOString() };
    try {
        kvSet(cognitionKey(tendency.characterId), JSON.stringify(next));
    } catch {
        // 存储写失败时保持内存态可用，不阻断流程
    }
    return next;
}

export function clearThinkingTendency(characterId: string): void {
    try {
        kvSet(cognitionKey(characterId), "");
    } catch {
        // ignore
    }
}

/**
 * 解析构建用的 API：角色聊天槽位优先，其次记忆总结辅助 API，最后全局默认。
 * 与角色反思共用同一顺序——思考倾向要的是「这个角色自己的脑子」。
 */
export function resolveCharacterApiConfig(characterId: string): {
    apiConfig: ReturnType<typeof loadApiConfigs>[number];
    source: CognitionApiSource;
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

/** 角色设定快照：人设、性格、标签原文，用来判断构建结果是否已过期。 */
export function buildPersonaSnapshot(character: Character | undefined | null): string {
    if (!character) return "";
    const chunks: string[] = [];
    const persona = character.persona?.trim();
    const personality = character.personality?.trim();
    const tags = Array.isArray(character.tags) ? character.tags.map(t => String(t).trim()).filter(Boolean) : [];
    if (persona) chunks.push(persona);
    if (personality) chunks.push(`性格：${personality}`);
    if (tags.length > 0) chunks.push(`标签：${tags.join("、")}`);
    return chunks.join("\n");
}

export function isTendencyStale(tendency: ThinkingTendency | null, character: Character | undefined | null): boolean {
    if (!tendency) return false;
    const now = buildPersonaSnapshot(character);
    if (!tendency.personaSnapshot || !now) return false;
    return tendency.personaSnapshot !== now;
}

/**
 * 构建用的内置提示词：只读，不开放编辑（思考倾向是内部推导产物，不是创作素材）。
 * 要求模型输出严格 JSON，分数与行为规则一次产出。
 */
export const DEFAULT_THINKING_TENDENCY_PROMPT = `你是一位擅长把人物性格转译成"思考习惯"的角色分析助手。请只根据下面的角色设定，推断「{{char}}」在私下独自回想事情时，会表现出怎样的思考倾向。

【角色设定】
{{persona}}

【评估三个维度，各给 1-10 的整数分】
1. 沉思倾向（brooding）：被某件事碰到情绪之后，是否容易反复回到同一个画面、越想越窄、越回想越确信自己的猜测。
   1 = 情绪过去就翻篇，很少回头想；10 = 一件事能反复咀嚼很久，越想越难受也停不下来。
2. 反思倾向（reflection）：能不能把纠结转成理解——重新解释对方动机、修正自己的判断、得出下次怎么办。
   1 = 只在原地打转，从不改变看法；10 = 总能从纠结里提炼出新的理解与具体做法。
3. 情绪锐度（acuity）：情绪体验的强烈度与直接程度，以及是否愿意在内心承认它。
   1 = 情绪很淡、钝化、或者长期压着不面对；10 = 情绪一来就很重很直接，心里一清二楚。

【三个维度的分数要互相独立】
不要因为沉思高就顺手把反思写低，两者可以同时高（想得多且想得通）、同时低（懒得想）、一高一低。

【只打分，不要写任何解释】
不要写形容词、例句、行为描述或总结句。这些文字之后会被塞进反思提示词，
模型会把它当成素材照抄进反思正文，反而干扰它自己写。这里只要三个数字。

【输出格式】
只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块围栏：
{"brooding":7,"reflection":4,"acuity":8}`;

function parseTendencyJson(raw: string): {
    brooding: number;
    reflection: number;
    acuity: number;
} | null {
    let text = raw.trim();
    text = text.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.brooding === undefined && obj.reflection === undefined) return null;
    // 模型偶尔还是会多给 summary/expression，一律丢弃：那层文字不要了
    return {
        brooding: clampScore(obj.brooding),
        reflection: clampScore(obj.reflection),
        acuity: clampScore(obj.acuity),
    };
}

/**
 * 构建（或重建）角色思考倾向：读角色设定 → 调角色自己的 API → 解析 JSON → 落盘。
 * 解析失败直接返回失败并保留旧数据，不在半成品上覆盖。
 */
export async function buildThinkingTendency(
    characterId: string,
    characterName?: string,
): Promise<ThinkingTendencyResult> {
    const character = loadCharacters().find(c => c.id === characterId);
    const resolvedName = character?.name?.trim() || characterName?.trim() || "";
    if (!character) {
        return { success: false, error: "未找到该角色" };
    }

    const api = resolveCharacterApiConfig(characterId);
    if (!api) {
        return { success: false, error: "未找到可用的 API：请先在「绑定配置」里给这个角色绑定 API，或到「设置 → API 设置」添加一个" };
    }

    const userName = resolveUserIdentity(characterId)?.name?.trim() || "用户";
    const personaSnapshot = buildPersonaSnapshot(character);
    const personaText = `${personaSnapshot}\n\n你的名字是「${resolvedName || "这个角色"}」，你在和「${userName}」相处。`;

    const prompt = DEFAULT_THINKING_TENDENCY_PROMPT
        .replace(/\{\{char\}\}/gi, resolvedName || "这个角色")
        .replace(/\{\{persona\}\}/gi, personaText);

    const result = await simpleLLMCall(
        api.apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.4, label: `思考倾向构建·${resolvedName || characterId}` },
    );

    if (!result.content) {
        return { success: false, error: result.error || "构建失败：模型没有返回内容", apiSource: api.source };
    }

    const parsed = parseTendencyJson(result.content);
    if (!parsed) {
        return { success: false, error: "构建结果格式无法解析，已保留原有数据，请重试一次", apiSource: api.source };
    }

    const now = new Date().toISOString();
    const tendency: ThinkingTendency = {
        characterId,
        brooding: parsed.brooding,
        reflection: parsed.reflection,
        acuity: parsed.acuity,
        createdAt: now,
        updatedAt: now,
        source: "ai",
        model: api.apiConfig.defaultModel,
        personaSnapshot,
    };
    saveThinkingTendency(tendency);

    return { success: true, tendency, apiSource: api.source, model: api.apiConfig.defaultModel };
}

/**
 * 三个刻度的定义：只解释「这个数字在量什么」，不含任何角色专属的描写。
 * 通用刻度可以给，角色专属的范例不能给——后者才会被模型照抄进反思正文。
 */
export const TENDENCY_SCALE_LEGEND = `沉思：被情绪触动后反复回到同一处、越想越窄的程度（越高越容易原地打转）
反思：把纠结转成理解的程度（越高越能重新解释对方、修正自己的判断）
情绪：情绪体验的强度与直接程度（越高情绪越重、越直给）`;

/**
 * 根据三个维度的分值区间，生成确定性的「思考结构与收尾方式」约束指令。
 * 只约束独白的结构、节奏与结尾落点，绝不提供任何形容词或例句，防止模型照抄词句，
 * 同时解决纯数字刻度容易被正向反思问题拉平、导致高沉思/低反思角色也写得过度通达的问题。
 */
export function deriveTendencyStructuralDirectives(tendency: ThinkingTendency): string {
    const { brooding, reflection, acuity } = tendency;
    const rules: string[] = [];

    // 1. 沉思 vs 反思的组合决定「往深处钻牛角尖」还是「想通翻篇」
    if (brooding >= 7 && reflection <= 4) {
        rules.push("- 你目前很难真正想通这些事：重心应放在让你反复耿耿于怀的具体细节和未证实的猜测上，不要强行和解或原谅；结尾的「下次怎么办」可以是防备、试探、回避或暗中观察，不必写成建设性的坦诚沟通。");
    } else if (brooding >= 7 && reflection >= 7) {
        rules.push("- 你既会反复咀嚼那些刺痛或触动你的细节，也会逼自己从中理出头绪：前半段写出那种挥之不去的纠结感，后半段再落到你修正后的判断与具体应对上。");
    } else if (brooding <= 4 && reflection >= 7) {
        rules.push("- 你不习惯在情绪里原地打转：点出事情本身后，把重心放在重新理解对方动机、理清关系走向，以及干净利落的下一步行动上。");
    } else if (brooding <= 4 && reflection <= 4) {
        rules.push("- 你平时懒得把事情翻来覆去地深想：写得简短直接，只记下最直观的印象和下回碰到时的本能反应，不要长篇大论地剖析内心。");
    }

    // 2. 情绪锐度决定「情绪是直给还是压着」
    if (acuity <= 3) {
        rules.push("- 你习惯把情绪压平、隔离或绕开：叙述时多落在实际事务、客观细节或身体上的倦怠感上，避开直接承认自己在乎或难受。");
    } else if (acuity >= 8) {
        rules.push("- 你的情绪体验很重、很直接：心里那股劲（无论是委屈、恼火、动摇还是在乎）不用藏着掖着，顺着当时的生理反应或冲动直白地写出来。");
    }

    return rules.join("\n");
}

/**
 * 拼成注入反思提示词的文本：刻度说明 + 本次三个数 + 结构约束。
 * 不附带任何角色专属形容词或范例，避免被当成素材复述。
 */
export function formatTendencyForPrompt(tendency: ThinkingTendency): string {
    const directives = deriveTendencyStructuralDirectives(tendency);
    return `${TENDENCY_SCALE_LEGEND}
本次：沉思 ${tendency.brooding} · 反思 ${tendency.reflection} · 情绪 ${tendency.acuity}（均 1-10）${directives ? `\n\n【基于你思考习惯的本轮行文约束】\n${directives}` : ""}`;
}

/**
 * 把思考倾向注入反思提示词：
 * 模板里有 {{tendency}} 就原地替换；用户自定义模板没这个占位符时整段前置，
 * 这样即使提示词被改过也不会丢掉特质。
 */
export function applyTendencyToPrompt(prompt: string, tendency: ThinkingTendency | null): string {
    if (!tendency) return prompt;
    const body = formatTendencyForPrompt(tendency);
    if (/\{\{tendency\}\}/i.test(prompt)) {
        return prompt.replace(/\{\{tendency\}\}/gi, body);
    }
    // 自定义模板里没有占位符时前置「刻度说明 + 本次数值」，保证模型知道数字在量什么
    return `【你惯常的思考强度】\n${body}\n\n${prompt}`;
}
