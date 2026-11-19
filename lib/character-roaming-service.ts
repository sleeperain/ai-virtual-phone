// lib/character-roaming-service.ts
// 角色后台自主活动调度器：不打扰私聊，按用户设定间隔让角色在群聊主动发话、
// 发/刷小红书、写手记（日记）、自主调用工具或发朋友圈。

import { bgSetInterval } from "./bg-timer";
import { sendBrowserNotification } from "./browser-notification";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import { generateChatCompletion, flattenCompletionResult } from "./chat-engine";
import {
    loadChatMessages,
    loadChatSessions,
    pushChatMessage,
    type ChatMessage,
    type ChatSession,
} from "./chat-storage";
import { generateDiaryEntryForCharacter } from "./diary-entry-engine";
import { createDiaryEntry, loadDiaryEntries } from "./diary-entry-storage";
import { DIARY_ENTRIES_UPDATED_EVENT } from "./diary-entry-timer-service";
import { isBackgroundReplyGenerating, parseAndSaveResponse } from "./follow-up-service";
import { isGroupMuted } from "./group-admin";
import { generateGroupChatCompletion } from "./group-chat-engine";
import { incrementEventCounter } from "./memory-storage";
import { maybeRunSummarization } from "./memory-summarizer";
import { triggerImmediatePost } from "./moments-engine";
import { isWithinPushQuietHours } from "./push-client";
import { getEnabledTools } from "./tool-storage";
import { resolveCharacterXiaohongshuDisplayName } from "./xiaohongshu-character-profile";
import {
    applyCharacterActivityComment,
    generateXiaohongshuCharacterActivity,
} from "./xiaohongshu-engine";
import {
    recordXiaohongshuCommentEvent,
    recordXiaohongshuPostEvent,
    recordXiaohongshuReplyEvent,
} from "./xiaohongshu-memory";
import {
    loadXiaohongshuState,
    makeXiaohongshuComment,
    makeXiaohongshuNpcId,
    saveXiaohongshuState,
} from "./xiaohongshu-storage";
import type {
    ParsedXiaohongshuCharacterActivity,
    XiaohongshuComment,
    XiaohongshuNote,
} from "./xiaohongshu-types";
import {
    appendRoamingTimelineEntry,
    getLocalDateKey,
    loadCharacterRoamingRules,
    markCharacterRoamingFired,
    resetAllCharacterRoamingCounts,
    ROAMING_ACTIVITY_LABELS,
    ROAMING_MIN_INTERVAL_MINUTES,
    type CharacterRoamingRule,
    type RoamingActivityKind,
} from "./character-roaming-storage";

const POLL_INTERVAL_MS = 30_000;
/** 前台无操作超过该时长才视为空闲挂机；正在操作页面时绝不跑后台活动 */
const IDLE_REQUIRED_MS = 3 * 60_000;
const USER_INTERACTION_THROTTLE_MS = 5_000;

let stopInterval: (() => void) | null = null;
let lastUserInteractionAt = Date.now();
const firingRuleIds = new Set<string>();

function notifyActivity(title: string, detail: string, avatar?: string): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("global-notice", { detail: `${title}：${detail}` }));
    sendBrowserNotification(title, { body: detail, icon: avatar || undefined });
}

// ── 1. 群聊主动发起话题 ──

function findEligibleGroupsForCharacter(characterId: string): ChatSession[] {
    return loadChatSessions().filter(session => (
        session.isGroup === true
        && !session.isBlacklisted
        && Array.isArray(session.participantIds)
        && session.participantIds.includes(characterId)
        && !isGroupMuted(session, characterId)
        && !isBackgroundReplyGenerating(session.id)
    ));
}

