"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";

import { AccountGate } from "@/components/auth/account-gate";
import { CloudBackupScheduler } from "@/components/cloud-backup-scheduler";
import { RealityBridgeScheduler } from "@/components/reality-bridge-scheduler";
import { MediaMaintenanceScheduler } from "@/components/media-maintenance-scheduler";
import { DesktopShell } from "./desktop-shell";
import { OfflinePushRevampAnnouncement } from "./offline-push-revamp-announcement";
import { SplashAnimation } from "./splash-animation";
import { LockScreen } from "./lock-screen";
import { LocalErrorBoundary } from "@/components/ui/local-error-boundary";
import { MusicProvider } from "@/lib/music-context";
import { hydrateKvDb, isKvHydrated } from "@/lib/kv-db";
import { getThemeAssetMap, readThemeProfile } from "@/lib/theme-storage";
import { resolveActiveIconSkins, type ThemeProfile } from "@/lib/theme-types";
import { hasPendingMcpOAuthCallback } from "@/lib/tool-executor";
import { readLockPasscode } from "@/lib/lock-passcode";
import { shouldRequestPwaFullscreen } from "@/lib/pwa-display-mode";

const TEXT = {
  loading: "\u52A0\u8F7D\u4E2D...",
};

/** 启动帘子淡出时长（ms），须与 .boot-curtain[data-leaving] 的 transition 对齐 */
const BOOT_EXIT_DURATION = 340;
/**
 * 揭幕前给渲染留的缓冲（ms）。
 * 桌面和锁屏是一起挂载的，桌面那一坨初始化很重；如果锁屏在同一帧直接亮相，
 * 首帧就要跟桌面的重活抢时间，看着就是"卡一下才出来"。
 * 这段等待里底下已经把活干完了，揭幕时只是把 Loading 淡掉。
 */
const BOOT_SETTLE_MS = 400;
/** 进度条补满后停留的时长（ms），让"加载完成"这件事看得见 */
const BOOT_DONE_HOLD_MS = 180;

const BUILTIN_FONT_URLS = [
  "/fonts/huiwen.woff2",
  "/fonts/huiwen.woff2",
  "/fonts/special-elite.woff2",
  "/fonts/splash/instrument-serif-regular-400.woff2",
  "/fonts/splash/instrument-serif-italic-400.woff2",
  "/fonts/splash/inter-300.woff2",
  "/fonts/splash/inter-400.woff2",
  "/fonts/splash/inter-500.woff2",
  "/fonts/splash/major-mono-display-400.woff2",
  "/fonts/splash/jetbrains-mono-300.woff2",
  "/fonts/splash/jetbrains-mono-400.woff2",
  "/fonts/interview/noto-serif-sc.woff2",
  "/fonts/interview/bodoni-moda.woff2",
  "/fonts/interview/bodoni-moda-italic.woff2",
  "/fonts/interview/eb-garamond.woff2",
  "/fonts/interview/eb-garamond-italic.woff2",
  "/fonts/interview/long-cang.woff2",
  "/fonts/interview/cinzel.woff2",
  "/fonts/interview/press-start-2p.woff2",
  "/fonts/notewall/ximai.woff2",
  "/fonts/notewall/xiaozhitiao.woff2",
  "/fonts/notewall/huiwen-upload.woff2",
  "/fonts/notewall/chen-yuluoyan-thin.woff2",
  "/fonts/game-hall/fredoka-400.woff2",
  "/fonts/game-hall/fredoka-500.woff2",
  "/fonts/game-hall/fredoka-600.woff2",
  "/fonts/game-hall/fredoka-700.woff2",
  "/fonts/game-hall/caveat-500.woff2",
  "/fonts/game-hall/caveat-700.woff2",
  "/fonts/game-hall/zen-maru-gothic-500.woff2",
  "/fonts/game-hall/zen-maru-gothic-700.woff2",
  "/fonts/game-hall/zen-maru-gothic-900.woff2",
  "/fonts/\u5B57\u4F53/MISANS-REGULAR.woff2",
  "/fonts/\u5B57\u4F53/MISANS-MEDIUM.woff2",
  "/fonts/\u5B57\u4F53/MISANS-SEMIBOLD.woff2",
] as const;

