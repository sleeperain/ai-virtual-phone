/**
 * 系统「返回」→ 应用内逐级返回
 *
 * 目标：不自己画手势条，直接复用浏览器 / PWA 的系统后退手势
 *（iOS Safari 左缘右滑、Android 手势导航的返回、桌面浏览器的后退键 / 鼠标侧键），
 * 让它在仿真手机里表现为「一层一层往回退」，退到桌面后再滑就是浏览器本来的后退。
 *
 * 做法：只要存在可退目标，就在 history 里压一条「哨兵」记录。用户的系统后退
 * 会消耗掉这条哨兵并触发 popstate，我们在 popstate 里按下面的优先级退一层，
 * 然后立刻再压一条哨兵，保证下一次手势依然可用；可退目标消失时（例如用户点了
 * 页面上的返回箭头）再延迟把哨兵撤掉，恢复浏览器默认的后退行为。
 *
 * 退回优先级：
 *   1. 页面返回栈（PageShell 的 onBack、各 APP 自己注册的层级）—— 最上层优先
 *   2. 当前界面上可见的返回箭头（button.page-back-btn）—— 没主动注册的页面靠它兜底
 *   3. 桌面层（当前打开的 APP）—— 关闭 APP 回到桌面
 *
 * 状态挂在 window 上而不是模块作用域里，这样 HMR / 多次 import 也不会出现
 * 「两个监听器各管一半栈」的问题。
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
  /** history 里是否已经压了一条用于拦截后退的哨兵记录 */
  sentinel: boolean;
  /** 我们主动 history.back() 撤哨兵时的标记，用来忽略随之而来的那次 popstate */
  releasing: boolean;
};

const INSTALL_FLAG = "__aiVirtualPhoneBackNavInstalled";
const STATE_KEY = "__aiVirtualPhoneBackNavState";
const BACK_STATE_KEY = "__aiVirtualPhoneBack";

/** 页面标题栏的返回箭头统一用这个 class，页面没显式注册返回逻辑时靠它兜底 */
const BACK_BUTTON_SELECTOR = "button.page-back-btn";

/** 主动 history.back() 之后等 popstate 的兜底超时，防止 releasing 卡死吞掉后续手势 */
const RELEASE_TIMEOUT_MS = 800;

let releaseTimer = 0;

function getBackState(): BackState {
  const scope = window as unknown as Record<string, unknown>;
  const existing = scope[STATE_KEY] as BackState | undefined;
  if (existing && Array.isArray(existing.layers)) return existing;
  const fresh: BackState = { layers: [], nextId: 1, base: null, sentinel: false, releasing: false };
  scope[STATE_KEY] = fresh;
  return fresh;
}

function readHistoryState(): Record<string, unknown> {
  const raw = window.history.state;
  return raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
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
  const buttons = Array.from(root.querySelectorAll<HTMLElement>(BACK_BUTTON_SELECTOR));
  for (let index = buttons.length - 1; index >= 0; index -= 1) {
    if (isClickable(buttons[index])) return buttons[index];
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

function releaseSentinel(): void {
  const state = getBackState();
  if (!state.sentinel) return;
  state.sentinel = false;
  state.releasing = true;
  window.history.back();
  window.clearTimeout(releaseTimer);
  releaseTimer = window.setTimeout(() => {
    releaseTimer = 0;
    getBackState().releasing = false;
  }, RELEASE_TIMEOUT_MS);
}

function syncSentinel(): void {
  if (typeof window === "undefined") return;
  const state = getBackState();

  if (!state.sentinel) {
    if (!hasBackTarget()) return;
    window.history.pushState({ ...readHistoryState(), [BACK_STATE_KEY]: true }, "");
    state.sentinel = true;
    return;
  }

  if (hasBackTarget()) return;

  // 可退目标已经没了（典型场景：用户点了页面上的返回箭头、旧页面卸载而新页面还没挂载）。
  // 延后一拍再撤哨兵，避免这种瞬间的空栈误触发一次历史回退。
  window.clearTimeout(releaseTimer);
  releaseTimer = window.setTimeout(() => {
    releaseTimer = 0;
    const current = getBackState();
    if (current.sentinel && !hasBackTarget()) releaseSentinel();
  }, 0);
}

function handlePopState(): void {
  const state = getBackState();

  if (state.releasing) {
    // 这次后退是我们自己撤哨兵引起的，不是用户手势
    state.releasing = false;
    window.clearTimeout(releaseTimer);
    releaseTimer = 0;
    return;
  }

  // 用户手势消耗掉了哨兵
  state.sentinel = false;
  window.clearTimeout(releaseTimer);
  releaseTimer = 0;

  const layer = state.layers.pop();
  if (layer) {
    runHandler(layer.handler);
    syncSentinel();
    return;
  }

  const backButton = findVisibleBackButton();
  if (backButton) {
    backButton.click();
    syncSentinel();
    return;
  }

  if (state.base) {
    runHandler(state.base);
    syncSentinel();
    return;
  }

  // 一个可退目标都没有：这次后退交给浏览器照常处理（离开本页）
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
  syncSentinel();
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
  syncSentinel();

  return () => {
    const current = getBackState();
    const index = current.layers.findIndex((item) => item.id === layer.id);
    // 已经被 popstate 弹掉了，不用重复处理
    if (index < 0) return;
    current.layers.splice(index, 1);
    syncSentinel();
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
  syncSentinel();

  return () => {
    const current = getBackState();
    // 已经被新一层顶替，别把新的清掉
    if (current.base !== handler) return;
    current.base = null;
    syncSentinel();
  };
}

if (typeof window !== "undefined") {
  installBackNavigation();
}
