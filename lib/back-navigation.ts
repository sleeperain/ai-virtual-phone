/**
 * 系统「返回」→ 仿真手机内的返回
 *
 * 默认行为（用户要的一刀切）：不管当前在 APP 的第几层，左右滑 / 浏览器后退
 * 一次就直接回到手机主桌面。再滑一次什么都不发生，绝不会离开整个网页。
 *
 * 实现思路：在 history 里**常驻**一条「守卫记录」。用户的系统后退手势会消耗掉
 * 这条记录并触发 popstate，我们在 popstate 里执行返回动作，然后立刻把守卫补回去。
 * 因为守卫是常驻的、与「当前有没有可退目标」无关，所以不存在「退到某一层后
 * 守卫没补上 → 下一次滑动变成浏览器真实后退 → 整页大退」这条失败路径。
 *
 * ── 为什么不用「只在有目标时才压守卫」的老做法 ──
 * 老做法在退完最后一层时要主动 history.back() 把守卫撤掉，这个 back 调用会和
 * 用户自己的后退手势抢历史栈；而且 popstate 里重建守卫在 iOS Safari 上偶发被吞
 * （手势收尾阶段的历史操作会被并入上一次导航）。两个问题叠加，表现就是
 * 「只能退两级，第三次直接大退」。现在的做法完全不调用 history.back()，
 * 守卫只增不减，再用「校验 + 重试 + 巡检」保证它一定在。
 *
 * ── 副作用（有意为之）──
 * 守卫常驻 = 浏览器后退键 / 系统返回手势不会让页面离开。这对仿真手机是想要的，
 * 但对「想用后退键离开这个网页」的用户是个意外。留了开关：
 *   window.__aiVirtualPhoneBackNavFreeExit = true   // 桌面上再滑就让浏览器正常后退
 * 调试逐级模式（老行为）：
 *   window.__aiVirtualPhoneBackNavStepwise = true   // 先退内部层级，最后才回桌面
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
  /** 最底一层（当前打开的 APP） */
  base: (() => void) | null;
};

const INSTALL_FLAG = "__aiVirtualPhoneBackNavInstalled";
const STATE_KEY = "__aiVirtualPhoneBackNavState";
const GUARD_KEY = "__aiVirtualPhoneBackGuard";
const DEBUG_FLAG = "__aiVirtualPhoneBackNavDebug";
const FREE_EXIT_FLAG = "__aiVirtualPhoneBackNavFreeExit";
const STEPWISE_FLAG = "__aiVirtualPhoneBackNavStepwise";

/**
 * 没显式注册返回逻辑的页面靠这些选择器兜底。
 * 只在「逐级模式」下使用；一刀切模式下不需要它。
 */
const BACK_BUTTON_SELECTORS = [
  "button.page-back-btn",
  '[data-ui="back"]',
  'button[aria-label="返回"]',
  'button[aria-label="Back"]',
] as const;

/** 补守卫的最大重试次数与退避基数（iOS 手势收尾时历史操作会被推迟） */
const GUARD_RETRY_MAX = 12;
const GUARD_RETRY_BASE_MS = 16;
/** 巡检间隔：兜住任何我们没预料到的守卫丢失 */
const PATROL_INTERVAL_MS = 1000;

let patrolTimer = 0;

function getBackState(): BackState {
  const scope = window as unknown as Record<string, unknown>;
  const existing = scope[STATE_KEY] as BackState | undefined;
  if (existing && Array.isArray(existing.layers)) return existing;
  const fresh: BackState = { layers: [], nextId: 1, base: null };
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

/** 当前历史项是不是我们压的守卫（唯一真相，不信内存布尔值） */
function isGuardEntry(): boolean {
  return readHistoryState()[GUARD_KEY] === true;
}

function runHandler(handler: () => void): void {
  try {
    handler();
  } catch (error) {
    console.warn("[back-navigation] 返回处理器执行失败：", error);
  }
}

function isClickable(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) return false;
  if (element.getClientRects().length === 0) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  return style.pointerEvents !== "none";
}

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

/** 压一条守卫记录，返回是否成功写进 history.state */
function pushGuard(): boolean {
  if (isGuardEntry()) return true;
  try {
    window.history.pushState({ ...readHistoryState(), [GUARD_KEY]: true }, "");
    return isGuardEntry();
  } catch {
    return false;
  }
}

/**
 * 确保守卫在位。同步压一次，再带退避重试校验——
 * iOS Safari 在系统后退手势收尾阶段的历史操作可能被并入上一次导航而丢失，
 * 只压一次不够，必须校验到真的写进去为止。
 */
function ensureGuard(): void {
  if (isGuardEntry()) return;
  pushGuard();

  let attempt = 0;
  const retry = () => {
    if (isGuardEntry()) return;
    attempt += 1;
    if (attempt > GUARD_RETRY_MAX) {
      debug("守卫补写失败，放弃本轮重试");
      return;
    }
    pushGuard();
    window.setTimeout(retry, GUARD_RETRY_BASE_MS * attempt);
  };
  window.setTimeout(retry, 0);
}

