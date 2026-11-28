import {
  WIDGET_SIZE_CELLS,
  WIDGET_CATALOG,
  type WidgetInstance,
  type WidgetSize,
  type WidgetType,
} from "@/lib/widget-types";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

/* ══════════════════════════════════════════
   锁屏组件

   锁屏上也能摆桌面组件（和桌面共用 WIDGET_CATALOG / WidgetRenderer）。
   锁屏固定一块 4 列 × 4 行的网格，从状态栏下方铺到屏幕中部。
   时间不是内置样式，而是默认放进去的一个「极简大号时间」组件（2×4，占满顶上两行），
   用户也可以删掉它、换成别的组件。
   只接受能塞进这块网格的尺寸，其余尺寸在选择器里直接过滤掉。

   位置不存死在数据里：按数组顺序自动排位，删掉中间一个后面的自动补上，
   避免出现"删了个组件、留下一个黑洞"。
   ══════════════════════════════════════════ */

const LOCK_WIDGETS_KEY = "ai_phone_lock_widgets_v1";
registerKvMigration(LOCK_WIDGETS_KEY);

/** 锁屏组件区的网格：4 列、4 行，铺满从状态栏下方到中部的整块区域 */
export const LOCK_GRID_COLS = 4;
export const LOCK_GRID_ROWS = 4;

/**
 * 默认摆一个大号时间（2×4 正好占满顶上两行）。
 * 锁屏不再内置时间样式，时间就由这个桌面组件提供，用户也可以换掉它。
 */
const DEFAULT_ENTRIES: LockWidgetEntry[] = [
  { id: "lock_default_large_time", type: "largeTime" as WidgetType, size: "2x4" as WidgetSize },
];

/** 锁屏上允许的组件尺寸（必须能放进 2×4） */
function fitsLockGrid(size: WidgetSize): boolean {
  const cells = WIDGET_SIZE_CELLS[size];
  if (!cells) return false;
  const [rows, cols] = cells;
  return rows <= LOCK_GRID_ROWS && cols <= LOCK_GRID_COLS;
}

/** 锁屏可选组件目录：过滤掉放不下的尺寸 */
export function getLockWidgetCatalog() {
  const seen = new Set<string>();
  return WIDGET_CATALOG.filter((entry) => {
    if (!fitsLockGrid(entry.size)) return false;
    const key = `${entry.type}|${entry.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeId(): string {
  return `lock_w_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

/** 读原始条目（只有 type/size/id，不含位置） */
export type LockWidgetEntry = {
  id: string;
  type: WidgetType;
  size: WidgetSize;
};

function normalizeEntry(raw: unknown): LockWidgetEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const type = typeof source.type === "string" ? (source.type as WidgetType) : null;
  const size = typeof source.size === "string" ? (source.size as WidgetSize) : null;
  if (!type || !size || !fitsLockGrid(size)) return null;
  const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : makeId();
  return { id, type, size };
}

export function loadLockWidgetEntries(): LockWidgetEntry[] {
  try {
    const raw = kvGet(LOCK_WIDGETS_KEY);
    // 从没配置过 → 给默认的大号时间；用户手动清空过则存的是 "[]"，尊重清空
    if (raw === null) return DEFAULT_ENTRIES.map((entry) => ({ ...entry }));
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeEntry)
      .filter((entry): entry is LockWidgetEntry => Boolean(entry));
  } catch {
    return [];
  }
}

export function saveLockWidgetEntries(entries: LockWidgetEntry[]): void {
  kvSet(LOCK_WIDGETS_KEY, JSON.stringify(entries));
}

export function createLockWidgetEntry(type: WidgetType, size: WidgetSize): LockWidgetEntry {
  return { id: makeId(), type, size };
}

/**
 * 按顺序自动排位，产出可直接交给 WidgetRenderer 的 WidgetInstance。
 * 从左上往右下找第一个放得下的空位；放不下的跳过。
 */
export function layoutLockWidgets(entries: LockWidgetEntry[]): WidgetInstance[] {
  const occupied: boolean[][] = Array.from({ length: LOCK_GRID_ROWS }, () =>
    Array.from({ length: LOCK_GRID_COLS }, () => false)
  );
  const result: WidgetInstance[] = [];

  const canPlace = (rows: number, cols: number, row: number, col: number): boolean => {
    if (row + rows > LOCK_GRID_ROWS || col + cols > LOCK_GRID_COLS) return false;
    for (let r = row; r < row + rows; r += 1) {
      for (let c = col; c < col + cols; c += 1) {
        if (occupied[r][c]) return false;
      }
    }
    return true;
  };

  for (const entry of entries) {
    const cells = WIDGET_SIZE_CELLS[entry.size];
    if (!cells) continue;
    const [rows, cols] = cells;
    let placed = false;
    for (let r = 0; r < LOCK_GRID_ROWS && !placed; r += 1) {
      for (let c = 0; c < LOCK_GRID_COLS && !placed; c += 1) {
        if (!canPlace(rows, cols, r, c)) continue;
        for (let dr = 0; dr < rows; dr += 1) {
          for (let dc = 0; dc < cols; dc += 1) {
            occupied[r + dr][c + dc] = true;
          }
        }
        result.push({
          id: entry.id,
          type: entry.type,
          size: entry.size,
          page: 1,
          row: r + 1,
          col: c + 1,
        });
        placed = true;
      }
    }
  }

  return result;
}

/** 这块网格现在还塞得下这个尺寸吗 */
export function canAddLockWidget(entries: LockWidgetEntry[], size: WidgetSize): boolean {
  const probe: LockWidgetEntry[] = [...entries, { id: "probe", type: "clock" as WidgetType, size }];
  return layoutLockWidgets(probe).length === probe.length;
}
