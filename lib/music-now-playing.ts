// lib/music-now-playing.ts
// 「此刻在听什么 / 是否在一起听」→ 提示词上下文。
//
// 背景：音乐播放是纯客户端状态——music-control-bridge 里持有实时快照（含 currentTrack.lyrics），
// 一起听会话落在 kv 里。聊天侧原先只有「曲库清单」三个宏（musicLocal / musicCloud /
// musicOnlineHint），模型因此不知道用户此刻在听哪首、唱到哪一句、有没有在跟它一起听。
//
// 本模块把这些实时状态压成一小段纯文本：
//   1) 曲目：歌名 / 歌手 / 专辑 / 进度 / 播放或暂停；
//   2) 歌词窗口：当前句 + 前后各 2 句（共 5 句），依赖 LRC 时间轴定位；
//   3) 一起听：会话绑定的就是当前角色时，补一句「正在一起听，已累计 N 分钟」。
//
// 注意能力边界：这里没有音频信号分析（音高、节拍、配器、唱/说/呼吸分段都拿不到），
// 全部线索只来自文本 + 时间戳。LRC 里「一句多长、句间空多久」是最接近节奏的信息，已在
// 注释里说明取用方式，但不做推算（那需要逐句毫秒级对齐，LRC 精度不足）。

import { getMusicControlBridge } from "./music-control-bridge";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

/** 一起听会话：跟谁在听（会话 id + 联系人 id），由播放页写入 */
export const LISTEN_TOGETHER_SESSION_KEY = "ai_phone_music_listen_together_session_v1";
/** 一起听累计时长（按联系人分开存）：前缀 + contactId → 秒数（字符串） */
export const LISTEN_TOGETHER_STATS_PREFIX = "ai_phone_music_listen_together_secs_";
/** 注入策略：together=只在一起听时自动注入；always=只要在放歌就注入；off=不自动注入 */
export const MUSIC_PROMPT_INJECT_KEY = "ai_phone_music_prompt_inject_v1";
/** 歌词窗口半径（1~4）：半径 2 = 当前句 + 前后各 2 句 = 5 句 */
export const MUSIC_LYRIC_PAD_KEY = "ai_phone_music_lyric_pad_v1";

/** 歌词窗口前后各取几句（默认 2 → 共 5 句） */
export const DEFAULT_LYRIC_PAD = 2;

export type MusicPromptInjectMode = "together" | "always" | "off";

export type ListenTogetherSession = {
    sessionId: string;
    contactId: string;
};

export type TimedLyricLine = { time: number; text: string };

export type MusicPromptContext = {
    /** 一起听会话命中了当前角色 */
    together: boolean;
    /** {{musicNowPlaying}} 的解析值（曲目 + 进度 + 一起听），无曲目时为空串 */
    nowPlaying: string;
    /** {{musicLyricsWindow}} 的解析值，无时间轴歌词时为空串 */
    lyricsWindow: string;
    /** 自动注入用的完整文本块；按注入策略判定为不注入时为空串 */
    block: string;
};

export const EMPTY_MUSIC_PROMPT_CONTEXT: MusicPromptContext = {
    together: false,
    nowPlaying: "",
    lyricsWindow: "",
    block: "",
};

registerKvMigration(MUSIC_PROMPT_INJECT_KEY);
registerKvMigration(MUSIC_LYRIC_PAD_KEY);

export function loadMusicPromptInjectMode(): MusicPromptInjectMode {
    if (typeof window === "undefined") return "together";
    const raw = kvGet(MUSIC_PROMPT_INJECT_KEY) || "";
    return raw === "always" || raw === "off" ? raw : "together";
}

export function saveMusicPromptInjectMode(mode: MusicPromptInjectMode): void {
    if (typeof window === "undefined") return;
    try { kvSet(MUSIC_PROMPT_INJECT_KEY, mode); } catch { /* ignore */ }
}

export function loadMusicLyricPad(): number {
    if (typeof window === "undefined") return DEFAULT_LYRIC_PAD;
    const raw = parseInt(kvGet(MUSIC_LYRIC_PAD_KEY) || "", 10);
    if (!Number.isFinite(raw)) return DEFAULT_LYRIC_PAD;
    return Math.max(1, Math.min(4, raw));
}

