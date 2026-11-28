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

   和桌面共用 WIDGET_CATALOG / WidgetRenderer，但网格独立：
   4 列 × 4 行，从状态栏下方铺到屏幕中部。
   时间不是内置样式，而是默认放进去的一个「极简大号时间」组件（2×4，占满顶上两行）。

   位置是真的存坐标（row/col），和桌面一样可以拖着换位置；
   读盘时若发现重叠/越界（旧数据、改过网格尺寸），自动就近挪到空位，不让组件消失。
   ══════════════════════════════════════════ */

const LOCK_WIDGETS_KEY = "ai_phone_lock_widgets_v1";
registerKvMigration(LOCK_WIDGETS_KEY);

/** 锁屏组件区的网格：4 列、4 行 */
export const LOCK_GRID_COLS = 4;
export const LOCK_GRID_ROWS = 4;

export type LockWidgetEntry = {
  id: string;
  type: WidgetType;
  size: WidgetSize;
  /** 1-based */
  row: number;
  /** 1-based */
  col: number;
};

/**
 * 默认摆一个大号时间（2×4 正好占满顶上两行）。
 * 锁屏不再内置时间样式，时间就由这个桌面组件提供，用户也可以换掉它。
 */
const DEFAULT_ENTRIES: LockWidgetEntry[] = [
  { id: "lock_default_large_time", type: "largeTime" as WidgetType, size: "2x4" as WidgetSize, row: 1, col: 1 },
];

/** 取尺寸占的格数 [rows, cols]；放不进锁屏网格的返回 null */
function cellsOf(size: WidgetSize): [number, number] | null {
  const cells = WIDGET_SIZE_CELLS[size];
  if (!cells) return null;
  const [rows, cols] = cells;
  if (rows > LOCK_GRID_ROWS || cols > LOCK_GRID_COLS) return null;
  return [rows, cols];
}

/** 锁屏可选组件目录：只列能放进这块网格的 */
export function getLockWidgetCatalog() {
  const seen = new Set<string>();
  return WIDGET_CATALOG.filter((entry) => {
    if (!cellsOf(entry.size)) return false;
    const key = `${entry.type}|${entry.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeId(): string {
  return `lock_w_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

/** 某块区域是否被（除 ignoreId 之外的）组件占住 */
function isFree(
  entries: LockWidgetEntry[],
  rows: number,
  cols: number,
  row: number,
  col: number,
  ignoreId?: string,
): boolean {
  if (row < 1 || col < 1) return false;
  if (row + rows - 1 > LOCK_GRID_ROWS || col + cols - 1 > LOCK_GRID_COLS) return false;
  for (const other of entries) {
    if (other.id === ignoreId) continue;
    const cells = cellsOf(other.size);
    if (!cells) continue;
    const [otherRows, otherCols] = cells;
    const rowHit = row < other.row + otherRows && other.row < row + rows;
    const colHit = col < other.col + otherCols && other.col < col + cols;
    if (rowHit && colHit) return false;
  }
  return true;
}

export function canPlaceAt(
  entries: LockWidgetEntry[],
  size: WidgetSize,
  row: number,
  col: number,
  ignoreId?: string,
): boolean {
  const cells = cellsOf(size);
  if (!cells) return false;
  return isFree(entries, cells[0], cells[1], row, col, ignoreId);
}

/** 从 (fromRow, fromCol) 往外螺旋找最近的可放位置 */
export function findNearestFreeCell(
  entries: LockWidgetEntry[],
  size: WidgetSize,
  fromRow: number,
  fromCol: number,
  ignoreId?: string,
): { row: number; col: number } | null {
  const cells = cellsOf(size);
  if (!cells) return null;
  const [rows, cols] = cells;
  let best: { row: number; col: number } | null = null;
  let bestDist = Infinity;
  for (let r = 1; r <= LOCK_GRID_ROWS; r += 1) {
    for (let c = 1; c <= LOCK_GRID_COLS; c += 1) {
      if (!isFree(entries, rows, cols, r, c, ignoreId)) continue;
      const dist = Math.abs(r - fromRow) * LOCK_GRID_COLS + Math.abs(c - fromCol);
      if (dist < bestDist) {
        bestDist = dist;
        best = { row: r, col: c };
      }
    }
  }
  return best;
}

/** 把一批组件理成互不重叠的合法布局：越界/重叠的就近挪位，实在放不下才丢弃 */
export function normalizeEntries(entries: LockWidgetEntry[]): LockWidgetEntry[] {
  const placed: LockWidgetEntry[] = [];
  for (const entry of entries) {
    const cells = cellsOf(entry.size);
    if (!cells) continue;
    if (isFree(placed, cells[0], cells[1], entry.row, entry.col)) {
      placed.push(entry);
      continue;
    }
    const free = findNearestFreeCell(placed, entry.size, entry.row, entry.col);
    if (free) placed.push({ ...entry, row: free.row, col: free.col });
  }
  return placed;
}

function normalizeOne(raw: unknown): LockWidgetEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const type = typeof source.type === "string" ? (source.type as WidgetType) : null;
  const size = typeof source.size === "string" ? (source.size as WidgetSize) : null;
  if (!type || !size || !cellsOf(size)) return null;
  const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : makeId();
  const row = typeof source.row === "number" && Number.isFinite(source.row) ? Math.round(source.row) : 1;
  const col = typeof source.col === "number" && Number.isFinite(source.col) ? Math.round(source.col) : 1;
  return { id, type, size, row, col };
}

export function loadLockWidgetEntries(): LockWidgetEntry[] {
  try {
    const raw = kvGet(LOCK_WIDGETS_KEY);
    // 从没配置过 → 给默认的大号时间；用户手动清空过则存的是 "[]"，尊重清空
    if (raw === null) return DEFAULT_ENTRIES.map((entry) => ({ ...entry }));
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeEntries(
      parsed.map(normalizeOne).filter((entry): entry is LockWidgetEntry => Boolean(entry))
    );
  } catch {
    return [];
  }
}

export function saveLockWidgetEntries(entries: LockWidgetEntry[]): void {
  kvSet(LOCK_WIDGETS_KEY, JSON.stringify(entries));
}

/** 新增一个组件，自动找空位；没地方了返回 null */
export function addLockWidget(
  entries: LockWidgetEntry[],
  type: WidgetType,
  size: WidgetSize,
): LockWidgetEntry[] | null {
  const free = findNearestFreeCell(entries, size, 1, 1);
  if (!free) return null;
  return [...entries, { id: makeId(), type, size, row: free.row, col: free.col }];
}

/** 移动组件到目标格；放不下就原样返回 */
export function moveLockWidget(
  entries: LockWidgetEntry[],
  id: string,
  row: number,
  col: number,
): LockWidgetEntry[] {
  const target = entries.find((entry) => entry.id === id);
  if (!target) return entries;
  if (!canPlaceAt(entries, target.size, row, col, id)) return entries;
  return entries.map((entry) => (entry.id === id ? { ...entry, row, col } : entry));
}

export function removeLockWidget(entries: LockWidgetEntry[], id: string): LockWidgetEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

/** 还有没有空位放得下这个尺寸 */
export function canAddLockWidget(entries: LockWidgetEntry[], size: WidgetSize): boolean {
  return findNearestFreeCell(entries, size, 1, 1) !== null;
}

/** 转成 WidgetRenderer 能直接吃的形态（page 固定 1） */
export function toWidgetInstances(entries: LockWidgetEntry[]): WidgetInstance[] {
  return entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    size: entry.size,
    page: 1,
    row: entry.row,
    col: entry.col,
  }));
}