async function runGroupRoamingActivity(character: Character): Promise<string | null> {
    const groups = findEligibleGroupsForCharacter(character.id);
    if (groups.length === 0) return null;

    const session = groups[Math.floor(Math.random() * groups.length)];
    const latestMessages = loadChatMessages(session.id);
    const groupTitle = session.groupName?.trim() || "群聊";

    const triggerHint: ChatMessage = {
        id: `_roaming_group_${Date.now()}`,
        sessionId: session.id,
        role: "system",
        content: `[后台活动：现在群里很安静，请让「${character.name}」结合近期记忆、日程或日常近况在群里自然地主动开启一个话题或随口聊两句；群内其他成员也可以自然接话互动。不要提及系统提示。]`,
        status: "sent",
        createdAt: new Date().toISOString(),
    };

    window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));
    try {
        let roundReasoning: string | undefined;
        const toolNotices: string[] = [];
        const results = await generateGroupChatCompletion(
            session,
            [...latestMessages, triggerHint],
            {
                onReasoning: (t) => { roundReasoning = t; },
                onToolNotice: (notice) => {
                    if (notice.trim()) toolNotices.push(notice.trim());
                },
            },
        );

        for (const notice of toolNotices) {
            const msg = pushChatMessage({
                sessionId: session.id,
                role: "system",
                content: notice,
                mediaType: "tool_notice",
            });
            window.dispatchEvent(new CustomEvent("followup-message-saved", { detail: { sessionId: session.id, message: msg } }));
        }

        let anyVisible = false;
        let attachReasoning = Boolean(roundReasoning);
        for (const item of results) {
            if (!(session.participantIds || []).includes(item.characterId)) continue;
            if (isGroupMuted(session, item.characterId)) continue;
            const saved = await parseAndSaveResponse(
                item.responseText,
                session.id,
                0,
                undefined,
                latestMessages,
                {
                    senderCharacterId: item.characterId,
                    senderName: item.characterName,
                    reasoningText: attachReasoning ? roundReasoning : undefined,
                },
            );
            attachReasoning = false;
            if (saved.hasVisible) anyVisible = true;
        }

        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
        window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
        if (!anyVisible && toolNotices.length === 0) return null;
        return `在群聊「${groupTitle}」主动发起了话题`;
    } catch (err) {
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
        throw err;
    }
}

// ── 2. 小红书自主发帖/评论互动 ──

function isCharacterXhsAuthor(authorName: string, character: Character, displayName: string): boolean {
    const normalized = authorName.trim();
    if (!normalized) return false;
    return [displayName.trim(), character.name.trim()].filter(Boolean).includes(normalized);
}

