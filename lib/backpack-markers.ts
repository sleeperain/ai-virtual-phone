// lib/backpack-markers.ts
// 原生背包 · 回复标记解析
//
// 模型在回复里写 [给予用户:物品] [拿取:物品] 这类标记，这里就地执行并把标记抹掉。
// 必须同步执行：调用点位于回复落地之前的流水线上。

import {
    formatBackpackTime,
    isGroupSessionId,
    loadBackpackItems,
    loadBackpackTargets,
    mutateBackpackItems,
    parseBackpackTime,
} from "./backpack-storage";
import type { BackpackItem, BackpackRecipient } from "./backpack-types";

const MARKER_KEYWORDS = "(给予用户|赠送给角色|拿取|背包备注|新增物品|修改物品|丢弃)";

const RE_ANY = new RegExp(`\\[${MARKER_KEYWORDS}\\s*[:：]`);
const RE_GIVE = /\[给予用户\s*[:：][\s\S]*?\]/g;
const RE_GIVE_CHAR = /\[赠送给角色\s*[:：][\s\S]*?\]/g;
const RE_TAKE = /\[拿取\s*[:：][\s\S]*?\]/g;
const RE_NOTE = /\[背包备注\s*[:：][\s\S]*?\]/g;
const RE_ADD = /\[新增物品\s*[:：][\s\S]*?\]/g;
const RE_EDIT = /\[修改物品\s*[:：][\s\S]*?\]/g;
const RE_DROP = /\[丢弃\s*[:：][\s\S]*?\]/g;

/** 文本里是否可能出现背包标记（廉价预检，避免每段文本都跑正则替换） */
export function hasBackpackMarker(text: string): boolean {
    return typeof text === "string" && RE_ANY.test(text);
}

/** 只抹除标记，不执行任何动作（用户自己发的文本走这里，防止用户伪造标记改背包） */
export function stripBackpackMarkers(text: string): string {
    if (!hasBackpackMarker(text)) return text;
    return text
        .replace(RE_GIVE, "")
        .replace(RE_GIVE_CHAR, "")
        .replace(RE_TAKE, "")
        .replace(RE_NOTE, "")
        .replace(RE_ADD, "")
        .replace(RE_EDIT, "")
        .replace(RE_DROP, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ── 名称匹配 ───────────────────────────────────────────────

function normalizeItemName(value: string): string {
    return String(value || "")
        .trim()
        .replace(/^[\s【\[「『（(]+/g, "")
        .replace(/[\s】\]」』）)]+$/g, "")
        .replace(/\s+/g, "")
        .toLowerCase();
}

function normalizeTargetName(value: string): string {
    return String(value || "")
        .trim()
        .replace(/[【】\[\]「」『』（）()《》\s]/g, "")
        .replace(/的背包$/, "")
        .replace(/的礼物堆$/, "")
        .toLowerCase();
}

/** 在指定归属下找物品下标：先精确、再归一化、最后包含匹配 */
function findItemIndex(
    items: BackpackItem[],
    sessionId: string,
    name: string,
    recipient: BackpackRecipient,
): number {
    const rawName = String(name || "").trim();
    if (!rawName || !sessionId) return -1;
    const normName = normalizeItemName(rawName);
    if (!normName) return -1;
    const canContains = normName.length >= 2;

    let normHit = -1;
    let containsHit = -1;

    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.sessionId !== sessionId) continue;
        if (item.recipient !== recipient) continue;
        if (item.title === rawName) return i;
        const norm = normalizeItemName(item.title);
        if (normHit < 0 && norm === normName) normHit = i;
        if (
            canContains
            && containsHit < 0
            && norm.length >= 2
            && (norm.includes(normName) || normName.includes(norm))
        ) {
            containsHit = i;
        }
    }
    if (normHit >= 0) return normHit;
    return containsHit;
}

// ── 标记体解析 ─────────────────────────────────────────────

function parseNewItemBody(body: string): { title: string; source: string; value: string; date: string; note: string } | null {
    const parts = String(body || "").split(/[;；]/).map(x => x.trim());
    if (parts.length < 5) return null;
    const title = parts[0] || "";
    if (!title) return null;
    return {
        title,
        source: parts[1] || "未标注",
        value: parts[2] || "--",
        date: parts[3] || "",
        note: parts.slice(4).join(";").trim(),
    };
}

