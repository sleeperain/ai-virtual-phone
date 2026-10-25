// components/music/music-player.tsx — Full-screen immersive music player
// Two visual states: cover (ambient flowing background) and glow lyrics.
// A vinyl mode is kept as a switchable style for nostalgia.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMusicPlayer, type PlayMode } from "@/lib/music-context";
import { scrollElementWithinContainer } from "@/lib/dom-scroll";
import { kvGet, kvSet } from "@/lib/kv-db";
import { extractCoverPalette, DEFAULT_COVER_PALETTE, type CoverPalette } from "@/lib/cover-color";
import {
    getUserPlaylists, addTracksToPlaylist, removeTracksFromPlaylist, getNeteasePlayInfo,
    isNeteaseConfigured, recordTrackPlaylist, removeTrackPlaylistRecord, getTrackPlaylistId,
    getSongCommentPage, getNeteaseSongDetail, getNeteaseLyrics,
    type NeteasePlaylist,
} from "@/lib/music-service";
import MusicCommentsPage from "./music-comments";
import MusicArtistPage from "./music-artist";
import { loadMusicBg, playerBgStyle, MUSIC_BG_EVENT, type MusicBgConfig } from "@/lib/music-bg";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatSessions } from "@/lib/chat-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";

type ListenTogetherSession = {
    sessionId: string;
    contactId: string;
    charName: string;
    charAvatar: string | null;
    userAvatar: string | null;
    userName: string;
};

const LISTEN_TOGETHER_SESSION_KEY = "ai_phone_music_listen_together_session_v1";
const LISTEN_TOGETHER_STATS_PREFIX = "ai_phone_music_listen_together_secs_";

