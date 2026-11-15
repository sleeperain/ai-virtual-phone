"use client";

// components/music/music-upload-dialog.tsx
// 本地音乐 · 逐项导入
//
// 一次只加一首，但每一项都能单独换来源：
//   歌曲：本地文件，或音频直链（直链会先抓成 Blob 再存——播放层只认 IndexedDB 里的 blob）
//   歌词：.lrc / .txt 文件，原样存文本（时间轴由播放层解析）
//   封面：本地图片（压成 data URL 存）或图片直链（直接存地址）
// 歌名 / 歌手 / 专辑都可以手改：写进去的就是最终落库的值。
//
// 为什么直链要先抓成 blob：lib/music-context 播本地曲目走 getAudioBlob(track.id)，
// 库里没有 blob 就播不出声。只存一个远程地址的话，曲目会进列表但点了没反应。

import { useRef, useState } from "react";
import {
    generateTrackId,
    getAudioDuration,
    parseFilename,
    saveTrack,
    type MusicTrack,
} from "@/lib/music-storage";
import { fileToCompressedDataUrl } from "@/lib/music-bg";

const AUDIO_EXTS = ["mp3", "m4a", "aac", "ogg", "wav", "flac", "wma", "opus", "webm"];
const LYRICS_EXTS = ["lrc", "txt"];
/** 封面压到这个边长就够了：列表和播放页单独显示最多几百像素，
 *  1:1 大图既撑存储又拖慢列表渲染 */
const COVER_MAX_DIM = 640;

function extOf(name: string): string {
    return name.split(".").pop()?.toLowerCase() ?? "";
}

/** 直链最后一段当文件名：https://x.com/a/Artist%20-%20Title.mp3 → "Artist - Title.mp3" */
function filenameFromUrl(raw: string): string {
    try {
        const url = new URL(raw);
        const last = url.pathname.split("/").filter(Boolean).pop() || "";
        return decodeURIComponent(last);
    } catch {
        return "";
    }
}

function looksLikeHttpUrl(raw: string): boolean {
    return /^https?:\/\/\S+$/i.test(raw.trim());
}

type Props = {
    onClose: () => void;
    /** 保存成功后回传，由调用方塞进本地列表 */
    onAdded: (track: MusicTrack) => void;
};

