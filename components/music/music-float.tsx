// components/music/music-float.tsx — Floating desktop lyrics widget (draggable, expandable, lockable)
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMusicPlayerOptional } from "@/lib/music-context";

const DRAG_START_THRESHOLD = 5;

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
    const [pos, setPos] = useState({ x: 24, y: 120 });
    const [expanded, setExpanded] = useState(false);
    const [locked, setLocked] = useState(false);

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
            x: Math.max(4, Math.min(x, pw - ew - 4)),
            y: Math.max(4, Math.min(y, ph - eh - 4)),
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
            setPos(clampPos(d.origX + dx, d.origY + dy));
            return;
        }

        if (!locked) {
            setExpanded(true);
            requestAnimationFrame(() => setPos(p => clampPos(p.x, p.y)));
        }
    }, [clampPos, locked]);

    const handleLockClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setLocked(true);
        setExpanded(false);
    }, []);

    // Unlock when desktop lyrics is toggled off and back on from the player
    const floatDismissed = player?.floatDismissed;
    useEffect(() => {
        if (floatDismissed) {
            setLocked(false);
            setExpanded(false);
        }
    }, [floatDismissed]);

    const lyrics = useMemo(() => parseLyrics(player?.currentTrack?.lyrics || ""), [player?.currentTrack?.lyrics]);

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

    return (
        <div
            ref={floatRef}
            className="music-float-lyrics"
            {...(expanded && !locked ? { "data-expanded": "" } : {})}
            {...(locked ? { "data-locked": "" } : {})}
            style={{ left: pos.x, top: pos.y }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointer}
            onPointerCancel={finishPointer}
        >
            {expanded && !locked && (
                <button
                    type="button"
                    className="music-float-close"
                    onClick={(e) => {
                        e.stopPropagation();
                        setExpanded(false);
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
            )}

            <div className="music-float-lines">
                {hasLyrics ? (
                    <>
                        <div className="music-float-line music-float-line-active">
                            <span
                                className="music-float-line-fill"
                                style={{ "--lyric-progress": `${(lineProgress * 100).toFixed(1)}%` } as React.CSSProperties}
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
                <div className="music-float-bar">
                    {/* Unlock / Lock SVG button */}
                    <button
                        type="button"
                        className="music-float-ctrl-btn"
                        onClick={handleLockClick}
                        title="锁定桌面歌词"
                        aria-label="锁定桌面歌词"
                    >
                        {locked ? (
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="5" y="11" width="14" height="10" rx="2" />
                                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                            </svg>
                        ) : (
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                        </svg>
                    </button>

                    {/* Play / Pause */}
                    <button
                        type="button"
                        className="music-float-ctrl-btn music-float-ctrl-play"
                        onClick={(e) => { e.stopPropagation(); player.togglePlay(); }}
                        title={player.isPlaying ? "暂停" : "播放"}
                        aria-label={player.isPlaying ? "暂停" : "播放"}
                    >
                        {player.isPlaying ? (
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
                            </svg>
                        ) : (
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
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
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 18l8.5-6L6 6v12zm8.5 0h2V6h-2v12z" />
                        </svg>
                    </button>

                    {/* Settings (placeholder for future) */}
                    <button
                        type="button"
                        className="music-float-ctrl-btn"
                        onClick={(e) => { e.stopPropagation(); }}
                        title="设置"
                        aria-label="设置"
                    >
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                    </button>
                </div>
            )}
        </div>
    );
}
