import type { Character } from "./character-types";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import type { AssemblerInput, LLMMessage } from "./llm-prompt-assembler";
import type { CalendarOwnerType, CalendarRoutineDayType, CalendarRoutineItem, CalendarScheduleItem } from "./calendar-types";
import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadWorldBooks,
  loadRegexes,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import { assemblePromptPayload } from "./llm-prompt-assembler";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { getCustomStickerExample, getCustomStickerNames } from "./custom-sticker-storage";
import { previewMessagesForApi, sendLLMRequest, type ChatEngineError } from "./chat-engine";
import {
  buildCalendarScheduleMarker,
  loadCalendarConfig,
  clearGeneratedRoutineItems,
  clearGeneratedWeekItems,
  cloneRoutinePlanWithManualEdits,
  cloneWeekPlanWithManualEdits,
  normalizeGeneratedRoutineItems,
  normalizeGeneratedScheduleItems,
  restoreCalendarWeekItems,
  restoreCharacterRoutineItems,
} from "./calendar-storage";
import {
  getWeekDates,
  getWeekStartIso,
  getWeekdayLabel,
  isCalendarTimeRangeAllowed,
  normalizeTime,
  sanitizeScheduleEmoji,
} from "./calendar-utils";

type CalendarAssemblerResolved = {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  llmMessages: LLMMessage[];
  ownerName: string;
};

function buildSyntheticUserCharacter(identity: UserIdentity | null): Character {
  const now = new Date().toISOString();
  const personaLines = [
    identity?.bio?.trim(),
    identity?.occupation ? `职业：${identity.occupation}` : "",
    identity?.age ? `年龄：${identity.age}` : "",
    identity?.gender && identity.gender !== "保密" ? `性别：${identity.gender}` : "",
    identity?.customSettings?.trim(),
  ].filter(Boolean);

  return {
    id: "__calendar_user__",
    name: identity?.name?.trim() || "用户",
    avatar: identity?.avatarUrl || null,
    persona: personaLines.join("\n") || "这是用户本人。",
    wechatID: "",
    createdAt: now,
    updatedAt: now,
  };
}

