"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getThemeAssetMap } from "@/lib/theme-storage";
import { PhoneStatusBar } from "@/components/phone-status-bar";
import { LockWidgetArea, type LockWidgetAreaHandle } from "@/components/lock-widgets";
import { LockPasscodePad } from "@/components/lock-passcode-pad";
import { readLockPasscode } from "@/lib/lock-passcode";

/* ══════════════════════════════════════════
   锁屏（参考 iOS）

   「外观 → 开屏动画」里关掉原生开屏动画后，启动时先落在这一屏。

   版面交给 LockWidgetArea：4 列 × 4 行的组件网格，从状态栏下方铺到屏幕中部。
   时间不是内置样式，而是默认放在网格最上面的一个「极简大号时间」组件（2×4）。
   底部上滑解锁；壁纸取主题里的 lockWallpaperAssetId，没设就用默认渐变底。
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
  const widgetApiRef = useRef<LockWidgetAreaHandle | null>(null);
  // 启用了锁屏密码：上滑先落到密码盘，输对才真正解锁
  const [passcodeActive, setPasscodeActive] = useState(false);
  const [padOpen, setPadOpen] = useState(false);
  const [padNotice, setPadNotice] = useState<string | null>(null);
  const padNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setPasscodeActive(readLockPasscode().enabled);
  }, []);

  useEffect(() => () => clearTimeout(padNoticeTimer.current), []);

  const showPadNotice = useCallback((text: string) => {
    clearTimeout(padNoticeTimer.current);
    setPadNotice(text);
    padNoticeTimer.current = setTimeout(() => setPadNotice(null), 2600);
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

  /** 真正放行：整层原地淡出（位置不动），帘子在外面同步淡出 */
  const finishUnlock = useCallback(() => {
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    setLeaving(true);
    onUnlock();
  }, [onUnlock]);

  /**
   * 上滑到位：启用了锁屏密码就先落到密码盘，否则直接解锁。
   * 密码盘打开时把跟手位移归零，免得组件区还停在半路上。
   */
  const requestUnlock = useCallback(() => {
    if (unlockedRef.current || leaving) return;
    if (passcodeActive) {
      setDragY(0);
      setHintDismissed(false);
      setPadOpen(true);
      return;
    }
    finishUnlock();
  }, [passcodeActive, finishUnlock, leaving]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (leaving || unlockedRef.current || widgetEditing || padOpen) return;
    dragStartY.current = event.clientY;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 老浏览器/合成事件没有 pointer capture，忽略即可
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartY.current === null || leaving || unlockedRef.current || widgetEditing || padOpen) return;
    const delta = event.clientY - dragStartY.current;
    // 往上跟手；往下给一点回弹阻尼，不做整屏下拉
    setDragY(delta < 0 ? delta : delta * 0.16);
    if (delta < -12) setHintDismissed(true);
  };

  const handlePointerEnd = () => {
    if (dragStartY.current === null || leaving) return;
    dragStartY.current = null;
    if (dragY <= -UNLOCK_DISTANCE) {
      requestUnlock();
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
            // 顺手把密码盘要用的低分辨率版本生成好，开密码盘时零等待
            if (wallpaper) makeBlurredCopy(wallpaper);
          }}
        />
      ) : null}

      <div className="lock-screen-scrim" aria-hidden />

      {/* 顶部状态栏：跟桌面同一套（时间/信号/WiFi/电池），深色底上转白字 */}
      <PhoneStatusBar tone="light" />

      {/* 组件区：从状态栏下方铺到屏幕中部，4 列 × 4 行。
          时间不再是内置样式，而是默认放在这里的一个「极简大号时间」组件；
          长按进入编辑态，「取消」退出、「添加」打开选择器。
          上滑时跟着手指轻微上移并淡出，给一点跟手反馈。 */}
      {/* 密码盘打开时把组件区藏起来：那一屏本来就不显示时间（时间本身就是一个组件）。
          用 opacity: 0 而不是 visibility: hidden —— 后者会让浏览器丢掉这一层的绘制缓存，
          关掉密码盘后要整层重绘，反而更卡；opacity 只是不画，缓存还在。 */}
      <div
        className="lock-widget-drag-layer"
        style={{
          transform: `translate3d(0, ${dragY * 0.5}px, 0)`,
          opacity: padOpen ? 0 : Math.max(0, 1 - lift / 320),
          pointerEvents: padOpen ? "none" : undefined,
        }}
      >
        <LockWidgetArea ref={widgetApiRef} onEditingChange={setWidgetEditing} />
      </div>

      {/* 编辑态工具栏：直接复用桌面「编辑桌面」的两个按钮类，
          位置和观感跟桌面完全一致（左上「添加」、右上「取消」） */}
      {widgetEditing && (
        <>
          <button
            type="button"
            className="edit-mode-edit"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => widgetApiRef.current?.openPicker()}
          >
            添加
          </button>
          <button
            type="button"
            className="edit-mode-done"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => widgetApiRef.current?.exitEditing()}
          >
            取消
          </button>
        </>
      )}

      {/* 编辑态时把「上滑解锁」藏起来：这时候不响应上滑，留着会误导 */}
      <div
        className="lock-screen-bottom"
        style={{ opacity: widgetEditing || padOpen ? 0 : Math.max(0, 1 - lift / 140) }}
      >
        <div className={hintDismissed ? "lock-screen-hint lock-screen-hint-hidden" : "lock-screen-hint"}>
          上滑解锁
        </div>
        <button
          type="button"
          className="lock-screen-grabber"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={requestUnlock}
          aria-label="上滑解锁"
        />
      </div>

      {/* 密码盘：背景完全交给 CSS 的半透明层，不加载任何图片。
          之前试过 filter: blur（现场栅格化大图）和预生成小图（放大要分配整屏纹理），
          两种都会在打开那一下产生一次性开销。纯色 + 透明度才是真正零成本的。 */}
      {padOpen && (
        <>
          {padNotice ? (
            <div className="lock-passcode-toast" role="status">{padNotice}</div>
          ) : null}
          <LockPasscodePad
            onUnlocked={finishUnlock}
            onNotice={showPadNotice}
          />
        </>
      )}
    </div>
  );
}