export function saveMusicLyricPad(pad: number): void {
    if (typeof window === "undefined") return;
    const clamped = Math.max(1, Math.min(4, Math.round(pad)));
    try { kvSet(MUSIC_LYRIC_PAD_KEY, String(clamped)); } catch { /* ignore */ }
}

/** 读取一起听会话（只在播放页点过「邀请好友一起听」后才存在） */
export function readListenTogetherSession(): ListenTogetherSession | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = kvGet(LISTEN_TOGETHER_SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { sessionId?: string; contactId?: string };
        if (!parsed || typeof parsed !== "object") return null;
        const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
        const contactId = typeof parsed.contactId === "string" ? parsed.contactId : "";
        if (!sessionId && !contactId) return null;
        return { sessionId, contactId };
    } catch {
        return null;
    }
}

/** 一起听累计秒数（按联系人或会话 id 取） */
export function readListenTogetherSeconds(keyId: string): number {
    if (typeof window === "undefined" || !keyId) return 0;
    const raw = Number(kvGet(LISTEN_TOGETHER_STATS_PREFIX + keyId) || "0");
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * 解析 LRC：一行可以带多个时间戳（[00:12.00][01:20.00]歌词），全部展开成独立行。
 * 无时间戳的纯文本歌词返回空数组——没有时间轴就定位不到「正在唱哪句」，
 * 硬塞前五行只会误导模型。
 */
export function parseLrc(lyrics: string | undefined | null): TimedLyricLine[] {
    if (!lyrics) return [];
    const timeTagRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const out: TimedLyricLine[] = [];
    for (const rawLine of lyrics.split(/\r?\n/)) {
        const times: number[] = [];
        timeTagRe.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = timeTagRe.exec(rawLine))) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const fracDigits = match[3] ?? "";
            const frac = fracDigits ? parseInt(fracDigits, 10) / Math.pow(10, fracDigits.length) : 0;
            times.push(minutes * 60 + seconds + frac);
        }
        if (times.length === 0) continue;
        const text = rawLine.replace(timeTagRe, "").replace(/\[[^\]]*\]/g, "").trim();
        for (const time of times) out.push({ time, text });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

/** 当前时间对应的歌词行下标；早于第一句时返回 -1。0.3s 容差避免卡在句间空档。 */
export function findActiveLyricIndex(lines: TimedLyricLine[], currentTime: number): number {
    if (lines.length === 0) return -1;
    const t = currentTime + 0.3;
    let idx = -1;
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].time <= t) idx = i;
        else break;
    }
    return idx;
}