function formatListenDuration(totalSeconds: number): string {
    const secs = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}小时${m}分钟`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
}

const PLAY_MODE_ICONS: Record<PlayMode, { svg: string; label: string }> = {
    sequence: {
        svg: `<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
        label: "顺序播放",
    },
    shuffle: {
        svg: `<path d="M18 4l3 3-3 3M18 14l3 3-3 3M3 7h3a5 5 0 0 1 5 5 5 5 0 0 0 5 5h5M21 7h-5a5 5 0 0 0-3.16 1.13M3 17h3a5 5 0 0 0 3.16-1.13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
        label: "随机播放",
    },
    "repeat-one": {
        svg: `<path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><text x="12" y="15" text-anchor="middle" fill="currentColor" font-size="8" font-weight="bold">1</text>`,
        label: "单曲循环",
    },
};

const WAVE_BAR_COUNT = 44;

/** Deterministic waveform heights per track so the bar shape is stable. */
function waveHeights(seedText: string): number[] {
    let seed = 0;
    for (let i = 0; i < seedText.length; i++) seed = (seed * 31 + seedText.charCodeAt(i)) % 100000;
    const heights: number[] = [];
    for (let i = 0; i < WAVE_BAR_COUNT; i++) {
        const v = Math.abs(Math.sin(seed * 0.37 + i * 0.9) * 0.6 + Math.sin(seed * 0.11 + i * 2.3) * 0.4);
        heights.push(6 + Math.round(v * 16));
    }
    return heights;
}

function formatCount(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "";
    if (value >= 100000000) return `${Math.round(value / 10000000) / 10}亿`;
    if (value >= 10000) return `${Math.round(value / 1000) / 10}万`;
    return String(value);
}

type PlayerStyle = "modern" | "vinyl";
type BodyView = "cover" | "lyrics";

export default function MusicPlayer() {
    const player = useMusicPlayer();
    const progressRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragTime, setDragTime] = useState(0);
    const [view, setView] = useState<BodyView>("cover");
    const [playerStyle, setPlayerStyle] = useState<PlayerStyle>(() =>
        (typeof window !== "undefined" && kvGet("music-player-style") === "vinyl") ? "vinyl" : "modern");
    const [showQueue, setShowQueue] = useState(false);
    const [showComments, setShowComments] = useState(false);
    const [artistView, setArtistView] = useState<{ id: number; name: string } | null>(null);
    const [palette, setPalette] = useState<CoverPalette>(DEFAULT_COVER_PALETTE);
    const [bgCfg, setBgCfg] = useState<MusicBgConfig>(() => loadMusicBg());
    const [commentTotal, setCommentTotal] = useState(0);

    useEffect(() => {
        const handleBgChange = () => setBgCfg(loadMusicBg());
        window.addEventListener(MUSIC_BG_EVENT, handleBgChange);
        return () => window.removeEventListener(MUSIC_BG_EVENT, handleBgChange);
    }, []);

    // kv cache hydrates asynchronously from IndexedDB — the initial read above
    // may run before it's ready, silently dropping the saved vinyl preference
    // and custom background. Re-read a few times until hydration has settled.
    useEffect(() => {
        const timers = [300, 1200, 3000].map(ms => setTimeout(() => {
            const stored = kvGet("music-player-style");
            if (stored === "vinyl" || stored === "modern") {
                setPlayerStyle(prev => (prev === stored ? prev : stored));
            }
            setBgCfg(prev => {
                const fresh = loadMusicBg();
                return JSON.stringify(prev) === JSON.stringify(fresh) ? prev : fresh;
            });
        }, ms));
        return () => timers.forEach(clearTimeout);
    }, []);
    const [musicToast, setMusicToast] = useState<string | null>(null);
    const [pendingPlayTrackId, setPendingPlayTrackId] = useState<string | null>(null);
    const musicToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const musicLoadingFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const currentTime = isDragging ? dragTime : player.currentTime;
    const progress = player.duration > 0 ? currentTime / player.duration : 0;

    const formatTime = (s: number) => {
        if (!s || !isFinite(s)) return "0:00";
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, "0")}`;
    };

    const clearMusicToast = useCallback(() => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
        musicToastTimerRef.current = null;
        musicLoadingFallbackRef.current = null;
        setMusicToast(null);
        setPendingPlayTrackId(null);
    }, []);

    const showMusicToast = useCallback((text: string, duration = 2000) => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
        musicToastTimerRef.current = null;
        musicLoadingFallbackRef.current = null;
        setPendingPlayTrackId(null);
        setMusicToast(text);
        if (duration > 0) {
            musicToastTimerRef.current = setTimeout(() => {
                setMusicToast(null);
                musicToastTimerRef.current = null;
            }, duration);
        }
    }, []);

    const beginMusicLoadingToast = useCallback((trackId: string) => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
        musicToastTimerRef.current = null;
        setPendingPlayTrackId(trackId);
        setMusicToast("加载音乐中...");
        musicLoadingFallbackRef.current = setTimeout(() => {
            setMusicToast(null);
            setPendingPlayTrackId(null);
            musicLoadingFallbackRef.current = null;
        }, 8000);
    }, []);

    useEffect(() => {
        if (!pendingPlayTrackId || player.currentTrack?.id !== pendingPlayTrackId) return;
        clearMusicToast();
    }, [clearMusicToast, pendingPlayTrackId, player.currentTrack?.id]);

    useEffect(() => () => {
        if (musicToastTimerRef.current) clearTimeout(musicToastTimerRef.current);
        if (musicLoadingFallbackRef.current) clearTimeout(musicLoadingFallbackRef.current);
    }, []);

    // ── Ambient palette from cover art ──
    const coverUrl = player.currentTrack?.coverUrl;
    useEffect(() => {
        let cancelled = false;
        extractCoverPalette(coverUrl).then(p => { if (!cancelled) setPalette(p); });
        return () => { cancelled = true; };
    }, [coverUrl]);

    // ── Comment count for current track ──
    const isNeteaseTrack = player.currentTrack?.id?.startsWith("netease_") ?? false;
    const neteaseId = isNeteaseTrack ? parseInt(player.currentTrack!.id.replace("netease_", ""), 10) : 0;

    useEffect(() => {
        setCommentTotal(0);
        setShowComments(false);
        setArtistView(null);
        if (!neteaseId || !isNeteaseConfigured()) return;
        let cancelled = false;
        getSongCommentPage(neteaseId, 0, 1).then(page => {
            if (!cancelled) setCommentTotal(page.total);
        });
        return () => { cancelled = true; };
    }, [neteaseId]);

    const getTimeFromEvent = useCallback((clientX: number) => {
        const bar = progressRef.current;
        if (!bar || !player.duration) return 0;
        const rect = bar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return ratio * player.duration;
    }, [player.duration]);

    const handleProgressDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const time = getTimeFromEvent(e.clientX);
        setDragTime(time);
        setIsDragging(true);
    }, [getTimeFromEvent]);

    const handleProgressMove = useCallback((e: React.PointerEvent) => {
        if (!isDragging) return;
        setDragTime(getTimeFromEvent(e.clientX));
    }, [isDragging, getTimeFromEvent]);

    const handleProgressUp = useCallback((e: React.PointerEvent) => {
        if (!isDragging) return;
        const time = getTimeFromEvent(e.clientX);
        setDragTime(time);
        player.seek(time);
        setIsDragging(false);
    }, [isDragging, getTimeFromEvent, player]);

    const cyclePlayMode = useCallback(() => {
        const modes: PlayMode[] = ["sequence", "shuffle", "repeat-one"];
        const idx = modes.indexOf(player.playMode);
        player.setPlayMode(modes[(idx + 1) % modes.length]);
    }, [player]);

    const togglePlayerStyle = useCallback(() => {
        setPlayerStyle(prev => {
            const next: PlayerStyle = prev === "modern" ? "vinyl" : "modern";
            try { kvSet("music-player-style", next); } catch { /* ignore */ }
            showMusicToast(next === "vinyl" ? "已切换为黑胶唱片样式" : "已切换为现代封面样式");
            return next;
        });
    }, [showMusicToast]);

    // ── Parse LRC lyrics ──
    const parsedLyrics = useRef<{ time: number; text: string }[]>([]);
    const [activeLyricIdx, setActiveLyricIdx] = useState(-1);
    const lyricsContainerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const lrc = player.currentTrack?.lyrics || "";
        if (!lrc) {
            parsedLyrics.current = [];
            return;
        }
        const lines: { time: number; text: string }[] = [];
        for (const line of lrc.split("\n")) {
            const match = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
            if (match) {
                const mins = parseInt(match[1], 10);
                const secs = parseFloat(match[2]);
                lines.push({ time: mins * 60 + secs, text: match[3].trim() });
            }
        }
        lines.sort((a, b) => a.time - b.time);
        parsedLyrics.current = lines;
    }, [player.currentTrack?.lyrics]);

    useEffect(() => {
        const lyrics = parsedLyrics.current;
        if (lyrics.length === 0) { setActiveLyricIdx(-1); return; }
        let idx = -1;
        for (let i = lyrics.length - 1; i >= 0; i--) {
            if (player.currentTime >= lyrics[i].time) {
                idx = i;
                break;
            }
        }
        setActiveLyricIdx(idx);
    }, [player.currentTime]);

    // Auto-scroll lyrics
    useEffect(() => {
        if (view !== "lyrics" || activeLyricIdx < 0 || !lyricsContainerRef.current) return;
        const el = lyricsContainerRef.current.children[activeLyricIdx] as HTMLElement;
        if (el) scrollElementWithinContainer(lyricsContainerRef.current, el, { behavior: "smooth", block: "center" });
    }, [activeLyricIdx, view]);

    const handleLyricClick = useCallback((idx: number, e: React.MouseEvent) => {
        e.stopPropagation();
        const line = parsedLyrics.current[idx];
        if (line) player.seek(line.time);
    }, [player]);

    const [liked, setLiked] = useState(false);
    const [showPlaylistPicker, setShowPlaylistPicker] = useState(false);
    const [playlists, setPlaylists] = useState<NeteasePlaylist[]>([]);
    const [loadingPlaylists, setLoadingPlaylists] = useState(false);
    const [addResult, setAddResult] = useState<{ ok: boolean; message: string } | null>(null);

    // Sync liked state with current track
    useEffect(() => {
        setLiked(player.currentTrack?.liked ?? false);
    }, [player.currentTrack?.id, player.currentTrack?.liked]);

    // Clear add result after 2s
    useEffect(() => {
        if (!addResult) return;
        const t = setTimeout(() => setAddResult(null), 2000);
        return () => clearTimeout(t);
    }, [addResult]);

    const handleLike = useCallback(async () => {
        if (!player.currentTrack) return;
        const newLiked = !liked;
        setLiked(newLiked);
        if (newLiked) {
            // For Netease tracks, open playlist picker to add to a playlist
            if (isNeteaseTrack && isNeteaseConfigured()) {
                setShowPlaylistPicker(true);
                setLoadingPlaylists(true);
                getUserPlaylists().then(p => { setPlaylists(p); setLoadingPlaylists(false); });
            }
        } else {
            // Unlike — remove from Netease playlist if previously added
            if (isNeteaseTrack && neteaseId) {
                const pid = getTrackPlaylistId(neteaseId);
                if (pid) {
                    const result = await removeTracksFromPlaylist(pid, [neteaseId]);
                    removeTrackPlaylistRecord(neteaseId);
                    setAddResult(result);
                }
            }
        }
    }, [liked, player.currentTrack, isNeteaseTrack, neteaseId]);

    const handleAddToPlaylist = useCallback(async (playlist: NeteasePlaylist) => {
        if (!neteaseId) return;
        const result = await addTracksToPlaylist(playlist.id, [neteaseId]);
        if (result.ok) {
            recordTrackPlaylist(neteaseId, playlist.id);
        }
        setAddResult(result);
        setShowPlaylistPicker(false);
    }, [neteaseId]);

    // ── Listen Together & Share Menu State ──
    const [listenTogether, setListenTogether] = useState<ListenTogetherSession | null>(null);
    const [listenSeconds, setListenSeconds] = useState(0);
    const [shareMenuAnchor, setShareMenuAnchor] = useState<"top" | "bottom" | null>(null);
    const [showInviteFriendsModal, setShowInviteFriendsModal] = useState(false);
    const [friendCandidates, setFriendCandidates] = useState<Array<{
        sessionId: string;
        contactId: string;
        name: string;
        avatar: string | null;
        bio?: string;
    }>>([]);

    const resolveListenTogetherSession = useCallback(async (sessionId: string, contactId?: string) => {
        const sessions = loadChatSessions();
        const sess = sessions.find(s => s.id === sessionId) || (contactId ? sessions.find(s => !s.isGroup && s.contactId === contactId) : undefined);
        const cid = contactId || sess?.contactId || sessionId;
        const chars = loadCharacters();
        const char = chars.find(c => c.id === cid);
        const charName = sess?.alias || char?.name || sess?.groupName || "TA";
        const identity = resolveUserIdentity(cid || undefined, "chat");
        const userName = identity?.name || "我";

        let charAvatar = char?.avatar || null;
        let userAvatar = identity?.avatarUrl || null;

        if (sess?.avatarOverrides) {
            const selfOverrideId = sess.avatarOverrides["self"];
            if (selfOverrideId) {
                const url = await getChatImageFromIndexedDB(selfOverrideId).catch(() => null);
                if (url) userAvatar = url;
            }
            const charOverrideId = cid ? sess.avatarOverrides[cid] : undefined;
            if (charOverrideId) {
                const url = await getChatImageFromIndexedDB(charOverrideId).catch(() => null);
                if (url) charAvatar = url;
            }
        }

        const keyId = cid || sessionId;
        const statsKey = LISTEN_TOGETHER_STATS_PREFIX + keyId;
        const savedSecs = Number(kvGet(statsKey) || "0");
        const initialSecs = Number.isFinite(savedSecs) && savedSecs >= 0 ? Math.floor(savedSecs) : 0;

        const nextSession: ListenTogetherSession = {
            sessionId: sess?.id || sessionId,
            contactId: keyId,
            charName,
            charAvatar,
            userAvatar,
            userName,
        };
        setListenTogether(nextSession);
        setListenSeconds(initialSecs);
        try {
            kvSet(LISTEN_TOGETHER_SESSION_KEY, JSON.stringify({ sessionId: nextSession.sessionId, contactId: keyId }));
        } catch { /* ignore */ }
    }, []);

    // Restore persisted listen-together session on mount
    useEffect(() => {
        try {
            const raw = kvGet(LISTEN_TOGETHER_SESSION_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as { sessionId?: string; contactId?: string };
            if (parsed?.sessionId || parsed?.contactId) {
                void resolveListenTogetherSession(parsed.sessionId || parsed.contactId!, parsed.contactId);
            }
        } catch { /* ignore */ }
    }, [resolveListenTogetherSession]);

    // Listen for explicit listen-together start event
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ sessionId?: string; contactId?: string }>).detail;
            if (!detail?.sessionId && !detail?.contactId) return;
            void resolveListenTogetherSession(detail.sessionId || detail.contactId!, detail.contactId);
        };
        window.addEventListener("music-listen-together-start", handler);
        return () => window.removeEventListener("music-listen-together-start", handler);
    }, [resolveListenTogetherSession]);

    // Sync duration from global MusicProvider ticker (which runs even when MusicPlayer is closed)
    useEffect(() => {
        if (!listenTogether) return;
        const statsKey = LISTEN_TOGETHER_STATS_PREFIX + listenTogether.contactId;
        const saved = Number(kvGet(statsKey) || "0");
        if (Number.isFinite(saved) && saved >= 0) {
            setListenSeconds(Math.floor(saved));
        }
        const onTick = (e: Event) => {
            const detail = (e as CustomEvent<{ contactId?: string; seconds?: number }>).detail;
            if (detail?.contactId === listenTogether.contactId && typeof detail.seconds === "number") {
                setListenSeconds(detail.seconds);
            }
        };
        window.addEventListener("music-listen-together-tick", onTick);
        return () => window.removeEventListener("music-listen-together-tick", onTick);
    }, [listenTogether]);

    const exitListenTogether = useCallback(() => {
        setListenTogether(null);
        try { kvSet(LISTEN_TOGETHER_SESSION_KEY, ""); } catch { /* ignore */ }
    }, []);

    const handleShareToChat = useCallback(() => {
        setShareMenuAnchor(null);
        if (!player.currentTrack) return;
        window.dispatchEvent(new CustomEvent("open-mini-chat", {
            detail: { share: { type: "music", title: player.currentTrack.title, artist: player.currentTrack.artist } },
        }));
    }, [player.currentTrack]);

    const handleOpenInviteFriends = useCallback(async () => {
        setShareMenuAnchor(null);
        const sessions = loadChatSessions();
        const chars = loadCharacters();
        const directSessionByCharId = new Map<string, ReturnType<typeof loadChatSessions>[number]>();
        for (const s of sessions) {
            if (!s.isGroup && s.contactId && !directSessionByCharId.has(s.contactId)) {
                directSessionByCharId.set(s.contactId, s);
            }
        }
        const list = await Promise.all(chars.map(async (char) => {
            const sess = directSessionByCharId.get(char.id);
            let avatar = char.avatar || null;
            if (sess?.avatarOverrides?.[char.id]) {
                const overrideUrl = await getChatImageFromIndexedDB(sess.avatarOverrides[char.id]).catch(() => null);
                if (overrideUrl) avatar = overrideUrl;
            }
            return {
                sessionId: sess?.id || char.id,
                contactId: char.id,
                name: sess?.alias || char.name || "TA",
                avatar,
                bio: char.description?.slice(0, 36) || "",
            };
        }));
        setFriendCandidates(list);
        setShowInviteFriendsModal(true);
    }, []);

    const handleSelectInviteFriend = useCallback((candidate: { sessionId: string; contactId: string }) => {
        setShowInviteFriendsModal(false);
        void resolveListenTogetherSession(candidate.sessionId, candidate.contactId);
    }, [resolveListenTogetherSession]);

    const openMiniChat = useCallback(() => {
        window.dispatchEvent(new CustomEvent("open-mini-chat"));
    }, []);

    const openArtistPage = useCallback(async () => {
        if (!player.currentTrack) return;
        if (!isNeteaseTrack || !isNeteaseConfigured()) {
            showMusicToast("本地歌曲暂无歌手主页");
            return;
        }
        const detail = await getNeteaseSongDetail(neteaseId);
        const first = detail?.artistList?.[0];
        if (!first) {
            showMusicToast("没有找到歌手信息");
            return;
        }
        setArtistView(first);
    }, [player.currentTrack, isNeteaseTrack, neteaseId, showMusicToast]);

    const track = player.currentTrack;
    const waveBars = useMemo(() => waveHeights(track?.id || "lumen"), [track?.id]);

    const getAdjacentTrack = (direction: "prev" | "next") => {
        if (player.queue.length === 0 || !player.currentTrack) return null;
        const idx = player.queue.findIndex(t => t.id === player.currentTrack!.id);
        if (idx < 0) return null;
        if (player.playMode === "shuffle") {
            return player.queue[Math.floor(Math.random() * player.queue.length)] ?? null;
        }
        const offset = direction === "next" ? 1 : -1;
        const nextIdx = (idx + offset + player.queue.length) % player.queue.length;
        return player.queue[nextIdx] ?? null;
    };

    const handleSwitchToTrack = useCallback(async (target: typeof player.currentTrack) => {
        if (!target) return;
        if (target.id.startsWith("netease_")) {
            beginMusicLoadingToast(target.id);
            const nid = parseInt(target.id.replace("netease_", ""), 10);
            const info = await getNeteasePlayInfo(nid);
            if (!info.url) {
                showMusicToast(info.reason || "加载失败，请稍后重试", 2600);
                return;
            }
            let resolvedTarget = target;
            if (!target.lyrics) {
                const [detail, lyrics] = await Promise.all([
                    getNeteaseSongDetail(nid).catch(() => null),
                    getNeteaseLyrics(nid).catch(() => ""),
                ]);
                resolvedTarget = {
                    ...target,
                    title: detail?.name || target.title,
                    artist: detail?.artists || target.artist,
                    coverUrl: detail?.coverUrl || target.coverUrl,
                    lyrics: lyrics || target.lyrics,
                };
            }
            player.playUrl(info.url, resolvedTarget);
            if (info.trial) showMusicToast("VIP 歌曲，当前播放 30 秒试听", 2600);
            return;
        }
        player.playTrack(target);
    }, [beginMusicLoadingToast, player, showMusicToast]);

    const handlePrev = useCallback(() => {
        const target = getAdjacentTrack("prev");
        if (target?.id.startsWith("netease_")) {
            void handleSwitchToTrack(target);
            return;
        }
        player.prev();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handleSwitchToTrack, player]);

    const handleNext = useCallback(() => {
        const target = getAdjacentTrack("next");
        if (target?.id.startsWith("netease_")) {
            void handleSwitchToTrack(target);
            return;
        }
        player.next();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handleSwitchToTrack, player]);

    if (!track) return null;

    const hasLyrics = parsedLyrics.current.length > 0;
    const modeInfo = PLAY_MODE_ICONS[player.playMode];
    const activeLyricText = activeLyricIdx >= 0 ? parsedLyrics.current[activeLyricIdx]?.text : "";
    const customBg = playerBgStyle(bgCfg);
    const ambientVars = {
        "--mp-c1": palette[0],
        "--mp-c2": palette[1],
        "--mp-c3": palette[2],
        ...(customBg || {}),
    } as React.CSSProperties;

    return (
        <div className="music-player mp-lumen" style={ambientVars}>
            {musicToast && (
                <div className="music-toast-overlay">
                    <div className="music-toast-chip">
                        {musicToast === "加载音乐中..." ? (
                            <span className="ui-loading-toast-content">
                                <span className="ui-loading-spinner" />
                                <span>{musicToast}</span>
                            </span>
                        ) : musicToast}
                    </div>
                </div>
            )}

            {/* Ambient flowing background tinted by cover colors (hidden on custom bg) */}
            <div className="mp-ambient" aria-hidden="true">
                {!customBg && (
                    <>
                        <i className="mp-blob mp-blob-1" />
                        <i className="mp-blob mp-blob-2" />
                        <i className="mp-blob mp-blob-3" />
                    </>
                )}
                <span className="mp-grain" />
                <span className="mp-vignette" />
            </div>

            {/* Header */}
            <div className="mp-top">
                <button className="music-player-close" onClick={player.closeFullPlayer}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M15 19 8 12l7-7" />
                    </svg>
                </button>
                <div className="mp-titles">
                    <div className="mp-song" {...(view === "lyrics" ? { "data-glow": "" } : {})}>{track.title}</div>
                    <button className="mp-artist" onClick={openArtistPage}>
                        {track.artist || "未知歌手"}
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9 5 7 7-7 7" /></svg>
                    </button>
                </div>
                <div className="mp-top-actions">
                    <button
                        type="button"
                        className="music-player-ctrl-btn mp-top-btn mp-lyric-toggle-btn"
                        {...(!player.floatDismissed ? { "data-active": "" } : {})}
                        onClick={player.toggleFloat}
                        title={!player.floatDismissed ? "关闭桌面歌词" : "开启桌面歌词"}
                    >
                        <span className="mp-lyric-toggle-text">词</span>
                        {!player.floatDismissed && (
                            <span className="mp-lyric-toggle-badge" aria-hidden="true">
                                <svg width="7" height="7" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="2.5 6.5 5 9 9.5 3.5" />
                                </svg>
                            </span>
                        )}
                    </button>
                    <button className="music-player-ctrl-btn mp-top-btn" onClick={togglePlayerStyle} title={playerStyle === "vinyl" ? "切换现代样式" : "切换黑胶样式"}>
                        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
                        </svg>
                    </button>
                    <button className="music-player-ctrl-btn mp-top-btn" onClick={openMiniChat} title="聊天小窗">
                        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                    </button>
                    <div className="mp-share-menu-wrap">
                        <button
                            type="button"
                            className="music-player-ctrl-btn mp-top-btn"
                            onClick={() => setShareMenuAnchor(prev => prev === "top" ? null : "top")}
                            title="分享"
                        >
                            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                            </svg>
                        </button>
                        {shareMenuAnchor === "top" && (
                            <div className="mp-share-dropdown mp-share-dropdown--top" onClick={e => e.stopPropagation()}>
                                <button type="button" className="mp-share-dropdown-item" onClick={handleShareToChat}>
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                    </svg>
                                    <span>分享至...</span>
                                </button>
                                <button type="button" className="mp-share-dropdown-item" onClick={() => { void handleOpenInviteFriends(); }}>
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                                        <circle cx="9" cy="7" r="4" />
                                        <line x1="19" y1="8" x2="19" y2="14" />
                                        <line x1="22" y1="11" x2="16" y2="11" />
                                    </svg>
                                    <span>邀请好友一起听</span>
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
            {shareMenuAnchor && (
                <div className="mp-share-menu-backdrop" onClick={() => setShareMenuAnchor(null)} />
            )}

            {/* Listen Together banner (between header and body) */}
            {listenTogether && (
                <div className="mp-listen-together">
                    <div className="mp-listen-avatars">
                        <div className="mp-listen-avatar mp-listen-avatar-user">
                            {listenTogether.userAvatar ? (
                                <img src={listenTogether.userAvatar} alt="" />
                            ) : (
                                <span>{listenTogether.userName.slice(0, 1) || "我"}</span>
                            )}
                        </div>
                        <div className="mp-listen-avatar mp-listen-avatar-char">
                            {listenTogether.charAvatar ? (
                                <img src={listenTogether.charAvatar} alt="" />
                            ) : (
                                <span>{listenTogether.charName.slice(0, 1) || "TA"}</span>
                            )}
                        </div>
                    </div>
                    <div className="mp-listen-text">
                        {listenTogether.charName} 就在你身边，一起听了 {formatListenDuration(listenSeconds)}
                    </div>
                    <button
                        type="button"
                        className="mp-listen-exit"
                        onClick={exitListenTogether}
                    >
                        退出
                    </button>
                </div>
            )}

            {/* Body — cover / vinyl / glow lyrics */}
            <div className="mp-body">
                {view === "lyrics" ? (
                    <div className="mp-lyrics-wrap" onClick={() => setView("cover")}>
                        {hasLyrics ? (
                            <div className="mp-lyrics" ref={lyricsContainerRef}>
                                {parsedLyrics.current.map((line, i) => {
                                    const dist = Math.abs(i - activeLyricIdx);
                                    return (
                                        <div
                                            key={i}
                                            className="mp-lyric-line"
                                            {...(i === activeLyricIdx ? { "data-active": "" } : dist === 1 ? { "data-near": "" } : {})}
                                            onClick={(e) => handleLyricClick(i, e)}
                                        >
                                            {line.text || " "}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="mp-lyrics mp-lyrics-empty">
                                <div className="mp-lyric-line" data-active="">暂无歌词</div>
                            </div>
                        )}
                    </div>
                ) : playerStyle === "vinyl" ? (
                    <div className="music-player-vinyl-area" onClick={() => setView("lyrics")}>
                        <div className="music-player-vinyl-glow" />
                        <div className="music-player-vinyl" {...(player.isPlaying ? { "data-spinning": "" } : {})}>
                            <div className="music-player-vinyl-groove music-player-vinyl-groove-1" />
                            <div className="music-player-vinyl-groove music-player-vinyl-groove-2" />
                            <div className="music-player-vinyl-groove music-player-vinyl-groove-3" />
                            <div className="music-player-vinyl-center">
                                {track.coverUrl ? (
                                    <img src={track.coverUrl} alt="" className="music-player-vinyl-cover" />
                                ) : (
                                    <div className="music-player-vinyl-cover-placeholder">
                                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                                            <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                        </svg>
                                    </div>
                                )}
                            </div>
                            <div className="music-player-vinyl-dot" />
                        </div>
                        <div className="music-player-tonearm" {...(player.isPlaying ? { "data-playing": "" } : {})}>
                            <div className="music-player-tonearm-pivot" />
                            <div className="music-player-tonearm-arm" />
                            <div className="music-player-tonearm-joint" />
                            <div className="music-player-tonearm-head" />
                        </div>
                    </div>
                ) : (
                    <div className="mp-cover-area" onClick={() => setView("lyrics")}>
                        <div className="mp-cover" {...(player.isPlaying ? {} : { "data-paused": "" })}>
                            {track.coverUrl ? (
                                <img src={track.coverUrl} alt="" />
                            ) : (
                                <div className="mp-cover-placeholder">
                                    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                                        <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                                    </svg>
                                </div>
                            )}
                        </div>
                        <div className="mp-lyric-peek">
                            {activeLyricText ? (
                                <>「{activeLyricText}」<span>点击查看歌词</span></>
                            ) : hasLyrics ? (
                                <span>点击查看歌词</span>
                            ) : null}
                        </div>
                    </div>
                )}
            </div>

            {/* Waveform progress */}
            <div className="mp-progress-area">
                <div
                    ref={progressRef}
                    className="mp-wave"
                    onPointerDown={handleProgressDown}
                    onPointerMove={handleProgressMove}
                    onPointerUp={handleProgressUp}
                    onPointerCancel={handleProgressUp}
                >
                    {waveBars.map((h, i) => {
                        const lit = (i + 0.5) / WAVE_BAR_COUNT <= progress;
                        const head = Math.abs((i + 0.5) / WAVE_BAR_COUNT - progress) < 0.5 / WAVE_BAR_COUNT;
                        return <i key={i} style={{ height: `${h}px` }} {...(head ? { "data-head": "" } : lit ? { "data-lit": "" } : {})} />;
                    })}
                </div>
                <div className="mp-times">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(player.duration)}</span>
                </div>
            </div>

            {/* Controls */}
            <div className="mp-controls">
                <button className="music-player-ctrl-btn mp-ctrl-side" onClick={cyclePlayMode} title={modeInfo.label}>
                    <svg width="20" height="20" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: modeInfo.svg }} />
                </button>
                <button className="music-player-ctrl-btn mp-ctrl" onClick={handlePrev}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                    </svg>
                </button>
                <button className="music-player-ctrl-btn mp-ctrl-play" onClick={player.togglePlay}>
                    {player.isPlaying ? (
                        <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
                        </svg>
                    ) : (
                        <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                        </svg>
                    )}
                </button>
                <button className="music-player-ctrl-btn mp-ctrl" onClick={handleNext}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z" />
                    </svg>
                </button>
                <button
                    className="music-player-ctrl-btn mp-ctrl-side"
                    onClick={() => setShowQueue(true)}
                    disabled={player.queue.length === 0}
                    title="播放列表"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                    </svg>
                </button>
            </div>

            {/* Social row: like / comments / share */}
            <div className="mp-social">
                <button className="mp-social-btn" {...(liked ? { "data-liked": "" } : {})} onClick={handleLike}>
                    {liked ? (
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                    ) : (
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                        </svg>
                    )}
                    <span>喜欢</span>
                </button>
                <button
                    className="mp-social-btn"
                    onClick={() => {
                        if (!isNeteaseTrack) { showMusicToast("本地歌曲暂无评论区"); return; }
                        setShowComments(true);
                    }}
                >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L4 21l1.5-4.3A8.5 8.5 0 1 1 21 12z" />
                    </svg>
                    <span>{commentTotal > 0 ? formatCount(commentTotal) : "评论"}</span>
                </button>
                <div className="mp-share-menu-wrap">
                    <button
                        type="button"
                        className="mp-social-btn"
                        onClick={() => setShareMenuAnchor(prev => prev === "bottom" ? null : "bottom")}
                    >
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                        </svg>
                        <span>分享</span>
                    </button>
                    {shareMenuAnchor === "bottom" && (
                        <div className="mp-share-dropdown mp-share-dropdown--bottom" onClick={e => e.stopPropagation()}>
                            <button type="button" className="mp-share-dropdown-item" onClick={handleShareToChat}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                </svg>
                                <span>分享至...</span>
                            </button>
                            <button type="button" className="mp-share-dropdown-item" onClick={() => { void handleOpenInviteFriends(); }}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                                    <circle cx="9" cy="7" r="4" />
                                    <line x1="19" y1="8" x2="19" y2="14" />
                                    <line x1="22" y1="11" x2="16" y2="11" />
                                </svg>
                                <span>邀请好友一起听</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Invite friends to listen together modal */}
            {showInviteFriendsModal && (
                <div className="music-playlist-picker-overlay" onClick={() => setShowInviteFriendsModal(false)}>
                    <div className="music-playlist-picker mp-invite-friends-modal" onClick={e => e.stopPropagation()}>
                        <div className="music-playlist-picker-header">
                            <span>邀请好友一起听</span>
                            <button className="music-playlist-picker-close" onClick={() => setShowInviteFriendsModal(false)}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="music-playlist-picker-list">
                            {friendCandidates.length === 0 ? (
                                <div className="music-playlist-picker-loading">暂无可邀请的好友</div>
                            ) : friendCandidates.map(friend => (
                                <button
                                    key={friend.contactId}
                                    type="button"
                                    className="music-playlist-picker-item mp-invite-friend-item"
                                    onClick={() => handleSelectInviteFriend(friend)}
                                >
                                    <div className="mp-invite-friend-avatar">
                                        {friend.avatar ? (
                                            <img src={friend.avatar} alt="" />
                                        ) : (
                                            <span>{friend.name.slice(0, 1) || "TA"}</span>
                                        )}
                                    </div>
                                    <div className="music-playlist-picker-info">
                                        <div className="music-playlist-picker-name">{friend.name}</div>
                                        {friend.bio ? <div className="music-playlist-picker-count">{friend.bio}</div> : null}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Queue drawer */}
            {showQueue && (
                <div className="music-queue-overlay" onClick={() => setShowQueue(false)}>
                    <div className="music-queue-drawer" onClick={e => e.stopPropagation()}>
                        <div className="music-queue-header">
                            <span>播放列表</span>
                            <span className="music-queue-count">{player.queue.length}首</span>
                            <button className="music-playlist-picker-close" onClick={() => setShowQueue(false)}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="music-queue-list">
                            {player.queue.map((t, idx) => {
                                const isCurrent = t.id === track.id;
                                return (
                                    <div
                                        key={t.id}
                                        className="music-queue-item"
                                        role="button"
                                        tabIndex={0}
                                        {...(isCurrent ? { "data-current": "" } : {})}
                                        onClick={() => { void handleSwitchToTrack(t); }}
                                    >
                                        <span className="music-queue-item-idx">{idx + 1}</span>
                                        <div className="music-queue-item-info">
                                            <div className="music-queue-item-title">{t.title}</div>
                                            <div className="music-queue-item-artist">{t.artist}</div>
                                        </div>
                                        {isCurrent && player.isPlaying && (
                                            <div className="music-wave music-queue-wave">{[0, 1, 2].map(i => <span key={i} className="music-wave-bar" style={{ animationDelay: `${i * 0.15}s` }} />)}</div>
                                        )}
                                        {!isCurrent && (
                                            <button
                                                className="music-queue-item-del"
                                                onClick={e => { e.stopPropagation(); player.removeFromQueue(t.id); }}
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {/* Playlist picker overlay */}
            {showPlaylistPicker && (
                <div className="music-playlist-picker-overlay" onClick={() => setShowPlaylistPicker(false)}>
                    <div className="music-playlist-picker" onClick={e => e.stopPropagation()}>
                        <div className="music-playlist-picker-header">
                            <span>收藏到歌单</span>
                            <button className="music-playlist-picker-close" onClick={() => setShowPlaylistPicker(false)}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="music-playlist-picker-list">
                            {loadingPlaylists ? (
                                <div className="music-playlist-picker-loading">加载歌单...</div>
                            ) : playlists.length === 0 ? (
                                <div className="music-playlist-picker-loading">没有找到歌单</div>
                            ) : playlists.map(pl => (
                                <button key={pl.id} className="music-playlist-picker-item" onClick={() => handleAddToPlaylist(pl)}>
                                    <img src={pl.coverUrl} alt="" className="music-playlist-picker-cover" />
                                    <div className="music-playlist-picker-info">
                                        <div className="music-playlist-picker-name">{pl.name}</div>
                                        <div className="music-playlist-picker-count">{pl.trackCount}首</div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Comments overlay */}
            {showComments && neteaseId > 0 && (
                <MusicCommentsPage
                    songId={neteaseId}
                    title={track.title}
                    artist={track.artist}
                    coverUrl={track.coverUrl}
                    onClose={() => setShowComments(false)}
                />
            )}

            {/* Artist overlay */}
            {artistView && (
                <MusicArtistPage
                    artistId={artistView.id}
                    artistName={artistView.name}
                    onClose={() => setArtistView(null)}
                />
            )}

            {/* Add result toast */}
            {addResult && (
                <div className={`music-toast ${addResult.ok ? "music-toast-ok" : "music-toast-err"}`}>
                    {addResult.ok ? "✓ " : "✗ "}{addResult.message}
                </div>
            )}

        </div>
    );
}