function buildCalendarTriggerInstruction(ownerName: string, weekDates: string[]): string {
  return [
    `请为${ownerName}生成 ${weekDates[0]} 到 ${weekDates[6]} 这一周的日程安排。`,
    "请参考已有日程，生成这一周的完整日程安排。",
    "每行一条，格式：YYYY-MM-DD|周几|开始时间|结束时间|地点|emoji|事项。emoji 段填一个最贴合该事项的表情符号。",
    "作息时间不受限制（早起、夜跑、通宵都可以安排），但每一天最多 5 条日程，宁缺毋滥。",
  ].join("\n");
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/\s*```$/g, "")
    .trim();
}

function parseScheduleLines(rawText: string, weekStart: string): CalendarScheduleItem[] {
  const weekDates = new Set(getWeekDates(weekStart));
  const lines = stripCodeFences(rawText)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const parsed: Array<{
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    title: string;
    emoji?: string;
  }> = [];

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/^[-*]\s*/, "")
      .replace(/^\d+[.)、]\s*/, "")
      .trim();
    if (!line.includes("|")) continue;
    const parts = line.split("|").map(part => part.trim());
    if (parts.length < 6) continue;

    const date = parts[0];
    const startTime = normalizeTime(parts[2]);
    const endTime = normalizeTime(parts[3]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !weekDates.has(date)) continue;
    if (!startTime || !endTime || !isCalendarTimeRangeAllowed(startTime, endTime)) continue;

    const location = parts[4] === "无" ? "" : parts[4];
    // 新格式第 6 段为 emoji（YYYY-MM-DD|周几|开始|结束|地点|emoji|事项）；
    // 兼容旧格式（第 6 段直接是事项）：仅当该段确实是 emoji 时才按新格式取。
    let emoji = "";
    let title: string;
    if (parts.length >= 7) {
      const candidate = sanitizeScheduleEmoji(parts[5]);
      if (candidate && Array.from(parts[5]).length <= 3) {
        emoji = candidate;
        title = parts.slice(6).join("|");
      } else {
        title = parts.slice(5).join("|");
      }
    } else {
      title = parts[5];
    }
    if (!title.trim()) continue;

    parsed.push({
      date,
      startTime,
      endTime,
      location,
      title,
      emoji,
    });
  }

  return normalizeGeneratedScheduleItems(parsed);
}

async function resolveCalendarAssemblerInput(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<CalendarAssemblerResolved> {
  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, ownerType === "character" ? ownerId : undefined, "calendar");

  if (!activeSlot.apiConfigId) {
    throw new Error("未绑定日历 API，请先在配置绑定中为日历设置 API。");
  }

  const apiConfigs = loadApiConfigs();
  const apiConfig = apiConfigs.find(entry => entry.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new Error("日历 API 配置不存在。");
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find(entry => entry.id === activeSlot.presetId) ?? null : null;
  if (!preset) preset = presets.find(entry => entry.builtIn) ?? null;

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map(id => allWorldBooks.find(entry => entry.id === id))
    .filter(Boolean) as WorldBookConfig[];

  const allRegexes = loadRegexes();
  const regexes = (activeSlot.regexIds || [])
    .map(id => allRegexes.find(entry => entry.id === id))
    .filter(Boolean) as RegexConfig[];

  const userIdentity = resolveUserIdentity(ownerType === "character" ? ownerId : undefined, "calendar");
  const character =
    ownerType === "character"
      ? loadCharacters().find(entry => entry.id === ownerId)
      : buildSyntheticUserCharacter(resolveUserIdentity(undefined, "calendar"));

  if (!character) {
    throw new Error("日历目标不存在。");
  }

  const memConfig = loadMemoryConfig();
  let coreMemories = "";
  let longTermMemories = "";
  let recentBlocks: import("./short-term-assembler").RecentBlock[] = [];
  let unifiedRecentItems: import("./short-term-assembler").UnifiedRecentItem[] = [];
  let wbActivationContext = "";

  if (ownerType === "character") {
    const prepared = prepareShortTermContext(ownerId, "calendar", { history: [] });
    recentBlocks = prepared.recentBlocks;
    unifiedRecentItems = prepared.unifiedRecentItems;
    wbActivationContext = prepared.wbActivationContext;
    const [coreResults, longResults] = await Promise.all([
      retrieveCoreMemoriesForPrompt(ownerId, memConfig).catch(() => []),
      retrieveMemoriesForPrompt(ownerId, wbActivationContext, memConfig).catch(() => []),
    ]);
    coreMemories = formatCoreMemories(coreResults);
    longTermMemories = formatLongTermMemories(longResults);
  }

  const scheduleSummary = buildCalendarScheduleMarker(ownerType, ownerId, weekStart);
  const llmMessages = assemblePromptPayload({
    character,
    history: [],
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "calendar",
    scheduleSummary,
    coreMemories,
    longTermMemories,
    worldBookActivationContext: wbActivationContext || undefined,
    recentBlocks,
    unifiedRecentItems,
    customStickerNames: ownerType === "character" ? getCustomStickerNames(ownerId) : "",
    customStickerExample: ownerType === "character" ? getCustomStickerExample(ownerId) : "",
  } as AssemblerInput);

  return {
    apiConfig,
    preset,
    regexes,
    llmMessages,
    ownerName: character.name,
  };
}

export async function generateWeeklyCalendarSchedule(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<{ success: boolean; error?: string; items?: CalendarScheduleItem[] }> {
  if (ownerType !== "character") {
    return { success: false, error: "用户日程不支持 AI 生成，请手动填写。" };
  }
  // 先清掉本周旧的 AI 生成条目（保留手动条目），让随后的 marker 组装读不到旧结果——
  // 否则旧日程会进提示词被模型原样照抄，"重新生成"永远一字不差。失败时恢复。
  const removedGenerated = clearGeneratedWeekItems(ownerType, ownerId, weekStart);
  const restoreRemoved = () => restoreCalendarWeekItems(ownerType, ownerId, weekStart, removedGenerated);
  try {
    const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart);
    const weekDates = getWeekDates(weekStart);
    const triggerInstruction = buildCalendarTriggerInstruction(resolved.ownerName, weekDates);

    const messages: LLMMessage[] = [
      ...resolved.llmMessages,
      {
        role: "user",
        content: triggerInstruction,
        _debugMeta: { marker: "calendar_trigger" },
      },
    ];

    const rawText = await sendLLMRequest(
      resolved.apiConfig,
      resolved.preset,
      messages,
      resolved.regexes,
      { characterName: `日历:${resolved.ownerName}` },
      { appId: "calendar", appTags: ["calendar"] },
    );

    const items = parseScheduleLines(rawText, weekStart);
    if (items.length === 0) {
      restoreRemoved();
      return { success: false, error: "日历生成结果为空，或格式无法解析。" };
    }

    cloneWeekPlanWithManualEdits(ownerType, ownerId, weekStart, items);
    return { success: true, items };
  } catch (error) {
    restoreRemoved();
    const err = error as ChatEngineError | Error;
    return { success: false, error: err?.message || "生成日历失败" };
  }
}

export async function previewCalendarPromptPayload(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  if (ownerType !== "character") {
    throw new Error("用户日程不支持 AI 生成预览。");
  }
  const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart);
  const weekDates = getWeekDates(weekStart);
  const triggerInstruction = buildCalendarTriggerInstruction(resolved.ownerName, weekDates);

  const messages: LLMMessage[] = [
    ...resolved.llmMessages,
    {
      role: "user",
      content: triggerInstruction,
      _debugMeta: { marker: "calendar_trigger" },
    },
  ];

  const apiMessages = previewMessagesForApi(resolved.apiConfig, resolved.preset, messages);
  return {
    messages: apiMessages,
    characterName: `日历:${resolved.ownerName}`,
    model: resolved.apiConfig.defaultModel,
    presetName: resolved.preset?.name ?? "(无预设)",
  };
}

export function createDefaultScheduleDraft(date: string) {
  return {
    date,
    weekday: getWeekdayLabel(date),
    startTime: "09:00",
    endTime: "10:00",
    location: "",
    title: "",
    emoji: "",
    source: "manual" as const,
  };
}

export function getCurrentWeekStart(): string {
  return getWeekStartIso(new Date());
}

/** 作息提示词里的角色名占位符（写别的写法不会被替换） */
export const ROUTINE_PROMPT_NAME_TOKEN = "{{name}}";

/**
 * 内置的「AI 生成作息」提示词。日历设置里的「生活节律提示词」留空时用它；
 * 设置页的「填入内置提示词」也拿它做编辑起点。
 */
export function buildDefaultRoutinePrompt(): string {
  return [
    `请为${ROUTINE_PROMPT_NAME_TOKEN}生成「工作日」与「节假日」的日常作息时间表（生活节律 / 常规事件）。`,
    "请结合角色的人设、职业、性格与生活习惯，规划一天中各个时间段的典型日常活动（如起床、通勤/工作/学习、用餐、休闲娱乐、运动、休息就寝等）。",
    "每行一条，严格按以下 6 段格式输出：类型|开始时间|结束时间|地点|事项|备注",
    "其中「类型」只能填「工作日」或「节假日」；开始时间与结束时间为 HH:MM（24小时制，结束时间需晚于开始时间，跨夜请拆分为 23:59 前后）。",
    "「备注」写更细节的活动：这个时段具体在做什么、和谁、什么状态（例如“闹钟响三遍才爬起来，抓着面包出门”“边吃饭边刷手机看剧”）；没有细节可写时填「无」。",
    "工作日和节假日各安排 5~10 条，覆盖全天主要时间节律，不要输出解释文字。",
  ].join("\n");
}

/**
 * 真正发出去的那段指令：设置了自定义提示词就用它，空着用内置的。
 * 两种来源都做一次 {{name}} → 角色名 的替换。
 */
export function buildRoutineTriggerInstruction(ownerName: string, template?: string): string {
  const body = (template ?? "").trim() || buildDefaultRoutinePrompt();
  return body.split(ROUTINE_PROMPT_NAME_TOKEN).join(ownerName);
}

function parseRoutineLines(rawText: string): CalendarRoutineItem[] {
  const lines = stripCodeFences(rawText)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const parsed: Array<{
    dayType: CalendarRoutineDayType;
    startTime: string;
    endTime: string;
    location: string;
    title: string;
    note: string;
  }> = [];

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/^[-*]\s*/, "")
      .replace(/^\d+[.)、]\s*/, "")
      .trim();
    if (!line.includes("|")) continue;
    const parts = line.split("|").map(part => part.trim());
    if (parts.length < 5) continue;

    const rawType = parts[0];
    let dayType: CalendarRoutineDayType | null = null;
    if (/工作日|平日|weekday|workday/i.test(rawType)) {
      dayType = "workday";
    } else if (/节假日|休息日|周末|假日|holiday|weekend/i.test(rawType)) {
      dayType = "holiday";
    }
    if (!dayType) continue;

    const startTime = normalizeTime(parts[1]);
    const endTime = normalizeTime(parts[2]);
    if (!startTime || !endTime || !isCalendarTimeRangeAllowed(startTime, endTime)) continue;

    const location = parts[3] === "无" ? "" : parts[3];
    const title = parts[4];
    if (!title.trim()) continue;
    // 第 6 段是备注（可以很长）；没有或写「无」就不留
    const rawNote = parts.slice(5).join("|").trim();
    const note = rawNote === "无" || rawNote === "-" ? "" : rawNote;

    parsed.push({
      dayType,
      startTime,
      endTime,
      location,
      title,
      note,
    });
  }

  return normalizeGeneratedRoutineItems(parsed);
}

export async function generateCharacterRoutineSchedule(
  ownerId: string,
): Promise<{ success: boolean; error?: string; items?: CalendarRoutineItem[] }> {
  const removedGenerated = clearGeneratedRoutineItems(ownerId);
  const restoreRemoved = () => restoreCharacterRoutineItems(ownerId, removedGenerated);
  try {
    const weekStart = getCurrentWeekStart();
    const resolved = await resolveCalendarAssemblerInput("character", ownerId, weekStart);
    // 设置 → 日历设置 → 生活节律提示词；留空就用内置的那份
    const triggerInstruction = buildRoutineTriggerInstruction(resolved.ownerName, loadCalendarConfig().routinePrompt);

    const messages: LLMMessage[] = [
      ...resolved.llmMessages,
      {
        role: "user",
        content: triggerInstruction,
        _debugMeta: { marker: "calendar_routine_trigger" },
      },
    ];

    const rawText = await sendLLMRequest(
      resolved.apiConfig,
      resolved.preset,
      messages,
      resolved.regexes,
      { characterName: `作息:${resolved.ownerName}` },
      { appId: "calendar", appTags: ["calendar"] },
    );

    const items = parseRoutineLines(rawText);
    if (items.length === 0) {
      restoreRemoved();
      return { success: false, error: "生活节律生成结果为空，或格式无法解析。" };
    }

    cloneRoutinePlanWithManualEdits(ownerId, items);
    return { success: true, items };
  } catch (error) {
    restoreRemoved();
    const err = error as ChatEngineError | Error;
    return { success: false, error: err?.message || "生成生活节律失败" };
  }
}