function parseEditItemBody(body: string): { title: string; source: string; value: string; date: string; note: string; noop: boolean } | null {
    const parts = String(body || "").split(/[;；]/).map(x => x.trim());
    const title = parts[0] || "";
    if (!title) return null;
    if (parts.length === 1) {
        return { title, source: "", value: "", date: "", note: "", noop: true };
    }
    return {
        title,
        source: parts.length > 1 ? parts[1] : "",
        value: parts.length > 2 ? parts[2] : "",
        date: parts.length > 3 ? parts[3] : "",
        note: parts.length > 4 ? parts.slice(4).join(";").trim() : "",
        noop: false,
    };
}

function parseNoteBody(body: string): { name: string; content: string } | null {
    const raw = String(body || "").trim();
    if (!raw) return null;
    const byEquals = raw.match(/^([\s\S]*?)\s*[=＝]\s*([\s\S]*)$/);
    if (byEquals) {
        const name = byEquals[1].trim();
        if (name) return { name, content: byEquals[2].trim() };
    }
    const byColon = raw.match(/^([^:：]*?)\s*[:：]\s*([\s\S]*)$/);
    if (byColon) {
        const name = byColon[1].trim();
        if (name) return { name, content: byColon[2].trim() };
    }
    return null;
}

function parseGiveToCharacterBody(body: string): { targetName: string; itemName: string } | null {
    const raw = String(body || "").trim();
    if (!raw) return null;
    const sepIdx = raw.search(/[;；]/);
    if (sepIdx >= 0) {
        const targetName = raw.slice(0, sepIdx).trim();
        const itemName = raw.slice(sepIdx + 1).trim();
        return targetName && itemName ? { targetName, itemName } : null;
    }
    const m = raw.match(/^([^=＝:：]+)\s*[=＝:：]\s*([\s\S]+)$/);
    if (m) {
        const targetName = m[1].trim();
        const itemName = m[2].trim();
        return targetName && itemName ? { targetName, itemName } : null;
    }
    return null;
}

// ── 执行 ───────────────────────────────────────────────────

/**
 * 执行回复里的背包标记，返回去掉标记后的文本。
 * 无标记时原样返回，不做任何写操作。
 */
