"use client";

// components/music/music-upload-dialog.tsx
// 本地音乐 · 逐项导入
//
// 一次只加一首，每一项来源各自可选：
//   歌曲：只收本地文件——「本地音乐」就该是真正存下来的东西，不吃链接时效和防盗链
//   歌词：.lrc / .txt 文件，原样存文本（时间轴由播放层解析）
//   封面：本地图片（压成 data URL 存）或图片直链（直接存地址）
// 歌名 / 歌手 / 专辑都可以手改：写进去的就是最终落库的值。
//
// 歌曲为什么不收链接：播放层的本地分支走 getAudioBlob(track.id)，只认库里的 blob；
// 要支持链接就得给 MusicTrack 加远程地址字段、再改播放分支走流式。
// 与其留一条「点了没声音」的入口，不如只留文件——链接播放的需求归网易云在线那套。
// 封面是另一回事：它只用于展示，存个地址就能显示，不需要落成二进制。

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
    const [coverUrlDraft, setCoverUrlDraft] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const audioInputRef = useRef<HTMLInputElement>(null);
    const lyricsInputRef = useRef<HTMLInputElement>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);

    const hasAudio = Boolean(audioBlob);

    /**
     * 落定音频源。歌名/歌手只在用户还没手填时才用文件名覆盖——
     * 先选一个文件、改好名字、又「重新选择」换了另一个时，不该把改好的名字冲掉。
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
            setError("先选择要添加的歌曲文件");
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
                                {hasAudio ? "重新选择" : "选择文件"}
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
