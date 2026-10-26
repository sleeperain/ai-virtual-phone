// components/music/music-float.tsx — Floating desktop lyrics widget (draggable, expandable, lockable)
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMusicPlayerOptional } from "@/lib/music-context";
import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";

const DRAG_START_THRESHOLD = 5;

const FLOAT_COLOR_KEY = "ai_phone_music_float_color_v1";
const FLOAT_SIZE_KEY = "ai_phone_music_float_size_v1";
/** 悬浮窗被拖到哪儿了 */
const FLOAT_POS_KEY = "ai_phone_music_float_pos_v1";
// 桌面歌词的配色 / 字号 / 位置都是用户自己调出来的，要跟着 kv 一起迁移和兜底，
// 不然 kv 水合失败时这几项会静默读回默认值。
registerKvMigration(FLOAT_COLOR_KEY);
registerKvMigration(FLOAT_SIZE_KEY);
registerKvMigration(FLOAT_POS_KEY);

const DEFAULT_FLOAT_POS = { x: 24, y: 120 };

/** 读回上次拖到的位置。数据坏了就回默认位置，不能让整块飘到屏幕外。 */
function loadFloatPos(): { x: number; y: number } {
    if (typeof window === "undefined") return DEFAULT_FLOAT_POS;
    try {
        const raw = kvGet(FLOAT_POS_KEY);
        if (!raw) return DEFAULT_FLOAT_POS;
        const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
        if (typeof parsed.x === "number" && typeof parsed.y === "number"
            && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
            return { x: parsed.x, y: parsed.y };
        }
    } catch {
        // 坏数据当成没有
    }
    return DEFAULT_FLOAT_POS;
}

const MORANDI_COLORS = [
    { id: "rose", label: "灰粉", value: "#C58B8B" },
    { id: "sage", label: "豆绿", value: "#7E9B8B" },
    { id: "mist", label: "雾蓝", value: "#7C95AC" },
    { id: "mauve", label: "烟紫", value: "#9A89A6" },
    { id: "sand", label: "暖咖", value: "#B5987D" },
] as const;

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const DEFAULT_FONT_SIZE = 14;

type LyricLine = { time: number; text: string };

function parseLyrics(lrc: string): LyricLine[] {
    if (!lrc) return [];
    const lines: LyricLine[] = [];
    for (const line of lrc.split("\n")) {
        const match = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
        if (match) {
            const mins = parseInt(match[1], 10);
            const secs = parseFloat(match[2]);
            const text = match[3].trim();
            if (text) {
                lines.push({ time: mins * 60 + secs, text });
            }
        }
    }
    lines.sort((a, b) => a.time - b.time);
    return lines;
}