const BUILTIN_FONT_LOAD_SPECS = [
  '400 1em "Instrument Serif"',
  'italic 400 1em "Instrument Serif"',
  '300 1em "Inter"',
  '400 1em "Inter"',
  '500 1em "Inter"',
  '400 1em "Major Mono Display"',
  '300 1em "JetBrains Mono"',
  '400 1em "JetBrains Mono"',
  '400 1em "Huiwen"',
  '400 1em "Noto Serif SC"',
  '400 1em "Source Han Serif SC"',
  '400 1em "Bodoni Moda"',
  'italic 400 1em "Bodoni Moda"',
  '400 1em "EB Garamond"',
  'italic 400 1em "EB Garamond"',
  '400 1em "Long Cang"',
  '400 1em "Cinzel"',
  '400 1em "Press Start 2P"',
  '400 1em "Special Elite"',
  '400 1em "NoteWall Ximai"',
  '400 1em "NoteWall Xiaozhitiao"',
  '400 1em "NoteWall Huiwen"',
  '400 1em "Game Hall Fredoka"',
  '500 1em "Game Hall Fredoka"',
  '600 1em "Game Hall Fredoka"',
  '700 1em "Game Hall Fredoka"',
  '500 1em "Game Hall Caveat"',
  '700 1em "Game Hall Caveat"',
  '500 1em "Game Hall Zen Maru Gothic"',
  '700 1em "Game Hall Zen Maru Gothic"',
  '900 1em "Game Hall Zen Maru Gothic"',
  '400 1em "MiSans"',
  '500 1em "MiSans"',
  '600 1em "MiSans"',
] as const;

const FONT_CACHE_BATCH_SIZE = 3;
const FONT_CACHE_BATCH_DELAY_MS = 80;

type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleIdleTask(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => { };
  }

  const idleWindow = window as WindowWithIdleCallback;
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(() => callback(), { timeout: 2400 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(callback, 600);
  return () => window.clearTimeout(handle);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function cacheFontUrl(url: string): Promise<void> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) return;
  await response.arrayBuffer();
}

async function warmBuiltinFonts(shouldStop: () => boolean): Promise<void> {
  if (typeof window === "undefined") return;

  for (let index = 0; index < BUILTIN_FONT_URLS.length; index += FONT_CACHE_BATCH_SIZE) {
    if (shouldStop()) return;
    const batch = BUILTIN_FONT_URLS.slice(index, index + FONT_CACHE_BATCH_SIZE);
    await Promise.all(batch.map((url) => cacheFontUrl(url).catch(() => undefined)));
    if (shouldStop()) return;
    await wait(FONT_CACHE_BATCH_DELAY_MS);
  }

  if (shouldStop() || !document.fonts) return;
  await Promise.all(BUILTIN_FONT_LOAD_SPECS.map((spec) => document.fonts.load(spec).catch(() => [])));
}