/** 秒 → m:ss */
export function formatMusicClock(totalSeconds: number): string {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0:00";
    const secs = Math.floor(totalSeconds);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

/** 一起听时长文案：不满一分钟写「小于1分钟」（与播放页一致，避免逐秒跳动） */
export function formatTogetherDuration(totalSeconds: number): string {
    const secs = Math.max(0, Math.floor(totalSeconds));
    if (secs < 60) return "小于1分钟";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}小时${m}分钟` : `${m}分钟`;
}

/**
 * 歌词窗口：当前句 + 前后各 pad 句，当前句用「▶」标记。
 * pad 默认 2（共 5 句）；靠近开头/结尾时窗口自然裁短，不补空行。
 */
export function buildLyricsWindow(
    lines: TimedLyricLine[],
    currentTime: number,
    pad: number = DEFAULT_LYRIC_PAD,
): string {
    if (lines.length === 0) return "";
    const idx = findActiveLyricIndex(lines, currentTime);
    if (idx < 0) return "";
    const from = Math.max(0, idx - pad);
    const to = Math.min(lines.length - 1, idx + pad);
    const out: string[] = [];
    for (let i = from; i <= to; i += 1) {
        const text = lines[i].text;
        if (!text) continue;
        out.push(i === idx ? `▶ ${text}` : text);
    }
    return out.join("\n");
}

/**
 * 生成注入上下文。
 * @param contactId 当前聊天的角色 id（一起听会话按它匹配）
 * @param sessionId 当前会话 id（一起听也可能只记了会话 id）
 * @param userName  用户在该角色视角下的称呼，用于「xx 正在和你一起听」这类措辞
 * @param mode      注入策略，缺省读本地设置
 * @param pad       歌词窗口半径
 */
export function buildMusicPromptContext(params: {
    contactId?: string;
    sessionId?: string;
    userName?: string;
    mode?: MusicPromptInjectMode;
    pad?: number;
} = {}): MusicPromptContext {
    if (typeof window === "undefined") return EMPTY_MUSIC_PROMPT_CONTEXT;

    const mode = params.mode ?? loadMusicPromptInjectMode();
    if (mode === "off") return EMPTY_MUSIC_PROMPT_CONTEXT;

    const bridge = getMusicControlBridge();
    const snapshot = bridge?.getState() ?? null;
    const track = snapshot?.currentTrack ?? null;

    const listenSession = readListenTogetherSession();
    // 一起听会话是否就是「当前这段聊天」：优先按角色 id 比，其次按会话 id 比。
    // 两者都没提供（例如预览调试）时不认作一起听，避免把别人的会话算到当前角色头上。
    const together = Boolean(listenSession) && Boolean(
        (params.contactId && listenSession!.contactId === params.contactId)
        || (params.sessionId && listenSession!.sessionId === params.sessionId),
    );
    const togetherKeyId = params.contactId || listenSession?.contactId || listenSession?.sessionId || "";

    if (!track) return EMPTY_MUSIC_PROMPT_CONTEXT;
    if (mode === "together" && !together) return EMPTY_MUSIC_PROMPT_CONTEXT;

    const title = (track.title || "").trim() || "未知曲目";
    const artist = (track.artist || "").trim();
    const album = (track.album || "").trim();
    const elapsed = snapshot?.currentTime ?? 0;
    const duration = snapshot?.duration || track.duration || 0;
    const playing = snapshot?.isPlaying === true;

    const headline = `《${title}》${artist ? ` — ${artist}` : ""}${album ? `（专辑《${album}》）` : ""}`;
    const progress = duration > 0
        ? `${formatMusicClock(elapsed)} / ${formatMusicClock(duration)}`
        : formatMusicClock(elapsed);
    const playback = playing ? "播放中" : "已暂停";

    const togetherSeconds = togetherKeyId ? readListenTogetherSeconds(togetherKeyId) : 0;
    const togetherLine = together
        ? `${params.userName?.trim() || "用户"}正在和你一起听，已累计 ${formatTogetherDuration(togetherSeconds)}`
        : "";

    const lyricLines = parseLrc(track.lyrics);
    const pad = params.pad ?? loadMusicLyricPad();
    const lyricsWindow = buildLyricsWindow(lyricLines, elapsed, pad);
    const activeIdx = findActiveLyricIndex(lyricLines, elapsed);
    const activeLyric = activeIdx >= 0 ? lyricLines[activeIdx].text : "";

    // ── 宏用短文本 ──
    const nowPlaying = [headline, `${progress}｜${playback}`, togetherLine].filter(Boolean).join("\n");

    // ── 自动注入块 ──
    const lines: string[] = [];
    lines.push(together ? "### 此刻的音乐（系统实时状态·一起听）" : "### 此刻的音乐（系统实时状态）");
    lines.push(`- 正在播放：${headline}`);
    lines.push(`- 播放进度：${progress}｜${playback}`);
    if (togetherLine) lines.push(`- 一起听：${togetherLine}`);
    if (activeLyric) lines.push(`- 正在唱的一句：「${activeLyric}」`);
    if (lyricsWindow) {
        lines.push(`- 歌词窗口（▶ 为此刻正在唱的一句，前后各 ${pad} 句）：`);
        lines.push(lyricsWindow);
    } else {
        lines.push("- 歌词：这首歌没有可定位的时间轴歌词");
    }
    lines.push("以上是系统如实记录的播放状态，不是用户说的话。你可以自然地把歌名、歌词或情绪带进对话（比如顺着这一句的意思接话、问问用户在想什么），但不要逐字复述这些字段名、时间戳或括号说明。");

    return {
        together,
        nowPlaying,
        lyricsWindow: lyricsWindow || activeLyric,
        block: lines.join("\n"),
    };
}
