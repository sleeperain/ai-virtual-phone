import { jsonrepair } from "jsonrepair";

import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import { previewMessagesForApi, sendLLMRequest, ChatEngineError } from "./chat-engine";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { MacroEngine } from "./macro-engine";
import { normalizeUserNameToMacro } from "./user-macro";
import {
  loadApiConfigs,
  loadBindingConfig,
  loadPresets,
  loadRegexes,
  loadUserIdentities,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { loadInterviewEditorPrompt, loadInterviewMemoryPrompt } from "./interview-magazine-storage";
import {
  INTERVIEW_MAGAZINE_APP_ID,
  type InterviewArticle,
  type InterviewCharacterSnapshot,
  type InterviewGuestSnapshot,
  type InterviewMessage,
  type InterviewUserSnapshot,
  type InterviewWorldBookSnapshot,
} from "./interview-magazine-types";

type InterviewGuestContext = {
  character: Character;
  characterSnapshot: InterviewCharacterSnapshot;
  worldBooks: WorldBookConfig[];
  worldBookSnapshot: InterviewWorldBookSnapshot[];
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
};

type InterviewContext = {
  guests: InterviewGuestContext[];
  primaryGuest: InterviewGuestContext;
  character: Character;
  characterSnapshot: InterviewCharacterSnapshot;
  userIdentity: UserIdentity | null;
  userSnapshot: InterviewUserSnapshot | null;
  userName: string;
  guestNames: string[];
  guestListText: string;
  worldBooks: WorldBookConfig[];
  worldBookSnapshot: InterviewWorldBookSnapshot[];
  guestSnapshots: InterviewGuestSnapshot[];
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
};

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function cleanArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseJsonLike<T>(raw: string): T | null {
  const source = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?\s*([\s\S]*?)```/i, "$1")
    .trim();
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  const candidate = first >= 0 && last > first ? source.slice(first, last + 1) : source;

  try {
    return JSON.parse(candidate) as T;
  } catch {
    try {
      return JSON.parse(jsonrepair(candidate)) as T;
    } catch {
      return null;
    }
  }
}

export function makeInterviewMessage(
  role: InterviewMessage["role"],
  content: string,
  options?: Pick<InterviewMessage, "kind" | "target" | "targetCharacterId" | "targetCharacterName" | "speakerCharacterId" | "speakerName">,
): InterviewMessage {
  return {
    id: createId("imsg"),
    role,
    content,
    kind: options?.kind,
    target: options?.target,
    targetCharacterId: options?.targetCharacterId,
    targetCharacterName: options?.targetCharacterName,
    speakerCharacterId: options?.speakerCharacterId,
    speakerName: options?.speakerName,
    createdAt: new Date().toISOString(),
  };
}

function joinChineseNames(names: string[]): string {
  const cleaned = names.map((name) => name.trim()).filter(Boolean);
  if (cleaned.length === 0) return "嘉宾";
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]}和${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join("、")}和${cleaned[cleaned.length - 1]}`;
}

function normalizeCharacterIds(characterIds: string | string[]): string[] {
  const source = Array.isArray(characterIds) ? characterIds : [characterIds];
  return [...new Set(source.map((id) => id.trim()).filter(Boolean))];
}

export function formatInterviewTranscript(
  messages: InterviewMessage[],
  characterName: string,
  userName: string,
  characterNameById?: Record<string, string>,
): string {
  if (messages.length === 0) return "（暂无采访实录）";
  return messages
    .map((message) => {
      // 旧版实录里的 AI 主持人发言（仅历史数据会遇到）
      if (message.role === "host") return `主持人：${message.content}`;
      if (message.role === "character") {
        const speakerName = message.speakerName
          || (message.speakerCharacterId ? characterNameById?.[message.speakerCharacterId] : undefined)
          || characterName;
        return `${speakerName}：${message.content}`;
      }
      return `${userName}（主持人）：${message.content}`;
    })
    .join("\n");
}

function snapshotCharacter(character: Character): InterviewCharacterSnapshot {
  return {
    id: character.id,
    name: character.name,
    avatar: character.avatar,
    persona: character.persona ?? "",
    personality: character.personality,
    tags: character.tags ?? [],
  };
}

function snapshotUserIdentity(identity: UserIdentity | null): InterviewUserSnapshot | null {
  if (!identity) return null;
  return {
    name: identity.name,
    gender: identity.gender,
    age: identity.age,
    occupation: identity.occupation,
    bio: identity.bio,
    customSettings: identity.customSettings,
  };
}

function resolveInterviewUserIdentity(characterIds: string[], userIdentityId?: string): UserIdentity | null {
  const identities = loadUserIdentities();
  if (identities.length === 0) return null;
  if (userIdentityId) {
    return identities.find((identity) => identity.id === userIdentityId) || identities[0];
  }
  const resolved = characterIds
    .map((characterId) => resolveUserIdentity(characterId, INTERVIEW_MAGAZINE_APP_ID))
    .filter(Boolean) as UserIdentity[];
  const uniqueIds = new Set(resolved.map((identity) => identity.id));
  if (resolved.length > 0 && uniqueIds.size === 1) return resolved[0];
  return identities[0];
}

function formatCharacterCard(snapshot: InterviewCharacterSnapshot): string {
  return [
    `姓名：${snapshot.name}`,
    `人设：${snapshot.persona || "（未填写）"}`,
    `性格：${snapshot.personality || "（未填写）"}`,
    `标签：${snapshot.tags.length > 0 ? snapshot.tags.join("、") : "（无）"}`,
  ].join("\n");
}

function formatUserSnapshot(snapshot: InterviewUserSnapshot | null): string {
  if (!snapshot) return "（未提供主持人资料）";
  return [
    `姓名：${snapshot.name || "用户"}`,
    snapshot.gender ? `性别：${snapshot.gender}` : "",
    snapshot.age ? `年龄：${snapshot.age}` : "",
    snapshot.occupation ? `职业：${snapshot.occupation}` : "",
    snapshot.bio ? `简介：${snapshot.bio}` : "",
    snapshot.customSettings ? `补充设定：${snapshot.customSettings}` : "",
  ].filter(Boolean).join("\n") || "（未提供主持人资料）";
}

function snapshotWorldBooks(worldBooks: WorldBookConfig[]): InterviewWorldBookSnapshot[] {
  return worldBooks.map((book) => ({
    id: book.id,
    name: book.name,
    entries: (book.entries || [])
      .filter((entry) => !entry.disable)
      .map((entry) => ({
        key: entry.key,
        comment: entry.comment,
        content: entry.content,
      })),
  }));
}

function formatWorldBooks(snapshot: InterviewWorldBookSnapshot[]): string {
  if (snapshot.length === 0) return "（未提供补充资料）";
  const lines: string[] = [];
  for (const book of snapshot) {
    lines.push(`【${book.name}】`);
    if (book.entries.length === 0) {
      lines.push("（无启用词条）");
      continue;
    }
    book.entries.forEach((entry, index) => {
      lines.push(`${index + 1}. 关键词：${entry.key || "（无）"}`);
      if (entry.comment) lines.push(`说明：${entry.comment}`);
      lines.push(`内容：${entry.content}`);
    });
  }
  return lines.join("\n");
}

export function loadInterviewContext(characterId: string): InterviewContext {
  return loadInterviewContextForGuests([characterId]);
}

export function loadInterviewContextForGuests(characterIds: string[], userIdentityId?: string): InterviewContext {
  const ids = normalizeCharacterIds(characterIds);
  if (ids.length === 0) throw new ChatEngineError("请选择至少一位有效角色。");
  const allCharacters = loadCharacters();
  const bindings = loadBindingConfig();
  const presets = loadPresets();
  const apiConfigs = loadApiConfigs();
  const allWorldBooks = loadWorldBooks();
  const allRegexes = loadRegexes();
  const guests = ids.map((id) => {
    const character = allCharacters.find((item) => item.id === id);
    if (!character) throw new ChatEngineError(`找不到受访角色：${id}`);

    const slot = resolveBinding(bindings, id, INTERVIEW_MAGAZINE_APP_ID);
    if (!slot.apiConfigId) {
      throw new ChatEngineError(`未给「在场」绑定 ${character.name} 的 API 配置。`);
    }

    const apiConfig = apiConfigs.find((config) => config.id === slot.apiConfigId);
    if (!apiConfig) throw new ChatEngineError(`找不到 ${character.name} 的「在场」API 配置。`);

    let preset = slot.presetId ? presets.find((entry) => entry.id === slot.presetId) ?? null : null;
    if (!preset) preset = presets.find((entry) => entry.builtIn) ?? null;

    const worldBooks = (slot.worldBookIds || [])
      .map((bookId) => allWorldBooks.find((book) => book.id === bookId))
      .filter(Boolean) as WorldBookConfig[];

    const regexes = (slot.regexIds || [])
      .map((regexId) => allRegexes.find((group) => group.id === regexId))
      .filter(Boolean) as RegexConfig[];

    return {
      character,
      characterSnapshot: snapshotCharacter(character),
      worldBooks,
      worldBookSnapshot: snapshotWorldBooks(worldBooks),
      apiConfig,
      preset,
      regexes,
    };
  });

  const primaryGuest = guests[0];
  const userIdentity = resolveInterviewUserIdentity(ids, userIdentityId);
  const userSnapshot = snapshotUserIdentity(userIdentity);
  const guestNames = guests.map((guest) => guest.character.name);
  const guestSnapshots = guests.map((guest) => ({
    characterId: guest.character.id,
    characterName: guest.character.name,
    characterSnapshot: guest.characterSnapshot,
    worldBookSnapshot: guest.worldBookSnapshot,
  }));

  return {
    guests,
    primaryGuest,
    character: primaryGuest.character,
    characterSnapshot: primaryGuest.characterSnapshot,
    userIdentity,
    userSnapshot,
    userName: userSnapshot?.name || "用户",
    guestNames,
    guestListText: joinChineseNames(guestNames),
    worldBooks: primaryGuest.worldBooks,
    worldBookSnapshot: primaryGuest.worldBookSnapshot,
    guestSnapshots,
    apiConfig: primaryGuest.apiConfig,
    preset: primaryGuest.preset,
    regexes: primaryGuest.regexes,
  };
}

function getCharacterNameMap(context: InterviewContext): Record<string, string> {
  return Object.fromEntries(context.guests.map((guest) => [guest.character.id, guest.character.name]));
}

function findGuestContext(context: InterviewContext, characterId: string): InterviewGuestContext {
  return context.guests.find((guest) => guest.character.id === characterId) || context.primaryGuest;
}

function getOtherGuestNames(context: InterviewContext, currentCharacterId: string): string {
  const names = context.guests
    .filter((guest) => guest.character.id !== currentCharacterId)
    .map((guest) => guest.character.name);
  return names.length > 0 ? joinChineseNames(names) : "无";
}

function formatGuestCards(context: InterviewContext): string {
  return context.guests
    .map((guest, index) => [
      `【嘉宾 ${index + 1}：${guest.character.name}】`,
      formatCharacterCard(guest.characterSnapshot),
    ].join("\n"))
    .join("\n\n");
}

function formatGuestWorldBooks(context: InterviewContext): string {
  if (context.guests.every((guest) => guest.worldBookSnapshot.length === 0)) return "（未提供补充资料）";
  return context.guests
    .map((guest) => [
      `【${guest.character.name} 的补充资料】`,
      formatWorldBooks(guest.worldBookSnapshot),
    ].join("\n"))
    .join("\n\n");
}

function buildInterviewBriefing(params: {
  context: InterviewContext;
  theme: string;
  phase: string;
  transcript: InterviewMessage[];
}): string {
  const { context, theme, phase, transcript } = params;
  return [
    "<interview_briefing>",
    `本期主题：${theme}`,
    `当前采访阶段：${phase}`,
    `本期嘉宾：${context.guestListText}`,
    `主持人：${context.userName}`,
    "",
    "<guest_reference>",
    formatGuestCards(context),
    "</guest_reference>",
    "",
    "<guest_background>",
    formatGuestWorldBooks(context),
    "</guest_background>",
    "",
    "<host_profile>",
    formatUserSnapshot(context.userSnapshot),
    "</host_profile>",
    "",
    "<transcript>",
    formatInterviewTranscript(transcript, context.character.name, context.userName, getCharacterNameMap(context)),
    "</transcript>",
    "</interview_briefing>",
  ].join("\n");
}

async function callEditorJson<T>(context: InterviewContext, systemPrompt: string, userPrompt: string): Promise<T | null> {
  const raw = await sendLLMRequest(
    context.apiConfig,
    null,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    [],
    { characterName: context.userName, userName: context.userName },
    { skipOutputRegex: true, appId: INTERVIEW_MAGAZINE_APP_ID },
  );
  return parseJsonLike<T>(raw);
}

function expandInterviewPromptMacros(prompt: string, context: InterviewContext): string {
  const engine = new MacroEngine(context.character.name, context.userName);
  engine.interviewGuests = context.guestListText;
  engine.interviewGuestCount = String(context.guests.length);
  engine.interviewCurrentGuest = context.character.name;
  engine.interviewOtherGuests = getOtherGuestNames(context, context.character.id);
  return engine.expand(prompt);
}

function expandMemoryPromptMacros(prompt: string, context: InterviewContext): string {
  const literalUserMacro = "__INTERVIEW_LITERAL_USER_MACRO__";
  return expandInterviewPromptMacros(
    prompt.replace(/\{\{\s*user\s*\}\}/gi, literalUserMacro),
    context,
  ).replaceAll(literalUserMacro, "{{user}}");
}

function buildEditorSystemPrompt(context: InterviewContext, lines: string[]): string {
  return [
    expandInterviewPromptMacros(loadInterviewEditorPrompt(), context),
    "",
    ...lines,
    "输出必须是 JSON，不要 markdown，不要解释。",
  ].join("\n");
}

// 主持人由用户本人担任：这里不再有「开场白 / 追问」的生成入口。
// 用户提问 -> 嘉宾回答的循环由 UI 驱动，引擎只负责嘉宾回答与最后的成刊整理。

export async function generateCharacterInterviewAnswer(params: {
  theme: string;
  characterIds: string | string[];
  characterId: string;
  userIdentityId?: string;
  question: string;
  transcript: InterviewMessage[];
  round: number;
  lastUserAnswer?: string;
}): Promise<string> {
  const context = loadInterviewContextForGuests(normalizeCharacterIds(params.characterIds), params.userIdentityId);
  const guest = findGuestContext(context, params.characterId);
  const transcript = formatInterviewTranscript(params.transcript, guest.character.name, context.userName, getCharacterNameMap(context));
  const characterAnswerHistory = params.transcript
    .filter((message) => message.role === "character" && (!message.speakerCharacterId || message.speakerCharacterId === guest.character.id))
    .map((message) => message.content)
    .join("\n\n");

  const llmMessages = assemblePromptPayload({
    character: guest.character,
    history: [],
    preset: guest.preset,
    worldBooks: guest.worldBooks,
    regexes: guest.regexes,
    userIdentity: context.userIdentity,
    appId: INTERVIEW_MAGAZINE_APP_ID,
    appTags: ["interview_magazine", "answer"],
    worldBookActivationContext: `${params.theme}\n${params.question}\n${transcript}`,
    interviewTheme: params.theme,
    interviewHostName: context.userName,
    interviewGuests: context.guestListText,
    interviewGuestCount: String(context.guests.length),
    interviewCurrentGuest: guest.character.name,
    interviewOtherGuests: getOtherGuestNames(context, guest.character.id),
    interviewQuestion: params.question,
    interviewTranscript: transcript,
    interviewPhase: "嘉宾回答主持人的提问",
    interviewRound: String(params.round),
    interviewUserAnswer: params.lastUserAnswer || "",
    interviewCharacterAnswerHistory: characterAnswerHistory,
  });

  const raw = await sendLLMRequest(
    guest.apiConfig,
    guest.preset,
    llmMessages,
    guest.regexes,
    { characterName: guest.character.name, userName: context.userName },
    { appId: INTERVIEW_MAGAZINE_APP_ID, appTags: ["interview_magazine", "answer"] },
  );

  return cleanText(raw, 1000) || "（沉默了一会儿）这个问题，我需要从一个很小的地方说起。";
}

export async function previewInterviewMagazinePromptPayload(params: {
  theme: string;
  characterIds: string | string[];
  mode: "answer" | "article";
  transcript?: InterviewMessage[];
  question?: string;
  issueNumber?: number;
  userIdentityId?: string;
}): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const context = loadInterviewContextForGuests(normalizeCharacterIds(params.characterIds), params.userIdentityId);
  const transcript = params.transcript ?? [];
  if (params.mode === "article") {
    const briefing = buildInterviewBriefing({
      context,
      theme: params.theme,
      phase: "采访结束，编辑部将实录整理为杂志专栏",
      transcript,
    });
    const memoryPrompt = expandMemoryPromptMacros(loadInterviewMemoryPrompt(), context);
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: buildEditorSystemPrompt(context, [
          "当前任务：以主编视角将采访实录整理成中文杂志专栏。",
          "你不新增用户事实，不编造参考材料以外的背景。",
        ]),
      },
      {
        role: "user",
        content: [
          briefing,
          "",
          `本期刊号：${params.issueNumber ?? 1}`,
          "请撰写一篇杂志专栏：",
          "- title：4-10 字中文主标题，凝练有记忆点。",
          "- subtitle：18-40 字副标题，像 deck，不要空泛。",
          "- body：3-5 段，每段 90-180 字。允许场景描写、作者观察、自然引用原话。",
          "- pullQuote：从嘉宾回答中抽一句 12-36 字的大字引语；多人时优先选最能代表本期主题的一句。",
          "- qa：精选 3 条 Q&A，问题简短，回答 30-80 字。",
          "- memorySummary：根据下方“访谈记忆摘要提示词”生成短期记忆摘要，只写摘要正文。",
          "- memorySummary 中不要出现主持人的具体姓名，一律用「主持人」代称。",
          "",
          "<memory_summary_instruction>",
          memoryPrompt,
          "</memory_summary_instruction>",
          "",
          '返回格式：{"title":"...","subtitle":"...","body":["..."],"pullQuote":"...","qa":[{"q":"...","a":"..."}],"memorySummary":"..."}',
        ].join("\n"),
      },
    ];
    return {
      messages: previewMessagesForApi(context.apiConfig, null, messages),
      characterName: "在场编辑部·专栏",
      model: context.apiConfig.defaultModel,
      presetName: "(无预设)",
    };
  }

  const guest = context.primaryGuest;
  const transcriptText = formatInterviewTranscript(transcript, context.character.name, context.userName, getCharacterNameMap(context));
  const llmMessages = assemblePromptPayload({
    character: guest.character,
    history: [],
    preset: guest.preset,
    worldBooks: guest.worldBooks,
    regexes: guest.regexes,
    userIdentity: context.userIdentity,
    appId: INTERVIEW_MAGAZINE_APP_ID,
    appTags: ["interview_magazine", "answer"],
    worldBookActivationContext: `${params.theme}\n${params.question || "请谈谈你此刻最想回应的问题。"}\n${transcriptText}`,
    interviewTheme: params.theme,
    interviewHostName: context.userName,
    interviewGuests: context.guestListText,
    interviewGuestCount: String(context.guests.length),
    interviewCurrentGuest: guest.character.name,
    interviewOtherGuests: getOtherGuestNames(context, guest.character.id),
    interviewQuestion: params.question || "请谈谈你此刻最想回应的问题。",
    interviewTranscript: transcriptText,
    interviewPhase: "嘉宾回答主持人的提问",
    interviewRound: "1",
    interviewUserAnswer: "",
    interviewCharacterAnswerHistory: "",
  });
  return {
    messages: previewMessagesForApi(guest.apiConfig, guest.preset, llmMessages),
    characterName: `在场:${guest.character.name}`,
    model: guest.apiConfig.defaultModel,
    presetName: guest.preset?.name ?? "默认预设",
  };
}