function SplashScreen({ ready = false, onEnter }: { ready?: boolean; onEnter?: () => void }) {
  return (
    <main className="app-root splash-root">
      <section
        className="phone-shell-wrap splash-shell-wrap"
        aria-label={TEXT.loading}
      >
        <div className="phone-case">
          <div className="phone-frame">
            <div className="phone-shell splash-phone-screen">
              <SplashAnimation />
              <button
                type="button"
                className={ready ? "splash-enter-button splash-enter-button-show" : "splash-enter-button"}
                onClick={onEnter}
                disabled={!ready}
                aria-label="Enter"
              >
                <ArrowRight size={18} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

/**
 * Loading 文案 + 进度条。
 *
 * 进度是**估算**的：真正要做的事（IndexedDB 水合、主题资源预加载、桌面挂载）
 * 没有可靠的百分比回调，与其编一个假的实时进度，不如做成一条
 * "先快后慢、永远差一点点"的动画，最后在真正就绪时走满。
 * 规律是渐进加载里常见的那套：越是接近完成越慢，不会走到 100% 卡住干等。
 */
function BootLoadingContent({ done = false }: { done?: boolean }) {
  return (
    <div className="boot-loading-content" data-done={done ? "1" : undefined}>
      <span className="boot-loading-text">Loading...</span>
      <div className="boot-loading-bar" role="progressbar" aria-label={TEXT.loading}>
        <div className="boot-loading-bar-fill" />
      </div>
    </div>
  );
}

/**
 * 揭幕遮罩：盖在已经挂载好、正在首帧渲染的锁屏/动画上面。
 *
 * 为什么要有它：桌面和锁屏是同一次提交里挂上来的，锁屏首帧要和桌面那坨初始化
 * 抢同一帧。让锁屏一边渲染一边露面，看到的就是"卡一下才出来"。
 * 这层不透明底把那段遮掉，等底下渲染稳了再淡出——观感是 Loading 之后画面直接出现。
 *
 * 它本身极轻：纯色底 + 一行字 + 一条进度条，没有图片、没有模糊。
 */
function BootLoadingMask({ done = false }: { done?: boolean }) {
  return (
    <div className="boot-loading-mask" aria-live="polite">
      <BootLoadingContent done={done} />
    </div>
  );
}

/**
 * 锁屏那一屏：外壳、机身边框和开屏动画共用同一套，只有里面的内容换成锁屏。
 */
function LockScreenView({
  wallpaperAssetId,
  onUnlock,
}: {
  wallpaperAssetId: string | null;
  onUnlock: () => void;
}) {
  return (
    <main className="app-root splash-root">
      <section className="phone-shell-wrap splash-shell-wrap" aria-label="锁屏">
        <div className="phone-case">
          <div className="phone-frame">
            <div className="phone-shell splash-phone-screen lock-phone-screen">
              <LockScreen wallpaperAssetId={wallpaperAssetId} onUnlock={onUnlock} />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

type PreparedDesktopTheme = {
  profile: ThemeProfile;
  assets: Record<string, string>;
};

function collectFirstPaintThemeAssetIds(profile: ThemeProfile): string[] {
  const ids = [
    profile.wallpaperAssetId,
    profile.fontAssetId,
    profile.dockSkinAssetId,
    ...Object.values(resolveActiveIconSkins(profile))
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(ids));
}

function preloadImageDataUrl(url: string): Promise<void> {
  if (typeof window === "undefined" || !url.startsWith("data:image/")) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const image = new Image();
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (typeof image.decode === "function") {
        void image.decode().catch(() => undefined).finally(resolve);
        return;
      }
      resolve();
    };
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
    if (image.complete) {
      finish();
    }
  });
}

async function prepareDesktopThemeForFirstPaint(): Promise<PreparedDesktopTheme> {
  const profile = readThemeProfile();
  const assetIds = collectFirstPaintThemeAssetIds(profile);
  const assets = assetIds.length ? await getThemeAssetMap(assetIds) : {};
  await Promise.all(Object.values(assets).map(preloadImageDataUrl));
  return { profile, assets };
}

export function MainApp() {
  const [preparedDesktopTheme, setPreparedDesktopTheme] = useState<PreparedDesktopTheme | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [splashDismissed, setSplashDismissed] = useState(false);
  const [kvHydrateFailed, setKvHydrateFailed] = useState(false);
  const [initAttempt, setInitAttempt] = useState(0);
  // 开屏那一屏显示什么：pending = 配置还没读出来，animation = 开屏动画，lock = 锁屏。
  // 主题配置存在 IndexedDB 里，水合完成前 kvGet 只有空缓存、读出来永远是默认值，
  // 所以必须等水合完再定，否则「关掉开屏动画」只在当次会话生效、重开又播回动画。
  const [splashMode, setSplashMode] = useState<"pending" | "animation" | "lock">("pending");
  const [lockWallpaperAssetId, setLockWallpaperAssetId] = useState<string | null>(null);
  // 帘子正在淡出。解锁/进入时先淡出再卸载，避免瞬间硬切到桌面。
  const [bootLeaving, setBootLeaving] = useState(false);
  const bootExitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 桌面是否已经挂载（= 首屏主题预加载已有结果）。桌面内部 savedTheme / themeAssets
  // 只在首次挂载时读一次 props，所以必须等预加载有结果再挂，否则会先按默认值画一遍、
  // 资源到位后再"刷新"一次。
  const desktopMountedRef = useRef(false);
  const pendingBootDismissRef = useRef(false);
  // 启动遮罩是否还盖着：锁屏/开屏动画先挂载但藏在下面，等渲染稳了再揭幕
  const [revealReady, setRevealReady] = useState(false);
  // 进度条补满的那一小段（只在揭幕前一刻为真），让"完成"有收尾
  const [revealDone, setRevealDone] = useState(false);
  // 是否启用了锁屏密码。只有"锁屏 + 有密码"这一种情况值得等 Loading：
  // 它下面要挂密码盘、桌面，首帧压力最大；开屏动画本身就是等待的视觉替代，
  // 没密码的锁屏也很轻，都不需要再挡一层。
  const [passcodeEnabled, setPasscodeEnabled] = useState(false);

  const dismissBoot = useCallback(() => {
    // 桌面还没挂好就先记下，等挂好再淡出，避免帘子揭开时底下是空的
    if (!desktopMountedRef.current) {
      pendingBootDismissRef.current = true;
      return;
    }
    setBootLeaving(true);
    clearTimeout(bootExitTimer.current);
    // 时长与 .boot-curtain[data-leaving] 的 transition 对齐
    bootExitTimer.current = setTimeout(() => setSplashDismissed(true), BOOT_EXIT_DURATION);
  }, []);

  useEffect(() => () => clearTimeout(bootExitTimer.current), []);

  /** 「锁屏 + 启用密码」才需要 Loading 挡首帧，其它情况直接显示 */
  const bootGateActive = splashMode === "lock" && passcodeEnabled;
  const showBootLoading = splashMode === "pending" || (bootGateActive && !revealReady);

  useEffect(() => {
    desktopMountedRef.current = hydrated;
    if (hydrated && pendingBootDismissRef.current) {
      pendingBootDismissRef.current = false;
      dismissBoot();
    }
  }, [hydrated, dismissBoot]);

  // 揭幕时机：等桌面和锁屏都挂上、并且浏览器把首帧画完之后再揭开。
  // 两次 rAF 确保提交已绘制，再留 BOOT_SETTLE_MS 给重布局与合成收尾。
  // 只有「锁屏 + 启用密码」需要这一套：那种情况首帧最重，得拿 Loading 挡一下。
  // 开屏动画本身就是等待的视觉替代品，没密码的锁屏也很轻，都不必再挡。
  useEffect(() => {
    if (!hydrated || splashMode !== "lock" || !passcodeEnabled) return;
    let raf2 = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          // 先把进度补满，留 180ms 给人看清，再揭幕
          setRevealDone(true);
          timer = setTimeout(() => setRevealReady(true), BOOT_DONE_HOLD_MS);
        }, BOOT_SETTLE_MS);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      if (timer) clearTimeout(timer);
    };
  }, [hydrated, splashMode, passcodeEnabled]);

  useEffect(() => {
    let cancelled = false;

    // 申请持久化存储：批准后 iOS/安卓不会再因存储压力擅自回收 IndexedDB
    // （摊主钥匙、聊天记录等都存在里面）。静默尽力而为，被拒也无碍。
    void navigator.storage?.persist?.().catch(() => {});

    void (async () => {
      await hydrateKvDb();
      if (cancelled) return;
      // 水合失败绝不放行：此时所有 KV 数据（设置/绑定/线下记录等）在内存里都是
      // 空的，进入后任何一次保存都会拿空数据整包覆盖 IndexedDB 里的真实历史。
      if (!isKvHydrated()) {
        setKvHydrateFailed(true);
        return;
      }
      setKvHydrateFailed(false);

      // 水合完成，主题配置才是真的：这时才决定开屏是播动画还是进锁屏。
      const bootProfile = readThemeProfile();
      setLockWallpaperAssetId(bootProfile.lockWallpaperAssetId);
      setSplashMode(bootProfile.splashAnimationEnabled ? "animation" : "lock");
      setPasscodeEnabled(readLockPasscode().enabled);

      let nextPreparedTheme: PreparedDesktopTheme | null = null;
      try {
        nextPreparedTheme = await prepareDesktopThemeForFirstPaint();
      } catch (error) {
        console.warn("[MainApp] desktop theme preload failed:", error);
      }

      if (cancelled) return;
      setPreparedDesktopTheme(nextPreparedTheme);
      setHydrated(true);
      if (hasPendingMcpOAuthCallback()) {
        // OAuth 回调要马上回到原页面，别让用户再点一次进入，但也走淡出
        dismissBoot();
      }
    })();

    // 安卓全屏兜底。是否请求全屏在每次点击时读取，设置切换后无需重载。
    const isMobile = window.matchMedia("(max-width: 500px) and (hover: none) and (pointer: coarse)").matches;
    if (!isMobile) return () => {
      cancelled = true;
    };

    function tryFullscreen() {
      if (!shouldRequestPwaFullscreen()) return;
      const doc = document.documentElement;
      if (document.fullscreenElement) return;
      doc.requestFullscreen?.().catch(() => { });
    }
    document.addEventListener("click", tryFullscreen);
    return () => {
      cancelled = true;
      document.removeEventListener("click", tryFullscreen);
    };
  }, [initAttempt, dismissBoot]);

  if (kvHydrateFailed) {
    return (
      <main className="app-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100dvh", padding: "0 28px", background: "#0c0c12", color: "#e8e8ef" }}>
        <div style={{ maxWidth: 340, textAlign: "center" }}>
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>本机数据暂时读取失败</div>
          <div style={{ fontSize: 13, lineHeight: 1.8, opacity: 0.75, marginBottom: 20 }}>
            浏览器的本地数据库（IndexedDB）没能打开。数据本身还在，为了避免在读不到数据的状态下继续使用把历史记录覆盖掉，应用先暂停进入。
            <br />可以先重试；仍然不行的话，试试关掉本站的其他标签页、重启浏览器，或确认没有开无痕/隐私模式。
          </div>
          <button
            type="button"
            onClick={() => { setKvHydrateFailed(false); setInitAttempt((n) => n + 1); }}
            style={{ padding: "10px 32px", borderRadius: 20, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 14, cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      </main>
    );
  }

  return (
    <AccountGate>
      {/* 桌面在启动阶段就挂到帘子（开屏动画 / 锁屏）下面：解锁只是把帘子拿走，
          不再有"上滑后现场挂载桌面、黑屏硬等"的空窗。

          但要等 hydrated（首屏主题预加载已有结果）再挂：DesktopShell 里的
          savedTheme / themeAssets 都是 useState 初始化，只在首次挂载时读一次 props。
          提前用 null 挂上去，会先按默认主题画一遍，等资源到位又整体换一次——
          表现就是"桌面已经能点了，过一会又刷新一下"。 */}
      {splashMode !== "pending" && hydrated ? (
        <main className="app-root">
          <MusicProvider>
            <LocalErrorBoundary
              label="桌面"
              hint="桌面在渲染时崩了，本地数据没有丢。可以点重试；反复出现就把控制台里的报错发给小坊。"
            >
              <DesktopShell
                initialThemeProfile={preparedDesktopTheme?.profile}
                initialThemeAssets={preparedDesktopTheme?.assets}
              />
            </LocalErrorBoundary>
            <OfflinePushRevampAnnouncement />
            <CloudBackupScheduler />
            <RealityBridgeScheduler />
            <MediaMaintenanceScheduler />
          </MusicProvider>
        </main>
      ) : null}

      {!splashDismissed ? (
        <div className="boot-curtain" data-leaving={bootLeaving ? "1" : undefined}>
          {splashMode !== "pending" ? (
            <div
              className="boot-reveal"
              data-ready={bootGateActive ? (revealReady ? "1" : undefined) : "1"}
            >
              {splashMode === "lock" ? (
                <LockScreenView
                  wallpaperAssetId={lockWallpaperAssetId}
                  onUnlock={dismissBoot}
                />
              ) : (
                <SplashScreen ready={hydrated} onEnter={dismissBoot} />
              )}
            </div>
          ) : null}

          {/* Loading 遮罩。
              只在这两种时候出现：配置还没读出来（pending）、
              或者「锁屏 + 启用密码」还没渲染稳。
              关键是它只挂载一次（同一个位置、同一个组件），
              进度条动画因此从头到尾只跑一遍 —— 之前在 pending 和揭幕两处各放了一份，
              切换时会看到进度条重走。 */}
          {showBootLoading ? <BootLoadingMask done={revealDone} /> : null}
        </div>
      ) : null}
    </AccountGate>
  );
}
