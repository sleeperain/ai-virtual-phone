// lib/character-roaming-storage.ts
// 角色后台自主活动（不打扰私聊）：网页挂在后台或闲置时，角色按设定间隔去群聊发话、
// 发/刷小红书、写手记（日记）、自主调用工具或发朋友圈。

import { kvGet, kvSet, registerDynamicPrefix, registerKvMigration } from "./kv-db";

export const CHARACTER_ROAMING_RULES_KEY = "ai_phone_character_roaming_rules_v1";
export const CHARACTER_ROAMING_EVENTS_PREFIX = "ai_phone_character_roaming_events_";
export const CHARACTER_ROAMING_UPDATED_EVENT = "character-roaming-rules-updated";

registerKvMigration(CHARACTER_ROAMING_RULES_KEY);
registerDynamicPrefix(CHARACTER_ROAMING_EVENTS_PREFIX);

export type RoamingActivityKind =
    | "group_chat"
    | "xiaohongshu"
    | "diary"
    | "tools"
    | "moments";

export const ALL_ROAMING_ACTIVITIES: RoamingActivityKind[] = [
    "group_chat",
    "xiaohongshu",
    "diary",
    "tools",
    "moments",
];

export const DEFAULT_ROAMING_ACTIVITIES: RoamingActivityKind[] = [
    "group_chat",
    "xiaohongshu",
    "diary",
    "tools",
];

export const ROAMING_ACTIVITY_LABELS: Record<RoamingActivityKind, string> = {
    group_chat: "群聊主动发话",
    xiaohongshu: "小红书动态",
    diary: "写日记",
    tools: "自主调用工具",
    moments: "发朋友圈",
};

export const ROAMING_DEFAULT_MAX_CONSECUTIVE = 5;

export type CharacterRoamingRule = {
    id: string;
    characterId: string;
    enabled: boolean;
    /** 活动间隔（分钟），1 分钟 ~ 72 小时 */
    intervalMinutes: number;
    /** 允许的活动类型池 */
    activities: RoamingActivityKind[];
    /** 未操作手机期间最多连续触发次数（用户回到/操作页面后清零） */
    maxConsecutive: number;
    /** 当前已连续触发次数 */
    consecutiveCount: number;
    /** 上次触发时间戳（毫秒） */
    lastFiredAt?: number;
    /** 上次执行的活动描述 */
    lastSummary?: string;
    createdAt: number;
};

export type RoamingTimelineEntry = {
    id: string;
    characterId: string;
    timestamp: string;
    content: string;
};

function isValidActivity(value: unknown): value is RoamingActivityKind {
    return typeof value === "string" && (ALL_ROAMING_ACTIVITIES as string[]).includes(value);
}

function normalizeRule(value: unknown): CharacterRoamingRule | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Partial<CharacterRoamingRule>;
    if (typeof raw.id !== "string" || !raw.id.trim()) return null;
    if (typeof raw.characterId !== "string" || !raw.characterId.trim()) return null;
    const intervalMinutes = Number(raw.intervalMinutes);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) return null;

    const activities = Array.isArray(raw.activities)
        ? Array.from(new Set(raw.activities.filter(isValidActivity)))
        : [];
    if (activities.length === 0) return null;

    const maxConsecutiveRaw = Number(raw.maxConsecutive);
    const maxConsecutive = Number.isFinite(maxConsecutiveRaw) && maxConsecutiveRaw >= 1
        ? Math.min(50, Math.round(maxConsecutiveRaw))
        : ROAMING_DEFAULT_MAX_CONSECUTIVE;

    const consecutiveRaw = Number(raw.consecutiveCount);
    const consecutiveCount = Number.isFinite(consecutiveRaw) && consecutiveRaw >= 0
        ? Math.min(maxConsecutive, Math.round(consecutiveRaw))
        : 0;

    return {
        id: raw.id.trim(),
        characterId: raw.characterId.trim(),
        enabled: raw.enabled !== false,
        intervalMinutes: Math.min(72 * 60, Math.max(1, Math.round(intervalMinutes))),
        activities,
        maxConsecutive,
        consecutiveCount,
        lastFiredAt: typeof raw.lastFiredAt === "number" && Number.isFinite(raw.lastFiredAt) ? raw.lastFiredAt : undefined,
        lastSummary: typeof raw.lastSummary === "string" && raw.lastSummary.trim() ? raw.lastSummary.trim().slice(0, 160) : undefined,
        createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    };
}

