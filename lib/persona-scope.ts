// lib/persona-scope.ts
// 用户面具（UserIdentity）· 当前生效的面具 + 它包含哪些角色
//
// 设计要点：**不新增第二套归属数据**。
// 「某个角色属于哪个面具」这件事，本来就记在绑定系统里——
// 角色绑定的 defaults.userIdentityId（设置 → 绑定 → 角色 → 用户身份）。
// 这里只是换个方向读同一份配置：聊天时它决定「这个角色看到的是哪个我」，
// 列表面板里它决定「这个角色归在哪个面具下」。
// 所以不存在「绑定页设了 A、面具页又设了 B」这种两边打架的可能。
//
// 归属判定沿用绑定级联的语义：
//   角色单独绑了 → 用绑的；没绑 → 继承全局默认身份；全局也没设 → 列表第一个面具。
// 这正好等于 resolveUserIdentity() 实际喂给 AI 的那个身份，
// 于是「界面归在哪个面具下」与「聊天时用的是哪个我」永远一致。
//
// 兼容性：老用户只有一个面具、所有角色都走全局默认 → 任何面具下的可见集合
// 都是「全部角色」，切换前列表和以前完全一样，不会突然一片空白。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadBindingConfig, loadUserIdentities, resolveBinding } from "./settings-storage";
import { loadCharacters } from "./character-storage";
import type { UserIdentity } from "@/components/settings/user-identity";

const ACTIVE_IDENTITY_KEY = "ai_phone_active_identity_v1";
registerKvMigration(ACTIVE_IDENTITY_KEY);

/** 当前面具变了：列表、头像、名字要跟着刷新 */
export const PERSONA_SWITCHED_EVENT = "persona-switched";

/** 所有面具（身份卡片） */
export function loadIdentities(): UserIdentity[] {
    try {
        return loadUserIdentities();
    } catch {
        return [];
    }
}

/**
 * 当前生效的面具 id。
 * 没主动切换过（或切换到的面具后来被删了）时回落到绑定系统的全局默认身份，
 * 再兜底到第一个面具——和 resolveUserIdentity() 的回退顺序一致。
 */
export function resolveActiveIdentityId(): string {
    const identities = loadIdentities();
    if (identities.length === 0) return "";
    let stored = "";
    try {
        stored = String(kvGet(ACTIVE_IDENTITY_KEY) ?? "").trim();
    } catch {
        stored = "";
    }
    if (stored && identities.some(i => i.id === stored)) return stored;
    try {
        const globalId = loadBindingConfig().globalDefaults?.userIdentityId || "";
        if (globalId && identities.some(i => i.id === globalId)) return globalId;
    } catch {
        /* 绑定读不出来就继续兜底 */
    }
    return identities[0].id;
}

/** 当前面具的完整信息（头像 / 昵称从这里取） */
export function resolveActiveIdentity(): UserIdentity | null {
    const identities = loadIdentities();
    if (identities.length === 0) return null;
    const id = resolveActiveIdentityId();
    return identities.find(i => i.id === id) ?? identities[0];
}

/**
 * 切换到另一个面具。返回是否切换成功（id 不存在时不动）。
 * 这里只改「当前用哪个」，不碰任何角色绑定——归属仍然由绑定页决定。
 */
export function switchActiveIdentity(identityId: string): boolean {
    const id = String(identityId || "").trim();
    if (!id) return false;
    if (!loadIdentities().some(i => i.id === id)) return false;
    try {
        kvSet(ACTIVE_IDENTITY_KEY, id);
    } catch {
        return false;
    }
    scopeCache = null;
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(PERSONA_SWITCHED_EVENT, { detail: { identityId: id } }));
    }
    return true;
}

/** 某个角色归属的面具 id（走绑定级联，见文件头说明） */
export function resolveCharacterIdentityId(characterId: string): string {
    if (!characterId) return "";
    try {
        const resolved = resolveBinding(loadBindingConfig(), characterId, undefined);
        if (resolved.userIdentityId) return resolved.userIdentityId;
    } catch {
        /* 绑定异常时按默认面具处理 */
    }
    return resolveActiveIdentityId();
}

/**
 * 当前面具下可见的角色集合。
 *
 * 缓存一层：列表渲染会逐个角色问「可见吗」，而每次判定都要跑一遍绑定解析。
 * 绑定或面具变化时清空（见下方事件监听），所以不会读到过期结果。
 */
let scopeCache: { identityId: string; characterIds: Set<string> } | null = null;

if (typeof window !== "undefined") {
    const invalidate = () => { scopeCache = null; };
    window.addEventListener("settings-bindings-updated", invalidate);
    window.addEventListener(PERSONA_SWITCHED_EVENT, invalidate);
    // 面具被增删改名后 id 集合也会变
    window.addEventListener("settings-identities-updated", invalidate);
}

function buildScope(): { identityId: string; characterIds: Set<string> } | null {
    const identityId = resolveActiveIdentityId();
    if (!identityId) return null;
    if (scopeCache && scopeCache.identityId === identityId) return scopeCache;

    const characterIds = new Set<string>();
    let config;
    let characters: { id?: string }[] = [];
    try {
        config = loadBindingConfig();
    } catch {
        config = null;
    }
    try {
        characters = loadCharacters() as { id?: string }[];
    } catch {
        characters = [];
    }
    for (const char of characters) {
        const id = String(char?.id ?? "");
        if (!id) continue;
        let personaId = "";
        try {
            personaId = config ? (resolveBinding(config, id, undefined).userIdentityId || "") : "";
        } catch {
            personaId = "";
        }
        if (!personaId) personaId = identityId;
        if (personaId === identityId) characterIds.add(id);
    }

    scopeCache = { identityId, characterIds };
    return scopeCache;
}

/** 当前面具下是否包含这个角色 */
export function isCharacterInActivePersona(characterId: string): boolean {
    const scope = buildScope();
    // 没有任何面具时不过滤（等于「全部可见」）
    if (!scope) return true;
    return scope.characterIds.has(String(characterId || ""));
}

/** 联系人条目是否在当前面具下显示 */
export function isContactVisibleInActivePersona(contact: { characterId?: string } | null | undefined): boolean {
    if (!contact?.characterId) return false;
    return isCharacterInActivePersona(contact.characterId);
}

/**
 * 会话是否在当前面具下显示。
 * 单聊看对方角色；群聊只要有**任一**成员属于当前面具就显示
 * （群本身不属于某一个人，把群藏掉会让用户以为群丢了）。
 * 群没有成员数据时照常显示。
 */
export function isSessionVisibleInActivePersona(
    session: { isGroup?: boolean; contactId?: string; participantIds?: string[] } | null | undefined,
): boolean {
    if (!session) return false;
    const scope = buildScope();
    if (!scope) return true;
    if (session.isGroup) {
        const members = Array.isArray(session.participantIds) ? session.participantIds : [];
        if (members.length === 0) return true;
        return members.some(id => scope.characterIds.has(String(id)));
    }
    return scope.characterIds.has(String(session.contactId || ""));
}

/** 当前面具下可见的角色列表（联系人页「添加」等候选也用这个） */
export function filterCharactersForActivePersona<T extends { id?: string }>(characters: T[]): T[] {
    const scope = buildScope();
    if (!scope) return characters;
    return characters.filter(c => scope.characterIds.has(String(c?.id ?? "")));
}

/** 当前面具名字，列表空态文案用 */
export function getActivePersonaName(): string {
    return resolveActiveIdentity()?.name || "当前账号";
}