/** 用户是否希望「桌面上再滑就让浏览器正常后退」 */
function freeExitEnabled(): boolean {
  const scope = window as unknown as Record<string, unknown>;
  return scope[FREE_EXIT_FLAG] === true;
}

function stepwiseEnabled(): boolean {
  const scope = window as unknown as Record<string, unknown>;
  return scope[STEPWISE_FLAG] === true;
}

/**
 * 决定这次后退要做什么。返回 null 表示「什么都不做」（留在当前界面）。
 * 优先级：一刀切模式下 base（关掉当前 APP）永远最先；逐级模式先弹内部层级。
 */
function resolveAction(): (() => void) | null {
  const state = getBackState();

  if (stepwiseEnabled()) {
    const layer = state.layers.pop();
    if (layer) return layer.handler;
    if (state.base) return state.base;
    const button = findVisibleBackButton();
    return button ? () => button.click() : null;
  }

  // 一刀切：有打开的 APP 就直接回桌面，不管它在第几层
  if (state.base) return state.base;

  // 桌面上的文件夹、编辑模式等仍可退
  const layer = state.layers.pop();
  if (layer) return layer.handler;

  const button = findVisibleBackButton();
  return button ? () => button.click() : null;
}

/** 当前是否还「有事可退」——只在决定要不要放行浏览器后退时用 */
function hasAction(): boolean {
  const state = getBackState();
  return Boolean(state.base) || state.layers.length > 0 || findVisibleBackButton() !== null;
}

function handlePopState(): void {
  const action = resolveAction();
  debug("popstate", { action: Boolean(action), base: Boolean(getBackState().base) });

  if (action) {
    runHandler(action);
    // 无论动作是否改变了 React 状态，守卫都要立刻补回去，绝不留给下一次手势
    ensureGuard();
    return;
  }

  if (freeExitEnabled()) {
    // 用户显式要求放行：不再补守卫，这次后退就交给浏览器
    debug("放行浏览器后退");
    return;
  }

  // 桌面上什么都不做，但守卫照补，保证再滑也不会离开网页
  ensureGuard();
}

/** 幂等安装 */
export function installBackNavigation(): void {
  if (typeof window === "undefined") return;
  const scope = window as unknown as Record<string, unknown>;
  if (scope[INSTALL_FLAG]) return;
  scope[INSTALL_FLAG] = true;

  // 刷新后可能残留旧标记（上次页面实例压的），先清掉再重新压，避免重复累积
  const raw = window.history.state;
  if (raw && typeof raw === "object" && (raw as Record<string, unknown>)[GUARD_KEY]) {
    try {
      const next = { ...(raw as Record<string, unknown>) };
      delete next[GUARD_KEY];
      window.history.replaceState(next, "");
    } catch {
      /* 某些环境限制 replaceState，忽略即可 */
    }
  }

  window.addEventListener("popstate", handlePopState);

  // 手势一开始就校验一次，把「守卫已经丢了」的情况压在下一次后退之前
  const onGestureStart = () => ensureGuard();
  window.addEventListener("pointerdown", onGestureStart, { passive: true, capture: true });
  window.addEventListener("touchstart", onGestureStart, { passive: true, capture: true });

  // 从 bfcache 恢复时 history 可能已经换了，重新校验
  window.addEventListener("pageshow", () => ensureGuard());
  window.addEventListener("focus", () => ensureGuard());

  ensureGuard();

  // 巡检兜底：任何我们没预料到的守卫丢失，1 秒内自己修回来
  window.clearInterval(patrolTimer);
  patrolTimer = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!isGuardEntry()) ensureGuard();
  }, PATROL_INTERVAL_MS);
}

/**
 * 注册一层「页面级」返回。返回注销函数，在组件 useEffect 里直接 return 即可。
 * 后注册的在上层。
 */
export function registerBackLayer(handler: () => void): BackLayerHandle {
  if (typeof window === "undefined") return () => undefined;
  installBackNavigation();

  const state = getBackState();
  const layer: BackLayer = { id: state.nextId, handler };
  state.nextId += 1;
  state.layers.push(layer);
  ensureGuard();

  return () => {
    const current = getBackState();
    const index = current.layers.findIndex((item) => item.id === layer.id);
    if (index < 0) return;
    current.layers.splice(index, 1);
  };
}

/**
 * 注册「当前打开的 APP」这一层。传 null 表示没有。
 * 一刀切模式下它优先级最高；单独存放也不受 React effect 执行顺序影响。
 */
export function setBackBaseHandler(handler: (() => void) | null): BackLayerHandle {
  if (typeof window === "undefined") return () => undefined;
  installBackNavigation();

  const state = getBackState();
  state.base = handler;
  ensureGuard();

  return () => {
    const current = getBackState();
    if (current.base !== handler) return;
    current.base = null;
  };
}

if (typeof window !== "undefined") {
  installBackNavigation();
}
