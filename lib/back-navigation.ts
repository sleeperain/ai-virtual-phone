/**
 * 系统「返回」→ 应用内逐级返回
 *
 * 目标：不自己画手势条，直接复用浏览器 / PWA 的系统后退手势
 *（iOS Safari 左缘右滑、Android 手势导航的返回、桌面浏览器的后退键 / 鼠标侧键），
 * 让它在仿真手机里表现为「一层一层往回退」，退到桌面后再滑才是浏览器本来的后退。
 *
 * 做法：只要存在可退目标，就在 history 里压一条「哨兵」记录。用户的系统后退
 * 会消耗掉这条哨兵并触发 popstate，我们在 popstate 里按下面的优先级退一层，
 * 然后重建哨兵，保证下一次手势依然可用；可退目标消失时再把哨兵撤掉，
 * 恢复浏览器默认的后退行为。
 *
 * 退回优先级：
 *   1. 页面返回栈（PageShell 的 onBack、各 APP 自己注册的层级）—— 最上层优先
 *   2. 当前界面上可见的返回箭头（button.page-back-btn）—— 没主动注册的页面靠它兜底
 *   3. 桌面层（当前打开的 APP）—— 关闭 APP 回到桌面
 *
 * ── 两个曾经踩过的坑（改动时别再踩回去）──
 * 1. 「当前有没有哨兵」一律以 history.state 上的标记为准，不要只信内存里的布尔值。
 *    内存 flag 和真实历史一旦不同步（Safari 在 popstate 里同步 pushState 有概率丢），
 *    就会发生「脑子以为有哨兵、其实没有」——用户一滑就真的离开页面（大退）。
 * 2. popstate 里退完一层后，要等 React 把状态 commit 完再重建哨兵（scheduleSync 的 0ms 延迟）。
 *    同步重建时 React 状态还是旧的，hasBackTarget() 会误判为「还有目标」，
 *    于是压出一条多余的哨兵，之后只能靠 back() 去撤，又和「撤哨兵的 releasing 标记」互相打架。
 *    releasing 也必须有独立超时兜底，否则它一旦卡在 true，后面每一次手势都会被当成
 *    「自己撤哨兵引起的」而忽略，用户体验就是滑几次之后突然大退。
 */

export type BackLayerHandle = () => void;

type BackLayer = {
  id: number;
  handler: () => void;
};

type BackState = {
  /** 页面级返回栈，后压入的在上面 */
  layers: BackLayer[];
  nextId: number;
  /** 最底一层（当前打开的 APP），与 layers 分开存，保证它永远在栈底 */
  base: (() => void) | null;
  /** 正在主动 history.back() 撤哨兵，紧接着到来的那次 popstate 要忽略 */
  releasing: boolean;
};

const INSTALL_FLAG = "__aiVirtualPhoneBackNavInstalled";
const STATE_KEY = "__aiVirtualPhoneBackNavState";
const BACK_STATE_KEY = "__aiVirtualPhoneBack";
const DEBUG_FLAG = "__aiVirtualPhoneBackNavDebug";

/**
 * 没显式注册返回逻辑的页面靠这些选择器兜底。
 * 按顺序取第一个命中的：优先统一的 page-back-btn，其次是各 APP 自绘返回箭头时
 * 常用的 aria-label / data-ui 约定。
 */
const BACK_BUTTON_SELECTORS = [
  "button.page-back-btn",
  '[data-ui="back"]',
  'button[aria-label="返回"]',
  'button[aria-label="Back"]',
] as const;

/** 主动 history.back() 之后等 popstate 的兜底超时，防止 releasing 卡死 */
const RELEASING_TIMEOUT_MS = 1200;

let syncTimer = 0;
let releasingTimer = 0;

function getBackState(): BackState {
  const scope = window as unknown as Record<string, unknown>;
  const existing = scope[STATE_KEY] as BackState | undefined;
  if (existing && Array.isArray(existing.layers)) return existing;
  const fresh: BackState = { layers: [], nextId: 1, base: null, releasing: false };
  scope[STATE_KEY] = fresh;
  return fresh;
}