function buildRoamingXhsCharacterPost(
    character: Character,
    activity: ParsedXiaohongshuCharacterActivity,
): XiaohongshuNote | null {
    if (!activity.post) return null;
    const now = new Date().toISOString();
    const displayName = resolveCharacterXiaohongshuDisplayName(character);
    const noteId = `xhs_char_note_${character.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const comments = activity.post.comments
        .filter(comment => comment.text)
        .map((comment, index) => {
            const parsedReplyIndex = /^.*_comment_(\d+)$/.exec(comment.replyToCommentId || "")?.[1];
            const isChar = isCharacterXhsAuthor(comment.authorName, character, displayName);
            return {
                ...makeXiaohongshuComment({
                    noteId,
                    authorType: isChar ? "character" : "npc",
                    authorId: isChar ? character.id : makeXiaohongshuNpcId(comment.authorName),
                    authorName: isChar ? displayName : comment.authorName,
                    text: comment.text,
                    replyTo: comment.replyTo,
                    replyToCommentId: parsedReplyIndex ? `${noteId}_comment_${Number(parsedReplyIndex)}` : comment.replyToCommentId,
                }),
                id: `${noteId}_comment_${index + 1}`,
            };
        });

    return {
        id: noteId,
        type: activity.post.type,
        source: "character",
        authorId: character.id,
        authorName: displayName,
        title: activity.post.title || activity.post.body.slice(0, 24) || "新的笔记",
        body: activity.post.body,
        videoDescription: activity.post.videoDescription,
        coverIcon: activity.post.coverIcon || (activity.post.type === "video" ? "▶" : "✦"),
        tone: "blush",
        tags: activity.post.tags,
        likeCount: activity.post.likeCount,
        saveCount: activity.post.saveCount,
        commentCount: activity.post.commentCount,
        liked: false,
        saved: false,
        recentLikeNames: activity.post.recentLikeNames,
        recentSaveNames: activity.post.recentSaveNames,
        comments,
        imageDescription: activity.post.type === "post" ? activity.post.imageDescription : undefined,
        createdAt: now,
        updatedAt: now,
    };
}

function recordXhsThreadEvents(
    character: Character,
    sourceNote: XiaohongshuNote,
    appliedNote: XiaohongshuNote,
    threadComments: XiaohongshuComment[],
): void {
    for (const comment of threadComments) {
        if (
            comment.authorType !== "character"
            || comment.authorId !== character.id
            || !comment.text.trim()
            || (!comment.replyToCommentId && !comment.replyTo)
        ) {
            continue;
        }
        const targetComment = comment.replyToCommentId
            ? appliedNote.comments.find(item => item.id === comment.replyToCommentId)
            : undefined;
        recordXiaohongshuReplyEvent({
            characterId: character.id,
            characterName: character.name,
            note: sourceNote,
            comment,
            targetComment,
        });
    }
}

async function runXiaohongshuRoamingActivity(character: Character): Promise<string | null> {
    const current = loadXiaohongshuState();
    const activity = await generateXiaohongshuCharacterActivity(
        character.id,
        current.notes.slice(0, 30),
        current.settings,
    );
    if (!activity) return null;

    let commentCount = 0;
    const collectedNotifications = [...current.notifications];

    const updatedNotes = current.notes.map((note) => {
        const related = activity.comments.filter(comment => comment.noteId === note.id);
        if (related.length === 0) return note;
        let nextNote = note;
        for (const parsed of related) {
            if (!parsed.text.trim()) continue;
            const result = applyCharacterActivityComment({
                note: nextNote,
                character,
                text: parsed.text,
                liked: parsed.liked,
                saved: parsed.saved,
                thread: parsed.thread,
            });
            nextNote = result.note;
            commentCount += 1;
            if (result.notifications.length > 0) {
                collectedNotifications.unshift(...result.notifications);
            }
            recordXiaohongshuCommentEvent({
                characterId: character.id,
                characterName: character.name,
                note,
                comment: result.mainComment,
                liked: parsed.liked,
                saved: parsed.saved,
            });
            recordXhsThreadEvents(character, note, result.note, result.threadComments);
        }
        return nextNote;
    });

    const characterPost = buildRoamingXhsCharacterPost(character, activity);
    if (characterPost) {
        recordXiaohongshuPostEvent({
            characterId: character.id,
            characterName: character.name,
            note: characterPost,
        });
        recordXhsThreadEvents(character, characterPost, characterPost, characterPost.comments);
    }

    if (!characterPost && commentCount === 0) return null;

    saveXiaohongshuState({
        ...current,
        notes: characterPost ? [characterPost, ...updatedNotes] : updatedNotes,
        notifications: collectedNotifications,
    });

    incrementEventCounter(character.id);
    maybeRunSummarization(character.id, character.name).catch(() => undefined);
    window.dispatchEvent(new CustomEvent("xiaohongshu-updated"));

    if (characterPost) {
        return `发布了小红书笔记《${characterPost.title.slice(0, 20)}》`;
    }
    return `在小红书逛了一圈并评论了 ${commentCount} 条笔记`;
}

// ── 3. 写日记（手记） ──

async function runDiaryRoamingActivity(character: Character): Promise<string | null> {
    const draft = await generateDiaryEntryForCharacter(character.id, loadDiaryEntries(), "timer");
    const entry = createDiaryEntry({
        characterId: character.id,
        characterName: character.name,
        title: draft.title,
        mood: draft.mood,
        weather: draft.weather,
        tags: draft.tags,
        body: draft.body,
        blocks: draft.blocks,
        trigger: "timer",
    });
    window.dispatchEvent(new CustomEvent(DIARY_ENTRIES_UPDATED_EVENT, {
        detail: { source: "roaming", createdCount: 1, failedCount: 0 },
    }));
    return `写了一篇日记《${(entry.title || "无题").slice(0, 20)}》`;
}

// ── 4. 自主调用工具（不写入私聊消息，只执行动作并记入短期时间线） ──

async function runAutonomousToolsActivity(character: Character): Promise<string | null> {
    const enabledTools = getEnabledTools("chat");
    if (enabledTools.length === 0) return null;

    const virtualSession: ChatSession = {
        id: `roaming_tool_session_${character.id}`,
        contactId: character.id,
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
        isPinned: false,
        bilingualTranslationEnabled: false,
    };

    const taskMessage: ChatMessage = {
        id: `roaming_tool_task_${Date.now()}`,
        sessionId: virtualSession.id,
        role: "user",
        content: [
            "[系统后台自主活动模式]",
            `现在${character.name}正处于独处闲暇时间，不会给用户发送私聊消息。`,
            "请查看你当前可用的工具/动作（如日程管理、便签墙、音乐、搜索/网页浏览、记忆整理、自定义 APP 工具等），结合你的性格、近期记忆与作息，自主选择执行 1 个合理有趣的动作。",
            "注意：不要使用「稍后主动联系」打扰用户；动作完成后用一句话简述你刚刚做了什么即可。",
        ].join("\n"),
        status: "sent",
        createdAt: new Date().toISOString(),
    };

    const executedNotices: string[] = [];
    const completion = await generateChatCompletion(
        virtualSession,
        [taskMessage],
        {
            // 必须使用 "chat" 作为 appId，否则 getEnabledTools("custom_app:...") 会把自定义 APP 共享工具过滤掉！
            // 通过携带 "roaming" / "followup" 标签阻止挂私聊离线推送兜底单
            appId: "chat",
            appTags: ["roaming", "autonomous_tools", "followup"],
            toolsAllowed: true,
            forceEnableTools: true,
            // 严控单次后台活动的工具循环上限为 2 轮（展开/调用 + 收尾），绝不允许连调 5~6 轮烧光额度
            maxToolRoundsOverride: 2,
            skipEmptyGenerateGuard: true,
            promptProfile: {
                id: "roaming_plain",
                label: "后台自主工具活动",
                output: "plain_text",
                appTags: ["roaming", "autonomous_tools"],
            },
        },
        {
            onToolExecution: (results) => {
                for (const r of results) {
                    if (r.success) {
                        executedNotices.push(r.userNotice || `调用了「${r.name}」`);
                    }
                }
            },
        },
    );

    const summaryText = flattenCompletionResult(completion).replace(/\s+/g, " ").trim();
    // 只有真正成功执行了至少 1 个工具才算有效成果（不把报错或空话当成功吞掉）
    if (executedNotices.length === 0) return null;

    const timelineSummary = `${character.name}在后台自主活动：${Array.from(new Set(executedNotices)).join("；")}${summaryText ? `（${summaryText.slice(0, 120)}）` : ""}`;

    appendRoamingTimelineEntry(character.id, timelineSummary);
    return `自主执行了动作（${executedNotices[0].slice(0, 32)}）`;
}

// ── 5. 发朋友圈 ──

async function runMomentsRoamingActivity(character: Character): Promise<string | null> {
    triggerImmediatePost(character.id);
    return `正在准备发一条朋友圈`;
}

// ── 统一选择与触发 ──

function filterAvailableActivities(character: Character, configured: RoamingActivityKind[]): RoamingActivityKind[] {
    return configured.filter((kind) => {
        if (kind === "group_chat") {
            return findEligibleGroupsForCharacter(character.id).length > 0;
        }
        if (kind === "tools") {
            return getEnabledTools("chat").length > 0;
        }
        return true;
    });
}

async function executeSingleActivity(character: Character, kind: RoamingActivityKind): Promise<string | null> {
    switch (kind) {
        case "group_chat":
            return runGroupRoamingActivity(character);
        case "xiaohongshu":
            return runXiaohongshuRoamingActivity(character);
        case "diary":
            return runDiaryRoamingActivity(character);
        case "tools":
            return runAutonomousToolsActivity(character);
        case "moments":
            return runMomentsRoamingActivity(character);
        default:
            return null;
    }
}

export async function runCharacterRoamingRuleNow(rule: CharacterRoamingRule, options?: { manual?: boolean }): Promise<{ ok: boolean; summary?: string; error?: string }> {
    if (firingRuleIds.has(rule.id)) {
        return { ok: false, error: "该角色正在执行后台活动中，请稍候。" };
    }
    const character = loadCharacters().find(item => item.id === rule.characterId);
    if (!character) {
        return { ok: false, error: "找不到对应角色。" };
    }

    const candidates = filterAvailableActivities(character, rule.activities);
    if (candidates.length === 0) {
        return { ok: false, error: "当前勾选的活动均不满足条件（如未加入群聊或未启用工具）。" };
    }

    // 每次触发只随机抽 1 项执行，绝不在失败/空返回时把池里剩余几项挨个调一遍 LLM 连环烧额度！
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    const pickedLabel = ROAMING_ACTIVITY_LABELS[picked] || picked;
    firingRuleIds.add(rule.id);
    // 先行落盘占位：更新 lastFiredAt / 连跑计数 / 今日计数，杜绝重入或失败风暴
    markCharacterRoamingFired(rule.id, Date.now(), `正在执行「${pickedLabel}」...`, { manual: options?.manual });

    try {
        const summary = await executeSingleActivity(character, picked);
        if (summary) {
            markCharacterRoamingFired(rule.id, Date.now(), summary, { manual: true });
            notifyActivity(character.name, summary, character.avatar);
            return { ok: true, summary };
        }
        const emptyMsg = `上次「${pickedLabel}」未解析出有效内容（已停止，不再重试其他项）`;
        markCharacterRoamingFired(rule.id, Date.now(), emptyMsg, { manual: true });
        return { ok: false, error: emptyMsg };
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[CharacterRoaming] ${character.name} activity "${picked}" failed:`, err);
        markCharacterRoamingFired(rule.id, Date.now(), `「${pickedLabel}」失败：${errMsg.slice(0, 80)}`, { manual: true });
        return { ok: false, error: errMsg };
    } finally {
        firingRuleIds.delete(rule.id);
    }
}

