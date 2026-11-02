// lib/backpack-markers.ts
// 原生背包 · 回复标记解析
//
// 模型在回复里写 [给予用户:物品] 这类标记，这里就地执行并把标记抹掉。
// 必须同步执行：调用点位于回复落地之前的流水线上。
//
// 归属一律是「某个角色」：谁的回复，就操作谁的背包。
// 群聊里同样成立——说话的角色只会动到自己的背包。

import {
    formatBackpackTime,
    loadBackpackItems,
    mutateBackpackItems,
    parseBackpackTime,
    resolveCharacterIdByName,
} from "./backpack-storage";
import type { BackpackItem } from "./backpack-types";

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

/** 只抹除标记，不执行任何动作（用户自己发的文本走这里，防止手写标记改背包） */
export function stripBackpackMarkers(text: string): string {
    if (!hasBackpackMarker(text)) return text;
    return trimBlank(text
        .replace(RE_GIVE, "")
        .replace(RE_GIVE_CHAR, "")
        .replace(RE_TAKE, "")
        .replace(RE_NOTE, "")
        .replace(RE_ADD, "")
        .replace(RE_EDIT, "")
        .replace(RE_DROP, ""));
}

function trimBlank(text: string): string {
    return text
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

/** 在角色自己的背包里找物品下标：先精确、再归一化、最后包含匹配 */
function findOwnItemIndex(items: BackpackItem[], characterId: string, name: string): number {
    const rawName = String(name || "").trim();
    if (!rawName || !characterId) return -1;
    const normName = normalizeItemName(rawName);
    if (!normName) return -1;
    const canContains = normName.length >= 2;

    let normHit = -1;
    let containsHit = -1;

    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.recipient !== "character" || item.characterId !== characterId) continue;
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

/**
 * 在用户背包里找物品：优先挑「这个角色知道」的那件，其次退到任意同名件。
 * 返回下标，找不到 -1。
 */
function findUserItemIndex(items: BackpackItem[], characterId: string, name: string): number {
    const normName = normalizeItemName(name);
    if (!normName) return -1;

    let visibleIdx = -1;
    let anyIdx = -1;
    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.recipient !== "user") continue;
        const norm = normalizeItemName(item.title);
        const hit = norm === normName
            || (norm.length >= 2 && normName.length >= 2 && (norm.includes(normName) || normName.includes(norm)));
        if (!hit) continue;
        if (visibleIdx < 0 && item.visibleTo.includes(characterId)) visibleIdx = i;
        if (anyIdx < 0) anyIdx = i;
    }
    return visibleIdx >= 0 ? visibleIdx : anyIdx;
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

export type BackpackMarkerResult = {
    /** 去掉标记后的文本 */
    text: string;
    /** 本轮送出给用户的物品（调用方据此在聊天里发礼物卡片） */
    givenToUser: BackpackItem[];
    /** 是否有实际改动（用于提示词缓存失效等判断） */
    changed: boolean;
};

/**
 * 执行回复里的背包标记。
 * characterId 是这条回复的说话角色——所有操作都落在他的背包上。
 */
export function applyBackpackMarkers(text: string, characterId: string): BackpackMarkerResult {
    if (!characterId || !hasBackpackMarker(text)) {
        return { text, givenToUser: [], changed: false };
    }

    let output = text;
    let mutated = false;
    const givenIds: string[] = [];

    mutateBackpackItems(items => {
        output = output.replace(RE_GIVE, (_full, nameRaw) => {
            const name = String(nameRaw || "").trim();
            if (!name) return "";
            const idx = findOwnItemIndex(items, characterId, name);
            if (idx >= 0) {
                const item = items[idx];
                items[idx] = {
                    ...item,
                    recipient: "user",
                    characterId: "",
                    visibleTo: [],
                    injected: false,
                    timestamp: Date.now(),
                };
                givenIds.push(item.id);
                mutated = true;
            }
            return "";
        });

        output = output.replace(RE_GIVE_CHAR, (_full, body) => {
            const parsed = parseGiveToCharacterBody(String(body));
            if (!parsed) return "";
            const targetCharacterId = resolveCharacterIdByName(parsed.targetName);
            if (!targetCharacterId || targetCharacterId === characterId) return "";
            const idx = findOwnItemIndex(items, characterId, parsed.itemName);
            if (idx < 0) return "";
            items[idx] = {
                ...items[idx],
                recipient: "character",
                characterId: targetCharacterId,
                visibleTo: [],
                injected: true,
                timestamp: Date.now(),
            };
            mutated = true;
            return "";
        });

        output = output.replace(RE_TAKE, (_full, nameRaw) => {
            const name = String(nameRaw || "").trim();
            if (!name) return "";
            const idx = findUserItemIndex(items, characterId, name);
            if (idx < 0) return "";
            items[idx] = {
                ...items[idx],
                recipient: "character",
                characterId,
                visibleTo: [],
                injected: true,
                timestamp: Date.now(),
            };
            mutated = true;
            return "";
        });

        output = output.replace(RE_NOTE, (_full, body) => {
            const parsed = parseNoteBody(String(body));
            if (!parsed) return "";
            const idx = findOwnItemIndex(items, characterId, parsed.name);
            if (idx >= 0) {
                items[idx] = { ...items[idx], note: parsed.content, userEdited: true };
                mutated = true;
            }
            return "";
        });

        output = output.replace(RE_ADD, (_full, body) => {
            const parsed = parseNewItemBody(String(body));
            if (!parsed) return "";
            const now = Date.now();
            items.unshift({
                id: `bp_role_${now}_${Math.random().toString(36).slice(2, 8)}`,
                title: parsed.title,
                source: parsed.source,
                value: parsed.value,
                date: parsed.date || formatBackpackTime(now),
                note: parsed.note,
                customImage: "",
                recipient: "character",
                characterId,
                injected: true,
                visibleTo: [],
                isManual: false,
                isRoleAdded: true,
                userEdited: true,
                timestamp: now,
            });
            mutated = true;
            return "";
        });

        output = output.replace(RE_EDIT, (_full, body) => {
            const parsed = parseEditItemBody(String(body));
            if (!parsed || parsed.noop) return "";
            const idx = findOwnItemIndex(items, characterId, parsed.title);
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

        output = output.replace(RE_DROP, (_full, nameRaw) => {
            const name = String(nameRaw || "").trim();
            if (!name) return "";
            const idx = findOwnItemIndex(items, characterId, name);
            if (idx >= 0) {
                items.splice(idx, 1);
                mutated = true;
            }
            return "";
        });

        return mutated ? items : undefined;
    });

    // 送出的物品此刻已经进了用户背包，取最新快照供调用方发卡片
    const givenToUser = givenIds.length > 0
        ? loadBackpackItems().filter(it => givenIds.includes(it.id) && it.recipient === "user")
        : [];

    return { text: trimBlank(output), givenToUser, changed: mutated };
}
