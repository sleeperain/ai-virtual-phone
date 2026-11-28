"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getThemeAssetMap } from "@/lib/theme-storage";

/* ══════════════════════════════════════════
   锁屏（参考 iOS）

   「外观 → 开屏动画」里关掉原生开屏动画后，启动时先落在这一屏：
   第一行居中「6月8日周五」，第二行居中大字时间，底部上滑解锁。
   壁纸取主题里的 lockWallpaperAssetId，没设就用默认渐变底。
   ══════════════════════════════════════════ */

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** 6月8日周五（不补零，和中文习惯一致） */
export function formatLockDate(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日周${WEEKDAYS[date.getDay()]}`;
}

/** 09:05 */
export function formatLockTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** 上滑多少像素算解锁成功 */
const UNLOCK_DISTANCE = 96;
/** 退场动画时长，须与 .lock-screen 的 transition 对齐 */
const LEAVE_DURATION = 330;

export function LockScreen({
  wallpaperAssetId,
  onUnlock,
}: {
  wallpaperAssetId?: string | null;
  onUnlock: () => void;
}) {
  const [now, setNow] = useState<Date>(() => new Date());
  const [wallpaper, setWallpaper] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  const dragStartY = useRef<number | null>(null);
  const unlockedRef = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ── 时间：每秒走一次；后台被节流后切回前台立刻校准 ──
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = window.setInterval(tick, 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // ── 锁屏壁纸 ──
  useEffect(() => {
    if (!wallpaperAssetId) {
      setWallpaper(null);
      return;
    }
    let cancelled = false;
    getThemeAssetMap([wallpaperAssetId])
      .then((map) => {
        if (!cancelled) setWallpaper(map[wallpaperAssetId] ?? null);
      })
      .catch(() => {
        if (!cancelled) setWallpaper(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wallpaperAssetId]);

  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  const unlock = useCallback(() => {
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    setLeaving(true);
    setDragY(-window.innerHeight);
    leaveTimer.current = setTimeout(onUnlock, LEAVE_DURATION);
  }, [onUnlock]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (leaving || unlockedRef.current) return;
    dragStartY.current = event.clientY;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 老浏览器/合成事件没有 pointer capture，忽略即可
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartY.current === null || leaving || unlockedRef.current) return;
    const delta = event.clientY - dragStartY.current;
    // 往上跟手；往下给一点回弹阻尼，不做整屏下拉
    setDragY(delta < 0 ? delta : delta * 0.16);
    if (delta < -12) setHintDismissed(true);
  };

  const handlePointerEnd = () => {
    if (dragStartY.current === null || leaving) return;
    dragStartY.current = null;
    if (dragY <= -UNLOCK_DISTANCE) {
      unlock();
      return;
    }
    setDragY(0);
    setHintDismissed(false);
  };

  const lift = Math.max(0, -dragY);

  return (
    <div
      className="lock-screen"
      data-leaving={leaving ? "1" : undefined}
      style={wallpaper ? { backgroundImage: `url("${wallpaper}")` } : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <div className="lock-screen-scrim" aria-hidden />

      <div
        className="lock-screen-content"
        style={{
          transform: `translate3d(0, ${dragY}px, 0)`,
          // 跟手时整体略微淡出，松手回弹由 transition 接管
          opacity: Math.max(0, 1 - lift / 420),
          transition: dragStartY.current === null ? "transform 0.34s cubic-bezier(0.32,0.72,0,1), opacity 0.34s ease" : "none",
        }}
      >
        <div className="lock-screen-date">{formatLockDate(now)}</div>
        <div className="lock-screen-time">{formatLockTime(now)}</div>
      </div>

      <div className="lock-screen-bottom" style={{ opacity: Math.max(0, 1 - lift / 140) }}>
        <div className={hintDismissed ? "lock-screen-hint lock-screen-hint-hidden" : "lock-screen-hint"}>
          上滑解锁
        </div>
        <button
          type="button"
          className="lock-screen-grabber"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={unlock}
          aria-label="上滑解锁"
        />
      </div>
    </div>
  );
}