function debug(...args: unknown[]): void {
  const scope = window as unknown as Record<string, unknown>;
  if (!scope[DEBUG_FLAG]) return;
  console.debug("[back-navigation]", ...args);
}

function readHistoryState(): Record<string, unknown> {
  const raw = window.history.state;
  return raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
}

/** 真实历史里的当前项是不是我们压的哨兵（唯一真相） */
function hasSentinelInHistory(): boolean {
  return readHistoryState()[BACK_STATE_KEY] === true;
}

function isClickable(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) return false;
  // 被隐藏的页面（display:none / 未挂载）没有布局盒子，直接排除，避免点到后台页面的返回箭头
  if (element.getClientRects().length === 0) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return style.pointerEvents !== "none";
}

/** 在仿真手机屏幕内找最后一个可见的返回箭头（越晚渲染的页面越可能在最上层） */
function findVisibleBackButton(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const root = document.querySelector<HTMLElement>('[data-ui="phone-screen"]') ?? document.body;
  for (const selector of BACK_BUTTON_SELECTORS) {
    const buttons = Array.from(root.querySelectorAll<HTMLElement>(selector));
    for (let index = buttons.length - 1; index >= 0; index -= 1) {
      if (isClickable(buttons[index])) return buttons[index];
    }
  }
  return null;
}

function hasBackTarget(): boolean {
  const state = getBackState();
  if (state.layers.length > 0 || state.base) return true;
  return findVisibleBackButton() !== null;
}

function runHandler(handler: () => void): void {
  try {
    handler();
  } catch (error) {
    console.warn("[back-navigation] 返回处理器执行失败：", error);
  }
}

/** 有可退目标就把哨兵补上（幂等） */
function ensureSentinel(): void {
  const state = getBackState();
  if (state.releasing) return;
  if (hasSentinelInHistory()) return;
  if (!hasBackTarget()) return;
  window.history.pushState({ ...readHistoryState(), [BACK_STATE_KEY]: true }, "");
  debug("哨兵已压入");
}

/** 没有可退目标了就把哨兵撤掉，让系统后退回到浏览器默认行为 */
function dropSentinel(): void {
  const state = getBackState();
  if (state.releasing) return;
  if (!hasSentinelInHistory()) return;

  state.releasing = true;
  window.history.back();
  debug("撤哨兵");

  window.clearTimeout(releasingTimer);
  releasingTimer = window.setTimeout(() => {
    releasingTimer = 0;
    const current = getBackState();
    if (!current.releasing) return;
    current.releasing = false;
    // 超时说明那次 popstate 没来（或已被别处吃掉），重新对齐一次
    scheduleSync();
  }, RELEASING_TIMEOUT_MS);
}

function syncSentinel(): void {
  if (hasBackTarget()) ensureSentinel();
  else dropSentinel();
}

/**
 * 立刻对齐哨兵（同步执行）。
 * popstate 里退完一层必须用这个，不能用 scheduleSync：layers / base 是我们自己的
 * 模块级数据，popstate 那一刻就已经是最新值，不依赖 React 重渲染，所以同步补哨兵是安全的；
 * 而 setTimeout(0) 在系统后退手势收尾的时机里会被明显推迟甚至不执行，
 * 一旦没补上，用户下一次滑动就是浏览器真实后退 → 整页大退（现象：只能退两级）。
 */
function syncNow(): void {
  window.clearTimeout(syncTimer);
  syncTimer = 0;

  // 第一次立刻对齐：只依赖我们的模块级栈，保证哨兵绝不缺席（这是防大退的底线）
  syncSentinel();

  // 第二次延后再对齐：退完一层时 DOM 还停留在旧页面，上面的兜底选择器可能
  // 误判出「还有返回箭头」而多压一条哨兵。等 React 提交完再对一次，
  // 把可能多压的那条撤掉。两次都幂等，重复调用没有副作用。
  syncTimer = window.setTimeout(() => {
    syncTimer = 0;
    syncSentinel();
  }, 0);
}

/** 延后到 React commit 之后再对齐（供 effect 触发的场景用，react 状态可能还没提交） */
function scheduleSync(): void {
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = 0;
    syncSentinel();
  }, 0);
}

