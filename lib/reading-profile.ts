"use client";

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadReadingAsset, saveReadingAsset } from "./reading-appearance";

/** 阅读 app 自己的「账号」：和手机主人的身份无关，只是分享摘抄图片时
 *  署名用的昵称和头像。 */
export type ReadingProfile = {
    /** 昵称；空字符串表示没设置 */
    name: string;
    /** 账号 ID（不带 @）。空字符串表示没设置，界面上显示成 @user_id */
    id: string;
};

const PROFILE_KEY = "ai_phone_reading_profile_v1";
registerKvMigration(PROFILE_KEY);
const AVATAR_ASSET_KEY = "profile-avatar";

/** 没填 ID 时显示的那个占位 ID */
export const DEFAULT_READING_PROFILE_ID = "user_id";

/** 保存了阅读账号（昵称 / ID / 头像）之后广播一次。
 *  书架的菜单头像、段评里自己那条的头像都各自缓存了 objectURL，
 *  不广播的话换完头像要重进界面才看得到变化。 */
export const READING_PROFILE_CHANGED_EVENT = "reading-profile-changed";

export function notifyReadingProfileChanged(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(READING_PROFILE_CHANGED_EVENT));
}

/** 界面上显示的 ID 文本：统一带一个 @，空着就用占位 ID */
export function readingProfileIdLabel(profile: Pick<ReadingProfile, "id">): string {
    const raw = (profile.id || "").trim().replace(/^@+/, "");
    return `@${raw || DEFAULT_READING_PROFILE_ID}`;
}

export const DEFAULT_READING_PROFILE: ReadingProfile = { name: "", id: "" };

function normalizeId(value: unknown): string {
    // 老数据只有 name 字段：ID 是后加的，缺它就当没设置（显示 @user_id）
    const raw = typeof value === "string" ? value.trim().replace(/^@+/, "") : "";
    return raw.slice(0, 32);
}

export function loadReadingProfile(): ReadingProfile {
    if (typeof window === "undefined") return DEFAULT_READING_PROFILE;
    try {
        const raw = kvGet(PROFILE_KEY);
        if (!raw) return DEFAULT_READING_PROFILE;
        const parsed = JSON.parse(raw) as Partial<ReadingProfile>;
        return {
            name: typeof parsed?.name === "string" ? parsed.name.trim().slice(0, 40) : "",
            id: normalizeId(parsed?.id),
        };
    } catch {
        return DEFAULT_READING_PROFILE;
    }
}

export function saveReadingProfile(profile: ReadingProfile): ReadingProfile {
    const normalized: ReadingProfile = {
        name: profile.name.trim().slice(0, 40),
        id: normalizeId(profile.id),
    };
    if (typeof window === "undefined") return normalized;
    try {
        kvSet(PROFILE_KEY, JSON.stringify(normalized));
    } catch {
        // 写不进去就只保留本次会话的内存值，不打断用户
    }
    return normalized;
}

export async function saveReadingProfileAvatar(blob: Blob | null): Promise<void> {
    await saveReadingAsset(AVATAR_ASSET_KEY, blob);
}

export async function loadReadingProfileAvatar(): Promise<Blob | null> {
    return loadReadingAsset(AVATAR_ASSET_KEY);
}