export function applyBackpackMarkers(text: string, sessionId: string): string {
    if (!sessionId || !hasBackpackMarker(text)) return text;

    const inGroup = isGroupSessionId(sessionId);
    const targets = loadBackpackTargets();

    let output = text;
    let mutated = false;

    mutateBackpackItems(items => {
        output = output.replace(/\[给予用户\s*[:：]\s*([\s\S]*?)\s*\]/g, (_full, nameRaw) => {
            const name = String(nameRaw || "").trim();
            if (!name) return "";
            const idx = findItemIndex(items, sessionId, name, "character");
            if (idx >= 0) {
                items[idx] = {
                    ...items[idx],
                    recipient: "user",
                    sessionId: "",
                    visibleTo: [],
                    injected: false,
                    timestamp: Date.now(),
                };
                mutated = true;
            }
            return "";
        });

        output = output.replace(/\[赠送给角色\s*[:：]\s*([\s\S]*?)\s*\]/g, (_full, body) => {
            const parsed = parseGiveToCharacterBody(String(body));
            if (!parsed) return "";
            const normTarget = normalizeTargetName(parsed.targetName);
            const target = targets.find(t =>
                !t.isUser && !t.isGroup && t.id !== sessionId && normalizeTargetName(t.rawName) === normTarget);
            if (!target) return "";
            const idx = findItemIndex(items, sessionId, parsed.itemName, "character");
            if (idx < 0) return "";
            items[idx] = {
                ...items[idx],
                recipient: "character",
                sessionId: target.id,
                visibleTo: [],
                timestamp: Date.now(),
            };
            mutated = true;
            return "";
        });

        output = output.replace(/\[拿取\s*[:：]\s*([\s\S]*?)\s*\]/g, (_full, nameRaw) => {
            const name = String(nameRaw || "").trim();
            if (!name) return "";
            // 群聊里先看群礼物堆，再退回用户背包
            if (inGroup) {
                const gIdx = findItemIndex(items, sessionId, name, "group");
                if (gIdx >= 0) {
                    const next = { ...items[gIdx] };
                    next.recipient = "character";
                    next.visibleTo = [];
                    next.injected = true;
                    next.timestamp = Date.now();
                    delete next.giver;
                    delete next.giverRole;
                    items[gIdx] = next;
                    mutated = true;
                    return "";
                }
            }
            // 用户背包物品：找到后再定位它原本挂在哪个会话下
            const uIdx = items.findIndex(it => it.recipient === "user" && it.visibleTo.includes(sessionId)
                && normalizeItemName(it.title) === normalizeItemName(name));
            const fallbackIdx = uIdx >= 0 ? uIdx : items.findIndex(it => it.recipient === "user"
                && normalizeItemName(it.title) === normalizeItemName(name));
            if (fallbackIdx >= 0) {
                items[fallbackIdx] = {
                    ...items[fallbackIdx],
                    recipient: "character",
                    sessionId,
                    visibleTo: [],
                    injected: true,
                    timestamp: Date.now(),
                };
                mutated = true;
            }
            return "";
        });

        output = output.replace(/\[背包备注\s*[:：]\s*([\s\S]*?)\s*\]/g, (_full, body) => {
            const parsed = parseNoteBody(String(body));
            if (!parsed) return "";
            const idx = findItemIndex(items, sessionId, parsed.name, "character");
            if (idx >= 0) {
                items[idx] = { ...items[idx], note: parsed.content, userEdited: true };
                mutated = true;
            }
            return "";
        });

        output = output.replace(/\[新增物品\s*[:：]\s*([\s\S]*?)\s*\]/g, (_full, body) => {
            const parsed = parseNewItemBody(String(body));
            if (!parsed) return "";
            const now = Date.now();
            const item: BackpackItem = {
                id: `bp_role_${now}_${Math.random().toString(36).slice(2, 8)}`,
                title: parsed.title,
                source: parsed.source,
                value: parsed.value,
                date: parsed.date || formatBackpackTime(now),
                note: parsed.note,
                customImage: "",
                recipient: inGroup ? "group" : "character",
                sessionId,
                injected: !inGroup,
                visibleTo: [],
                isManual: false,
                isRoleAdded: true,
                userEdited: true,
                timestamp: now,
            };
            if (inGroup) {
                item.giver = "群友";
                item.giverRole = "assistant";
            }
            items.unshift(item);
            mutated = true;
            return "";
        });

        output = output.replace(/\[修改物品\s*[:：]\s*([\s\S]*?)\s*\]/g, (_full, body) => {
            const parsed = parseEditItemBody(String(body));
            if (!parsed || parsed.noop) return "";
            const idx = findItemIndex(items, sessionId, parsed.title, "character");
            if (idx >= 0) {
                const next = { ...items[idx] };
                if (parsed.source) next.source = parsed.source;
                if (parsed.value) next.value = parsed.value;
                if (parsed.date) {
                    next.date = parsed.date;
                    const ts = parseBackpackTime(parsed.date);
                    if (ts) next.timestamp = ts;
                }
                if (parsed.note) next.note = parsed.note;
                next.userEdited = true;
                items[idx] = next;
                mutated = true;
            }
            return "";
        });

        output = output.replace(/\[丢弃\s*[:：]\s*([\s\S]*?)\s*\]/g, (_full, nameRaw) => {
            const name = String(nameRaw || "").trim();
            if (!name) return "";
            const idx = findItemIndex(items, sessionId, name, "character");
            if (idx >= 0) {
                items.splice(idx, 1);
                mutated = true;
            }
            return "";
        });

        return mutated ? items : undefined;
    });

    return output
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** 把「把物品送给某个角色」这件事翻出来，用于 UI 发送卡片 */
export function consumeGiveAwayRequests(text: string, sessionId: string): { text: string; delivered: BackpackItem[] } {
    if (!sessionId || !hasBackpackMarker(text)) return { text, delivered: [] };
    const delivered: BackpackItem[] = [];
    const before = new Map(loadBackpackItems().map(it => [it.id, `${it.recipient}:${it.sessionId}`]));

    const output = applyBackpackMarkers(text, sessionId);

    for (const item of loadBackpackItems()) {
        const prev = before.get(item.id);
        if (!prev) continue;
        if (item.recipient === "user" && prev !== "user:") delivered.push(item);
    }
    return { text: output, delivered };
}