export async function composeInterviewArticle(params: {
  theme: string;
  characterIds: string | string[];
  userIdentityId?: string;
  transcript: InterviewMessage[];
  issueNumber: number;
}): Promise<{ context: InterviewContext; article: InterviewArticle }> {
  const context = loadInterviewContextForGuests(normalizeCharacterIds(params.characterIds), params.userIdentityId);
  const briefing = buildInterviewBriefing({
    context,
    theme: params.theme,
    phase: "采访结束，编辑部将实录整理为杂志专栏",
    transcript: params.transcript,
  });
  const memoryPrompt = expandMemoryPromptMacros(loadInterviewMemoryPrompt(), context);
  const result = await callEditorJson<Partial<InterviewArticle>>(
    context,
    buildEditorSystemPrompt(context, [
      "当前任务：把主持人（{{user}}）与嘉宾的采访实录整理成一篇中文杂志专栏。",
      "你不新增用户事实，不编造参考材料以外的背景；你不扮演主持人，也不替任何人补充回答。",
    ]),
    [
      briefing,
      "",
      `本期刊号：${params.issueNumber}`,
      "请撰写一篇杂志专栏：",
      "- title：4-10 字中文主标题，凝练有记忆点。",
      "- subtitle：18-40 字副标题，像 deck，不要空泛。",
      "- body：3-5 段，每段 90-180 字。允许场景描写、作者观察、自然引用原话。",
      "- pullQuote：从嘉宾回答中抽一句 12-36 字的大字引语；多人时优先选最能代表本期主题的一句。",
      "- qa：精选 3 条 Q&A，问题简短，回答 30-80 字。",
      "- memorySummary：根据下方“访谈记忆摘要提示词”生成短期记忆摘要，只写摘要正文。",
      "- memorySummary 中不要出现主持人的具体姓名，一律用「主持人」代称。",
      "",
      "<memory_summary_instruction>",
      memoryPrompt,
      "</memory_summary_instruction>",
      "",
      '返回格式：{"title":"...","subtitle":"...","body":["..."],"pullQuote":"...","qa":[{"q":"...","a":"..."}],"memorySummary":"..."}',
    ].join("\n"),
  );

  const fallbackTitle = params.theme.slice(0, 10) || "未命名访谈";
  const article: InterviewArticle = {
    title: cleanText(result?.title, 40) || fallbackTitle,
    subtitle: cleanText(result?.subtitle, 90) || "一次关于沉默、细节与当下的对谈。",
    body: cleanArray(result?.body, 5, 420),
    pullQuote: cleanText(result?.pullQuote, 80),
    qa: Array.isArray(result?.qa)
      ? result!.qa!.map((item) => ({
        q: cleanText((item as Record<string, unknown>).q, 140),
        a: cleanText((item as Record<string, unknown>).a, 220),
      })).filter((item) => item.q && item.a).slice(0, 3)
      : [],
    memorySummary: normalizeUserNameToMacro(cleanText(result?.memorySummary, 360), context.userName),
  };

  if (article.body.length === 0) {
    article.body = [
      "采访结束时，现场有短暂的安静。那些答案没有急着成为结论，而是像被放在桌面上的录音笔，仍然带着一点余温。",
      `围绕「${params.theme}」，${context.userName}以主持人的身份，把${context.guestListText}带到了更私人、更具体的地方。`,
    ];
  }

  if (!article.memorySummary) {
    article.memorySummary = `围绕「${params.theme}」，{{user}}主持了一期访谈，嘉宾是${context.guestListText}；对谈集中在具体选择、关系张力和未说出口的态度变化上。`;
  }

  return { context, article };
}