export default function MusicUploadDialog({ onClose, onAdded }: Props) {
    const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
    const [audioName, setAudioName] = useState("");
    const [duration, setDuration] = useState(0);
    const [lyrics, setLyrics] = useState("");
    const [lyricsName, setLyricsName] = useState("");
    const [cover, setCover] = useState("");
    const [title, setTitle] = useState("");
    const [artist, setArtist] = useState("");
    const [album, setAlbum] = useState("");
    const [audioUrlDraft, setAudioUrlDraft] = useState("");
    const [coverUrlDraft, setCoverUrlDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const audioInputRef = useRef<HTMLInputElement>(null);
    const lyricsInputRef = useRef<HTMLInputElement>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);

    const hasAudio = Boolean(audioBlob);

    /**
     * 落定音频源。歌名/歌手只在用户还没手填时才用文件名覆盖——
     * 先选文件、改好名字、再换一次链接时，不该把改好的名字冲掉。
     */
    const applyAudioSource = async (blob: Blob, name: string) => {
        const seconds = await getAudioDuration(blob).catch(() => 0);
        const parsed = parseFilename(name || "未命名");
        setAudioBlob(blob);
        setAudioName(name || "未命名");
        setDuration(seconds);
        setTitle(prev => (prev.trim() ? prev : parsed.title));
        setArtist(prev => (prev.trim() ? prev : parsed.artist));
    };

    const handleAudioFile = async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;
        const ext = extOf(file.name);
        if (!file.type.startsWith("audio/") && !AUDIO_EXTS.includes(ext)) {
            setError(`这不是音频文件，支持 ${AUDIO_EXTS.join(" / ")}`);
            return;
        }
        setError("");
        setBusy(true);
        try {
            await applyAudioSource(file, file.name);
        } catch {
            setError("这个音频文件读不出来，换一个试试");
        } finally {
            setBusy(false);
            if (audioInputRef.current) audioInputRef.current.value = "";
        }
    };

    const handleAudioUrl = async () => {
        const raw = audioUrlDraft.trim();
        if (!raw) return;
        if (!looksLikeHttpUrl(raw)) {
            setError("链接要以 http:// 或 https:// 开头");
            return;
        }
        setError("");
        setBusy(true);
        try {
            const resp = await fetch(raw);
            if (!resp.ok) throw new Error(`链接返回 ${resp.status}`);
            const blob = await resp.blob();
            if (blob.size === 0) throw new Error("链接里没有内容");
            // 有些服务器一律回 application/octet-stream，那种放行，交给解码去判断
            if (blob.type && !blob.type.startsWith("audio/") && !blob.type.includes("octet-stream")) {
                throw new Error("这个链接返回的不是音频");
            }
            await applyAudioSource(blob, filenameFromUrl(raw) || "未命名");
            setAudioUrlDraft("");
        } catch (e) {
            const reason = e instanceof Error ? e.message : "网络错误";
            // 跨域读不到是最常见的一类：站点没给 CORS 头，浏览器直接拦
            setError(`解析失败：${reason}。多数站点不允许跨域读取音频，可以先把文件下载到本地再上传。`);
        } finally {
            setBusy(false);
        }
    };

    const handleLyricsFile = async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;
        if (!LYRICS_EXTS.includes(extOf(file.name))) {
            setError("歌词只支持 .lrc / .txt");
            return;
        }
        try {
            const text = await file.text();
            // 记事本存出来的 lrc 常带 BOM，带进第一行会把时间戳挤歪
            const clean = text.replace(/^\uFEFF/, "");
            if (!clean.trim()) {
                setError("歌词文件是空的");
                return;
            }
            setLyrics(clean);
            setLyricsName(file.name);
            setError("");
        } catch {
            setError("歌词文件读取失败");
        } finally {
            if (lyricsInputRef.current) lyricsInputRef.current.value = "";
        }
    };

    const handleCoverFile = async (files: FileList | null) => {
        const file = files?.[0];
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            setError("封面需要图片文件");
            return;
        }
        try {
            const dataUrl = await fileToCompressedDataUrl(file, COVER_MAX_DIM, 0.85);
            setCover(dataUrl);
            setError("");
        } catch {
            setError("封面处理失败，换一张试试");
        } finally {
            if (coverInputRef.current) coverInputRef.current.value = "";
        }
    };

    const applyCoverUrl = () => {
        const raw = coverUrlDraft.trim();
        if (!raw) return;
        if (!looksLikeHttpUrl(raw) && !raw.startsWith("data:image/")) {
            setError("封面链接要以 http:// 或 https:// 开头");
            return;
        }
        setCover(raw);
        setCoverUrlDraft("");
        setError("");
    };

    const handleSave = async () => {
        if (!audioBlob) {
            setError("先选择歌曲文件，或者用链接解析一首歌");
            return;
        }
        const fallback = parseFilename(audioName || "未命名");
        const finalTitle = title.trim() || fallback.title || "未知曲目";
        const finalArtist = artist.trim() || fallback.artist || "未知歌手";
        setBusy(true);
        setError("");
        try {
            const track: MusicTrack = {
                id: generateTrackId(),
                title: finalTitle,
                artist: finalArtist,
                duration,
                liked: false,
                addedAt: new Date().toISOString(),
            };
            if (album.trim()) track.album = album.trim();
            if (lyrics.trim()) track.lyrics = lyrics;
            if (cover.trim()) track.coverUrl = cover;
            await saveTrack(track, audioBlob);
            onAdded(track);
            onClose();
        } catch (e) {
            setError(`保存失败：${e instanceof Error ? e.message : "未知错误"}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className="music-settings-modal-overlay"
            onClick={() => { if (!busy) onClose(); }}
        >
            <div
                className="music-settings-modal-dialog music-upload-dialog"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="music-settings-header">
                    <h2>添加本地音乐</h2>
                    <button className="music-settings-close" onClick={onClose} disabled={busy} aria-label="关闭">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="music-settings-body music-upload-body">
                    {/* ── 歌曲 ── */}
                    <div className="music-settings-section">
                        <div className="music-settings-label">歌曲</div>
                        <div className="music-settings-hint">
                            {hasAudio
                                ? `已选：${audioName}${duration > 0 ? `（${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}）` : ""}`
                                : "支持 mp3 / m4a / flac / wav 等常见格式"}
                        </div>
                        <input
                            ref={audioInputRef}
                            type="file"
                            accept="audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac,.wma,.opus,.webm"
                            hidden
                            onChange={(e) => { void handleAudioFile(e.target.files); }}
                        />
                        <div className="music-settings-actions">
                            <button className="music-settings-btn" onClick={() => audioInputRef.current?.click()} disabled={busy}>
                                选择文件
                            </button>
                        </div>

                        <div className="music-settings-actions">
                            <input
                                className="music-settings-input"
                                placeholder="或填音频直链 https://…"
                                value={audioUrlDraft}
                                onChange={(e) => setAudioUrlDraft(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") void handleAudioUrl(); }}
                                disabled={busy}
                            />
                            <button
                                className="music-settings-btn"
                                style={{ flex: "0 0 76px" }}
                                onClick={() => { void handleAudioUrl(); }}
                                disabled={busy || !audioUrlDraft.trim()}
                            >
                                {busy ? "解析中" : "解析"}
                            </button>
                        </div>
                    </div>

                    {/* ── 歌词 ── */}
                    <div className="music-settings-section">
                        <div className="music-settings-label">歌词</div>
                        <div className="music-settings-hint">
                            {lyrics ? `已载入：${lyricsName}` : "上传 .lrc 或 .txt，可跳过"}
                        </div>
                        <input
                            ref={lyricsInputRef}
                            type="file"
                            accept=".lrc,.txt,text/plain"
                            hidden
                            onChange={(e) => { void handleLyricsFile(e.target.files); }}
                        />
                        <div className="music-settings-actions">
                            <button className="music-settings-btn" onClick={() => lyricsInputRef.current?.click()}>
                                选择歌词文件
                            </button>
                            {lyrics && (
                                <button className="music-settings-btn" onClick={() => { setLyrics(""); setLyricsName(""); }}>
                                    移除
                                </button>
                            )}
                        </div>
                    </div>

                    {/* ── 封面 ── */}
                    <div className="music-settings-section">
                        <div className="music-settings-label">专辑封面</div>
                        <div className="music-upload-cover-row">
                            <div className="music-upload-cover">
                                {cover
                                    ? /* eslint-disable-next-line @next/next/no-img-element */
                                      <img src={cover} alt="" />
                                    : <span>♪</span>}
                            </div>
                            <div className="music-upload-cover-side">
                                <input
                                    ref={coverInputRef}
                                    type="file"
                                    accept="image/*"
                                    hidden
                                    onChange={(e) => { void handleCoverFile(e.target.files); }}
                                />
                                <div className="music-settings-actions">
                                    <button className="music-settings-btn" onClick={() => coverInputRef.current?.click()}>
                                        选择图片
                                    </button>
                                    {cover && (
                                        <button className="music-settings-btn" onClick={() => setCover("")}>移除</button>
                                    )}
                                </div>
                                <div className="music-settings-actions">
                                    <input
                                        className="music-settings-input"
                                        placeholder="或填图片直链 https://…"
                                        value={coverUrlDraft}
                                        onChange={(e) => setCoverUrlDraft(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === "Enter") applyCoverUrl(); }}
                                    />
                                    <button
                                        className="music-settings-btn"
                                        style={{ flex: "0 0 76px" }}
                                        onClick={applyCoverUrl}
                                        disabled={!coverUrlDraft.trim()}
                                    >
                                        使用
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* ── 曲目信息 ── */}
                    <div className="music-settings-section">
                        <div className="music-settings-label">曲目信息</div>
                        <div className="music-settings-hint">默认按文件名「歌手 - 歌名」拆，可随手改</div>
                        <input
                            className="music-settings-input"
                            placeholder="歌曲名"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                        />
                        <input
                            className="music-settings-input"
                            placeholder="歌手"
                            value={artist}
                            onChange={(e) => setArtist(e.target.value)}
                        />
                        <input
                            className="music-settings-input"
                            placeholder="专辑（可留空）"
                            value={album}
                            onChange={(e) => setAlbum(e.target.value)}
                        />
                    </div>

                    {error && <div className="music-upload-error">{error}</div>}
                </div>

                {/* 按钮区固定在弹窗底部，不跟着上面那串表单滚走 */}
                <div className="music-upload-foot">
                    <div className="music-settings-actions">
                        <button className="music-settings-btn" onClick={onClose} disabled={busy}>取消</button>
                        <button
                            className="music-settings-btn music-settings-btn-primary"
                            onClick={() => { void handleSave(); }}
                            disabled={busy || !hasAudio}
                        >
                            {busy ? "处理中…" : "添加到本地"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