function handlePopState(): void {
  const state = getBackState();

  if (state.releasing) {
    // 这次后退是我们自己撤哨兵引起的，不是用户手势。
    // 但撤哨兵期间如果又有新的可退目标出现（比如刚好打开了 APP），
    // 补哨兵会被 releasing 拦下 —— 所以这里必须再对齐一次，否则哨兵就永久丢了。
    state.releasing = false;
    window.clearTimeout(releasingTimer);
    releasingTimer = 0;
    debug("忽略自撤哨兵的 popstate");
    syncNow();
    return;
  }

  debug("popstate：退一层", {
    layers: state.layers.length,
    base: Boolean(state.base),
  });

  // 注意：这里全部用 syncNow() 同步补哨兵，绝不能用延时版本。
  // 延时版本会在系统手势里丢时机，导致下一次滑动直接大退。
  const layer = state.layers.pop();
  if (layer) {
    runHandler(layer.handler);
    syncNow();
    return;
  }

  const backButton = findVisibleBackButton();
  if (backButton) {
    backButton.click();
    syncNow();
    return;
  }

  if (state.base) {
    runHandler(state.base);
    syncNow();
    return;
  }

  // 一个可退目标都没有：这次后退交给浏览器照常处理（离开本页）
}

/**
 * 手势开始前补哨兵。
 * 正常情况下哨兵一直有效，这里直接 return，只有状态错乱时才真的去补——
 * 相当于给「哨兵丢了」留一道兜底，不至于下一次滑动就大退。
 */
function handleGestureStart(): void {
  if (hasSentinelInHistory()) return;
  ensureSentinel();
}

/** 幂等安装：监听 popstate，并清掉刷新后可能残留在 history 里的哨兵标记 */
export function installBackNavigation(): void {
  if (typeof window === "undefined") return;
  const scope = window as unknown as Record<string, unknown>;
  if (scope[INSTALL_FLAG]) return;
  scope[INSTALL_FLAG] = true;

  const raw = window.history.state;
  if (raw && typeof raw === "object" && (raw as Record<string, unknown>)[BACK_STATE_KEY]) {
    try {
      const next = { ...(raw as Record<string, unknown>) };
      delete next[BACK_STATE_KEY];
      window.history.replaceState(next, "");
    } catch {
      /* 某些环境限制 replaceState，忽略即可 */
    }
  }

  window.addEventListener("popstate", handlePopState);
  window.addEventListener("pointerdown", handleGestureStart, { passive: true, capture: true });
  window.addEventListener("touchstart", handleGestureStart, { passive: true, capture: true });

  scheduleSync();
}

/**
 * 注册一层「页面级」返回。返回注销函数，在组件 useEffect 里直接 return 即可。
 * 后注册的在上层；系统后退会先退它们。
 */
export function registerBackLayer(handler: () => void): BackLayerHandle {
  if (typeof window === "undefined") return () => undefined;
  installBackNavigation();

  const state = getBackState();
  const layer: BackLayer = { id: state.nextId, handler };
  state.nextId += 1;
  state.layers.push(layer);
  scheduleSync();

  return () => {
    const current = getBackState();
    const index = current.layers.findIndex((item) => item.id === layer.id);
    // 已经被 popstate 弹掉了，不用重复处理
    if (index < 0) return;
    current.layers.splice(index, 1);
    scheduleSync();
  };
}

/**
 * 注册最底一层（当前打开的 APP）。传 null 表示没有。
 * 单独存放是为了不受 React effect「子先父后」执行顺序影响：桌面层永远在栈底。
 */
export function setBackBaseHandler(handler: (() => void) | null): BackLayerHandle {
  if (typeof window === "undefined") return () => undefined;
  installBackNavigation();

  const state = getBackState();
  state.base = handler;
  scheduleSync();

  return () => {
    const current = getBackState();
    // 已经被新一层顶替，别把新的清掉
    if (current.base !== handler) return;
    current.base = null;
    scheduleSync();
  };
}

if (typeof window !== "undefined") {
  installBackNavigation();
}