export default function MusicFloat({ hidden }: { hidden?: boolean }) {
    const player = useMusicPlayerOptional();
    const floatRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState(loadFloatPos);
    const [expanded, setExpanded] = useState(false);
    const [locked, setLocked] = useState(false);
    const [showSettings, setShowSettings] = useState(false);

    const [lyricColor, setLyricColor] = useState<string>(() => {
        if (typeof window === "undefined") return MORANDI_COLORS[0].value;
        return kvGet(FLOAT_COLOR_KEY) || MORANDI_COLORS[0].value;
    });
    const [fontSize, setFontSize] = useState<number>(() => {
        if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
        const saved = Number(kvGet(FLOAT_SIZE_KEY));
        return Number.isFinite(saved) && saved >= MIN_FONT_SIZE && saved <= MAX_FONT_SIZE
            ? saved
            : DEFAULT_FONT_SIZE;
    });

    // Re-read preferences after kv hydration
    useEffect(() => {
        const timer = setTimeout(() => {
            const c = kvGet(FLOAT_COLOR_KEY);
            if (c) setLyricColor(c);
            const s = Number(kvGet(FLOAT_SIZE_KEY));
            if (Number.isFinite(s) && s >= MIN_FONT_SIZE && s <= MAX_FONT_SIZE) {
                setFontSize(s);
            }
            setPos(loadFloatPos());
        }, 350);
        return () => clearTimeout(timer);
    }, []);

    const dragRef = useRef<{
        pointerId: number | null;
        active: boolean;
        startX: number;
        startY: number;
        origX: number;
        origY: number;
        moved: boolean;
    }>({
        pointerId: null,
        active: false,
        startX: 0,
        startY: 0,
        origX: 0,
        origY: 0,
        moved: false,
    });

    const clampPos = useCallback((x: number, y: number) => {
        const el = floatRef.current;
        const parent = el?.closest("[data-ui='phone-screen']") as HTMLElement | null;
        if (!el || !parent) return { x, y };
        const pw = parent.clientWidth;
        const ph = parent.clientHeight;
        const ew = el.offsetWidth;
        const eh = el.offsetHeight;
        return {
            x: Math.max(4, Math.min(x, Math.max(4, pw - ew - 4))),
            y: Math.max(4, Math.min(y, Math.max(4, ph - eh - 4))),
        };
    }, []);

    // Collapse to 2-line lyrics when clicking anywhere outside the floating window
    useEffect(() => {
        if (!expanded) return;
        const handleOutsideDown = (e: PointerEvent) => {
            const el = floatRef.current;
            if (!el) return;
            if (!el.contains(e.target as Node)) {
                setExpanded(false);
                setShowSettings(false);
            }
        };
        document.addEventListener("pointerdown", handleOutsideDown, true);
        return () => document.removeEventListener("pointerdown", handleOutsideDown, true);
    }, [expanded]);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        if (locked) return;
        const target = e.target as HTMLElement;
        if (target.closest("button")) return;
        e.preventDefault();
        e.stopPropagation();
        floatRef.current?.setPointerCapture?.(e.pointerId);
        dragRef.current = {
            pointerId: e.pointerId,
            active: true,
            startX: e.clientX,
            startY: e.clientY,
            origX: pos.x,
            origY: pos.y,
            moved: false,
        };
    }, [locked, pos]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.abs(dx) > DRAG_START_THRESHOLD || Math.abs(dy) > DRAG_START_THRESHOLD) {
            d.moved = true;
        }
        if (d.moved) {
            setPos(clampPos(d.origX + dx, d.origY + dy));
        }
    }, [clampPos]);

    /** 落位并记住：下次打开桌面歌词还在这个位置 */
    const commitPos = useCallback((next: { x: number; y: number }) => {
        setPos(next);
        try { kvSet(FLOAT_POS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    }, []);

    const finishPointer = useCallback((e: React.PointerEvent) => {
        const d = dragRef.current;
        if (!d.active || d.pointerId !== e.pointerId) return;
        if (floatRef.current?.hasPointerCapture?.(e.pointerId)) {
            floatRef.current.releasePointerCapture(e.pointerId);
        }
        d.active = false;
        d.pointerId = null;

        if (d.moved) {
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            commitPos(clampPos(d.origX + dx, d.origY + dy));
            return;
        }

        if (!locked) {
            // 点一下歌词 = 展开完整悬浮窗；再点一下 = 收起，只留两行歌词
            setExpanded(prev => {
                const next = !prev;
                if (!next) setShowSettings(false);
                // 展开 / 收起都会改高度，位置得重新夹一次别越界
                requestAnimationFrame(() => setPos(p => clampPos(p.x, p.y)));
                return next;
            });
        }
    }, [clampPos, commitPos, locked]);

    const handleLockClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setLocked(true);
        setExpanded(false);
        setShowSettings(false);
    }, []);

    const handleSelectColor = useCallback((color: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setLyricColor(color);
        try { kvSet(FLOAT_COLOR_KEY, color); } catch { /* ignore */ }
    }, []);

    const handleChangeFontSize = useCallback((delta: number, e: React.MouseEvent) => {
        e.stopPropagation();
        setFontSize(prev => {
            const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, prev + delta));
            try { kvSet(FLOAT_SIZE_KEY, String(next)); } catch { /* ignore */ }
            requestAnimationFrame(() => setPos(p => clampPos(p.x, p.y)));
            return next;
        });
    }, [clampPos]);

    // Unlock when desktop lyrics is toggled off and back on from the player
    const floatDismissed = player?.floatDismissed;
    useEffect(() => {
        if (floatDismissed) {
            setLocked(false);
            setExpanded(false);
            setShowSettings(false);
        }
    }, [floatDismissed]);

    const lyrics = useMemo(() => parseLyrics(player?.currentTrack?.lyrics || ""), [player?.currentTrack?.lyrics]);

    // ── 长句左右滑动 ──
    // 一句歌词比悬浮窗还宽时，让它跟着播放进度横向挪，唱到哪儿看哪儿。
    // 这里先单独算一次「当前是哪句」，只是因为 hooks 不能写在下面那个提前 return 之后。
    const measureTime = player?.currentTime ?? 0;
    let measureIdx = -1;
    for (let i = lyrics.length - 1; i >= 0; i--) {
        if (measureTime >= lyrics[i].time) { measureIdx = i; break; }
    }
    const activeMeasureText = lyrics.length > 0
        ? (lyrics[measureIdx >= 0 ? measureIdx : 0]?.text || "")
        : "";
    const activeLineRef = useRef<HTMLSpanElement>(null);
    /** 当前行那个裁切盒：量「文字多宽」和「盒子多宽」都拿它当基准 */
    const activeLineWrapRef = useRef<HTMLDivElement>(null);
    /** 这一句比可视宽度多出多少像素；0 表示不用挪 */
    const [lineOverflow, setLineOverflow] = useState(0);

    useEffect(() => {
        const span = activeLineRef.current;
        const wrap = activeLineWrapRef.current;
        if (!span || !wrap) { setLineOverflow(0); return; }
        // 文字整行不裁（scrollWidth 是全长），由外层盒子负责裁——
        // 这样给文字加位移时，露出来的才是「下一段字」而不是空白
        const overflow = Math.max(0, Math.ceil(span.scrollWidth - wrap.clientWidth));
        setLineOverflow(prev => (prev === overflow ? prev : overflow));
    }, [activeMeasureText, fontSize, expanded, lyricColor]);

    if (!player || !player.currentTrack || hidden || player.floatDismissed) return null;

    const currentTime = player.currentTime;
    const duration = player.duration;

    let activeIdx = -1;
    for (let i = lyrics.length - 1; i >= 0; i--) {
        if (currentTime >= lyrics[i].time) {
            activeIdx = i;
            break;
        }
    }

    const hasLyrics = lyrics.length > 0;
    const currentLine = hasLyrics
        ? (activeIdx >= 0 ? lyrics[activeIdx] : lyrics[0])
        : null;
    const nextLine = hasLyrics
        ? (activeIdx >= 0 ? lyrics[activeIdx + 1] ?? null : lyrics[1] ?? null)
        : null;

    let lineProgress = 0;
    if (currentLine) {
        if (activeIdx < 0) {
            lineProgress = 0;
        } else {
            const startTime = currentLine.time;
            const endTime = nextLine
                ? nextLine.time
                : (duration > startTime ? duration : startTime + 5);
            const span = Math.max(0.2, endTime - startTime);
            lineProgress = Math.max(0, Math.min(1, (currentTime - startTime) / span));
        }
    }

    // Dynamic width adapts to font size, capped by CSS max-width: calc(100% - 16px)
    const computedWidth = Math.min(382, Math.max(280, Math.round(300 + (fontSize - DEFAULT_FONT_SIZE) * 14)));
    const nextFontSize = Math.max(10, fontSize - 2);

    return (
        <div
            ref={floatRef}
            className="music-float-lyrics"
            {...(expanded && !locked ? { "data-expanded": "" } : {})}
            {...(locked ? { "data-locked": "" } : {})}
            style={{
                left: pos.x,
                top: pos.y,
                width: `${computedWidth}px`,
                "--float-lyric-color": lyricColor,
                "--float-lyric-size": `${fontSize}px`,
                "--float-lyric-next-size": `${nextFontSize}px`,
            } as React.CSSProperties}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointer}
            onPointerCancel={finishPointer}
        >
            {expanded && !locked && (
                <>
                    <button
                        type="button"
                        className="music-float-corner-btn music-float-open-player"
                        onClick={(e) => {
                            e.stopPropagation();
                            setExpanded(false);
                            setShowSettings(false);
                            player.openFullPlayer();
                        }}
                        title="打开音乐播放页"
                        aria-label="打开音乐播放页"
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M9 18V5l12-2v13" />
                            <circle cx="6" cy="18" r="3" />
                            <circle cx="18" cy="16" r="3" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        className="music-float-corner-btn music-float-close"
                        onClick={(e) => {
                            e.stopPropagation();
                            setExpanded(false);
                            setShowSettings(false);
                            player.dismissFloat();
                        }}
                        title="关闭桌面歌词"
                        aria-label="关闭桌面歌词"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </>
            )}

            <div className="music-float-lines">
                {hasLyrics ? (
                    <>
                        <div
                            className="music-float-line music-float-line-active"
                            ref={activeLineWrapRef}
                            // 长句要跟着唱的位置挪：这时必须左对齐从头排，
                            // 否则居中排会让超出部分从左边溢出去，第一个字直接看不见
                            style={lineOverflow > 0 ? { textAlign: "left" } : undefined}
                        >
                            <span
                                ref={activeLineRef}
                                className="music-float-line-fill"
                                style={{
                                    "--lyric-progress": `${(lineProgress * 100).toFixed(1)}%`,
                                    // 这句放不下就按播放进度往左挪：唱到最后一个字刚好挪到底
                                    transform: lineOverflow > 0
                                        ? `translateX(${-Math.round(lineOverflow * Math.max(0, Math.min(1, lineProgress)))}px)`
                                        : undefined,
                                } as React.CSSProperties}
                            >
                                {currentLine?.text || " "}
                            </span>
                        </div>
                        <div className="music-float-line music-float-line-next">
                            {nextLine?.text || "\u00A0"}
                        </div>
                    </>
                ) : (
                    <div className="music-float-line music-float-line-empty">
                        暂无歌词
                    </div>
                )}
            </div>

            {expanded && !locked && (
                <>
                    <div className="music-float-bar">
                        {/* Unlock / Lock SVG button (leftmost) */}
                        <button
                            type="button"
                            className="music-float-ctrl-btn"
                            onClick={handleLockClick}
                            title="锁定桌面歌词"
                            aria-label="锁定桌面歌词"
                        >
                            {locked ? (
                                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="5" y="11" width="14" height="10" rx="2" />
                                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                                </svg>
                            ) : (
                                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="5" y="11" width="14" height="10" rx="2" />
                                    <path d="M8 11V7a4 4 0 0 1 7.75-1.3" />
                                </svg>
                            )}
                        </button>

                        {/* Prev */}
                        <button
                            type="button"
                            className="music-float-ctrl-btn"
                            onClick={(e) => { e.stopPropagation(); player.prev(); }}
                            title="上一首"
                            aria-label="上一首"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                            </svg>
                        </button>

                        {/* Play / Pause (larger icon with circular ring) */}
                        <button
                            type="button"
                            className="music-float-ctrl-btn music-float-ctrl-play"
                            onClick={(e) => { e.stopPropagation(); player.togglePlay(); }}
                            title={player.isPlaying ? "暂停" : "播放"}
                            aria-label={player.isPlaying ? "暂停" : "播放"}
                        >
                            {player.isPlaying ? (
                                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
                                </svg>
                            ) : (
                                <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M8 5v14l11-7z" />
                                </svg>
                            )}
                        </button>

                        {/* Next */}
                        <button
                            type="button"
                            className="music-float-ctrl-btn"
                            onClick={(e) => { e.stopPropagation(); player.next(); }}
                            title="下一首"
                            aria-label="下一首"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z" />
                            </svg>
                        </button>

                        {/* Settings (rightmost) */}
                        <button
                            type="button"
                            className="music-float-ctrl-btn"
                            {...(showSettings ? { "data-active": "" } : {})}
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowSettings(prev => {
                                    const next = !prev;
                                    requestAnimationFrame(() => setPos(p => clampPos(p.x, p.y)));
                                    return next;
                                });
                            }}
                            title="歌词设置"
                            aria-label="歌词设置"
                        >
                            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="3" />
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                        </button>
                    </div>

                    {showSettings && (
                        <div className="music-float-settings-row" onClick={e => e.stopPropagation()}>
                            <div className="music-float-swatches">
                                {MORANDI_COLORS.map(c => (
                                    <button
                                        key={c.id}
                                        type="button"
                                        className="music-float-swatch"
                                        {...(lyricColor.toLowerCase() === c.value.toLowerCase() ? { "data-selected": "" } : {})}
                                        style={{ backgroundColor: c.value }}
                                        onClick={(e) => handleSelectColor(c.value, e)}
                                        title={c.label}
                                        aria-label={c.label}
                                    />
                                ))}
                            </div>
                            <div className="music-float-size-btns">
                                <button
                                    type="button"
                                    className="music-float-size-btn"
                                    disabled={fontSize <= MIN_FONT_SIZE}
                                    onClick={(e) => handleChangeFontSize(-1, e)}
                                    title="减小字号"
                                >
                                    A-
                                </button>
                                <button
                                    type="button"
                                    className="music-float-size-btn"
                                    disabled={fontSize >= MAX_FONT_SIZE}
                                    onClick={(e) => handleChangeFontSize(1, e)}
                                    title="增大字号"
                                >
                                    A+
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