function emitRulesUpdated(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(CHARACTER_ROAMING_UPDATED_EVENT));
}

export function loadCharacterRoamingRules(): CharacterRoamingRule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(CHARACTER_ROAMING_RULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeRule).filter((item): item is CharacterRoamingRule => Boolean(item));
    } catch {
        return [];
    }
}

export function saveCharacterRoamingRules(rules: CharacterRoamingRule[]): void {
    if (typeof window === "undefined") return;
    kvSet(CHARACTER_ROAMING_RULES_KEY, JSON.stringify(rules.slice(0, 100)));
    emitRulesUpdated();
}

/** 每个角色一条规则：再次创建同角色规则时自动覆盖旧规则 */
export function upsertCharacterRoamingRule(rule: CharacterRoamingRule): void {
    const normalized = normalizeRule(rule);
    if (!normalized) return;
    const rest = loadCharacterRoamingRules().filter(item => item.characterId !== normalized.characterId && item.id !== normalized.id);
    saveCharacterRoamingRules([...rest, normalized]);
}

export function toggleCharacterRoamingRule(id: string, enabled: boolean): void {
    const rules = loadCharacterRoamingRules();
    const target = rules.find(item => item.id === id);
    if (!target) return;
    target.enabled = enabled;
    if (enabled) target.consecutiveCount = 0;
    saveCharacterRoamingRules(rules);
}

export function removeCharacterRoamingRule(id: string): void {
    saveCharacterRoamingRules(loadCharacterRoamingRules().filter(item => item.id !== id));
}

export function markCharacterRoamingFired(
    id: string,
    firedAtMs: number,
    summary?: string,
    options?: { manual?: boolean },
): void {
    const rules = loadCharacterRoamingRules();
    const target = rules.find(item => item.id === id);
    if (!target) return;
    target.lastFiredAt = firedAtMs;
    if (!options?.manual) {
        target.consecutiveCount = Math.min(target.maxConsecutive, target.consecutiveCount + 1);
    }
    if (summary) target.lastSummary = summary.slice(0, 160);
    saveCharacterRoamingRules(rules);
}

/** 用户操作页面后重置所有已达/累积的挂机连发计数 */
export function resetAllCharacterRoamingCounts(): void {
    const rules = loadCharacterRoamingRules();
    let changed = false;
    for (const rule of rules) {
        if (rule.consecutiveCount > 0) {
            rule.consecutiveCount = 0;
            changed = true;
        }
    }
    if (changed) saveCharacterRoamingRules(rules);
}

// ── 角色自主调用工具产生的短期事件记录（供后续聊天短期记忆感知） ──

function roamingEventsKey(characterId: string): string {
    return `${CHARACTER_ROAMING_EVENTS_PREFIX}${characterId}`;
}

export function loadRoamingTimelineEntries(
    characterId: string,
    options?: { afterTimestamp?: string },
): RoamingTimelineEntry[] {
    if (typeof window === "undefined" || !characterId) return [];
    try {
        const raw = kvGet(roamingEventsKey(characterId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const items = parsed.filter((item): item is RoamingTimelineEntry => (
            Boolean(item)
            && typeof item.id === "string"
            && typeof item.characterId === "string"
            && typeof item.timestamp === "string"
            && typeof item.content === "string"
        ));
        const filtered = options?.afterTimestamp
            ? items.filter(item => item.timestamp > options.afterTimestamp!)
            : items;
        return filtered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch {
        return [];
    }
}

export function appendRoamingTimelineEntry(characterId: string, content: string): void {
    if (typeof window === "undefined" || !characterId || !content.trim()) return;
    const existing = loadRoamingTimelineEntries(characterId);
    const entry: RoamingTimelineEntry = {
        id: `roam_ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        characterId,
        timestamp: new Date().toISOString(),
        content: content.trim().slice(0, 600),
    };
    const next = [...existing, entry].slice(-80);
    kvSet(roamingEventsKey(characterId), JSON.stringify(next));
}
