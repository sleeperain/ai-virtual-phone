"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getThemeAssetMap } from "@/lib/theme-storage";
import { PhoneStatusBar } from "@/components/phone-status-bar";
import { LargeTimeDisplay } from "@/components/widgets/large-time-display";
import { LockWidgetArea } from "@/components/lock-widgets";

/* ══════════════════════════════════════════
   锁屏（参考 iOS）

   「外观 → 开屏动画」里关掉原生开屏动画后，启动时先落在这一屏：
   第一行居中「6月8日周五」，第二行居中大字时间，底部上滑解锁。
   壁纸取主题里的 lockWallpaperAssetId，没设就用默认渐变底。
   ══════════════════════════════════════════ */

/** 上滑多少像素算解锁成功（比原来 96 短一点，手机上更好触发） */
const UNLOCK_DISTANCE = 72;

export function LockScreen({
  wallpaperAssetId,
  onUnlock,
}: {
  wallpaperAssetId?: string | null;
  onUnlock: () => void;
}) {
  const [now, setNow] = useState<Date>(() => new Date());
  const [wallpaper, setWallpaper] = useState<string | null>(null);
  // 壁纸解码完成才允许它淡入：src 一设就 opacity 过渡，图还没解码完会先空一下再蹦出来
  const [wallpaperReady, setWallpaperReady] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  const dragStartY = useRef<number | null>(null);
  const unlockedRef = useRef(false);
  // 正在编辑锁屏组件：此时整屏不响应上滑解锁，免得摆弄组件时把屏幕滑走
  const [widgetEditing, setWidgetEditing] = useState(false);

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
    setWallpaperReady(false);
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

  const unlock = useCallback(() => {
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    setLeaving(true);
    // 不再把内容单独甩走（setDragY(-innerHeight)），否则时间和日期会先飞出去。
    // 现在只标记 leaving，由整层做「小幅上移 + 淡出」，帘子在外面同步淡出。
    onUnlock();
  }, [onUnlock]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (leaving || unlockedRef.current || widgetEditing) return;
    dragStartY.current = event.clientY;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 老浏览器/合成事件没有 pointer capture，忽略即可
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartY.current === null || leaving || unlockedRef.current || widgetEditing) return;
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
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      {/* 壁纸单独一层：解码完再淡入，不会在加载完成的那一刻"蹦"出来 */}
      {wallpaper ? (
        <img
          className="lock-screen-wallpaper"
          src={wallpaper}
          alt=""
          draggable={false}
          data-ready={wallpaperReady ? "1" : undefined}
          onLoad={() => {
            // 等一帧再切，确保浏览器已经画过 opacity:0 那帧，过渡才会真的跑起来
            requestAnimationFrame(() => setWallpaperReady(true));
          }}
        />
      ) : null}

      <div className="lock-screen-scrim" aria-hidden />

      {/* 顶部状态栏：跟桌面同一套（时间/信号/WiFi/电池），深色底上转白字 */}
      <PhoneStatusBar tone="light" />

      <div
        className="lock-screen-content"
        style={{
          transform: `translate3d(0, ${dragY}px, 0)`,
          // 跟手时整体略微淡出，松手回弹由 transition 接管
          opacity: Math.max(0, 1 - lift / 420),
          transition: dragStartY.current === null ? "transform 0.34s cubic-bezier(0.32,0.72,0,1), opacity 0.34s ease" : "none",
        }}
      >
        {/* 复用桌面「极简大号时间」组件的排板，variant="lock" 换成白色大字。
            时间由本组件下发，两个定时器合成一个。 */}
        <LargeTimeDisplay variant="lock" date={now} />
      </div>

      {/* 组件区：长按进入编辑态，「取消」退出、「添加」打开选择器 */}
      <LockWidgetArea onEditingChange={setWidgetEditing} />

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