function isEligibleBackgroundOrIdle(now: number): boolean {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return true;
    }
    return now - lastUserInteractionAt >= IDLE_REQUIRED_MS;
}

function pollCharacterRoaming(): void {
    if (typeof window === "undefined") return;
    if (firingRuleIds.size > 0) return;
    const now = Date.now();
    if (isWithinPushQuietHours(now)) return;
    // 用户正在前台使用手机时绝不触发后台活动
    if (!isEligibleBackgroundOrIdle(now)) return;

    const todayKey = getLocalDateKey(now);
    const rules = loadCharacterRoamingRules();
    for (const rule of rules) {
        if (!rule.enabled) continue;
        if (firingRuleIds.has(rule.id)) continue;
        if (rule.consecutiveCount >= rule.maxConsecutive) continue;
        const todayUsed = rule.dailyDate === todayKey ? rule.dailyCount : 0;
        if (todayUsed >= rule.dailyCap) continue;

        const intervalMs = Math.max(ROAMING_MIN_INTERVAL_MINUTES, rule.intervalMinutes) * 60_000;
        const baseline = rule.lastFiredAt ?? rule.createdAt;
        if (now - baseline < intervalMs) continue;

        void runCharacterRoamingRuleNow(rule);
        // 每次轮询最多启动一个角色的活动，错峰防并发拥堵
        break;
    }
}

function handleUserInteraction(): void {
    const now = Date.now();
    if (now - lastUserInteractionAt < USER_INTERACTION_THROTTLE_MS) return;
    lastUserInteractionAt = now;
}

function handleVisibilityChange(): void {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
        // 只有从前台真正切入后台挂机时，才重置本轮挂机连续计数（不再每次点屏幕都清零导致无限跑）
        resetAllCharacterRoamingCounts();
    } else {
        lastUserInteractionAt = Date.now();
    }
}

export function startCharacterRoamingService(): void {
    if (typeof window === "undefined" || stopInterval) return;
    lastUserInteractionAt = Date.now();
    stopInterval = bgSetInterval(pollCharacterRoaming, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pointerdown", handleUserInteraction, { passive: true });
    window.addEventListener("keydown", handleUserInteraction, { passive: true });
}

export function stopCharacterRoamingService(): void {
    if (stopInterval) {
        stopInterval();
        stopInterval = null;
    }
    if (typeof window === "undefined") return;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pointerdown", handleUserInteraction);
    window.removeEventListener("keydown", handleUserInteraction);
}
