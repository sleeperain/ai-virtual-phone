"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { WidgetRenderer } from "@/components/widgets/widget-renderer";
import { WIDGET_SIZE_CELLS, type WidgetSize } from "@/lib/widget-types";
import {
  addLockWidget,
  canAddLockWidget,
  canPlaceAt,
  getLockWidgetCatalog,
  loadLockWidgetEntries,
  moveLockWidget,
  removeLockWidget,
  saveLockWidgetEntries,
  toWidgetInstances,
  type LockWidgetEntry,
} from "@/lib/lock-widgets";

/* ══════════════════════════════════════════
   锁屏上的组件区（4 列 × 4 行）

   交互对齐桌面那套：
   - 长按空白处 → 进编辑态（组件抖动 + 虚线框 + 删除按钮 + 「取消」「添加」）
   - 编辑态下按住组件拖动 → 拖影跟随手指，落到哪个格就在哪个格显示落点框
   - 松手合法就落位，兄弟组件用 FLIP 平滑让位（grid 行列本身不可过渡）

   组件渲染复用桌面 WidgetRenderer（preview 模式跳过桌面网格定位），
   尺寸由外层 grid 的格子决定，不依赖桌面的 --slot-* 变量。
   ══════════════════════════════════════════ */

const LONG_PRESS_MS = 420;
/** 超过这个位移才算"在拖"，避免轻点误触 */
const DRAG_THRESHOLD = 6;

type DragState = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  element: HTMLElement;
  ghostW: number;
  ghostH: number;
  active: boolean;
  targetRow: number;
  targetCol: number;
};

export function LockWidgetArea({
  onEditingChange,
}: {
  /** 通知父级：编辑态时锁屏不该响应上滑解锁 */
  onEditingChange?: (editing: boolean) => void;
}) {
  const [entries, setEntries] = useState<LockWidgetEntry[]>([]);
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropTarget, setDropTarget] = useState<{ row: number; col: number; rows: number; cols: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const gridRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragRef = useRef<DragState | null>(null);
  const entriesRef = useRef<LockWidgetEntry[]>([]);

  useEffect(() => {
    const loaded = loadLockWidgetEntries();
    setEntries(loaded);
    entriesRef.current = loaded;
  }, []);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  useEffect(() => () => clearTimeout(longPressTimer.current), []);

  const widgets = useMemo(() => toWidgetInstances(entries), [entries]);

  const commit = useCallback((next: LockWidgetEntry[]) => {
    setEntries(next);
    entriesRef.current = next;
    saveLockWidgetEntries(next);
  }, []);

  /* ── FLIP：让位平滑。grid 行列不可过渡，靠 transform 补一段 ── */
  const flipRectsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      flipRectsRef.current = new Map();
      return;
    }
    const gridRect = grid.getBoundingClientRect();
    const prev = flipRectsRef.current;
    const next = new Map<string, { x: number; y: number }>();
    const moved: HTMLElement[] = [];

    grid.querySelectorAll<HTMLElement>("[data-lock-flip-id]").forEach((el) => {
      const key = el.dataset.lockFlipId ?? "";
      if (!key) return;
      // 量之前清掉上一轮残留，避免量到动画中间值
      if (el.dataset.flipActive) {
        el.style.transition = "none";
        el.style.transform = "";
        delete el.dataset.flipActive;
      }
      const rect = el.getBoundingClientRect();
      const x = rect.left - gridRect.left;
      const y = rect.top - gridRect.top;
      next.set(key, { x, y });
      const before = prev.get(key);
      if (!before) return;
      const dx = before.x - x;
      const dy = before.y - y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.dataset.flipActive = "1";
      moved.push(el);
    });

    if (moved.length) {
      void moved[0].offsetWidth; // 强制 reflow，让起始 transform 生效
      for (const el of moved) {
        el.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        el.style.transform = "";
      }
      window.setTimeout(() => {
        for (const el of moved) {
          el.style.transition = "";
          delete el.dataset.flipActive;
        }
      }, 240);
    }

    flipRectsRef.current = next;
  }, [entries]);

  /* ── 网格几何：指针 → 格子（1-based） ── */
  const pointerToCell = useCallback((clientX: number, clientY: number) => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const computed = getComputedStyle(grid);
    const colGap = parseFloat(computed.columnGap) || 10;
    const rowGap = parseFloat(computed.rowGap) || 10;
    const colW = (rect.width - colGap * 3) / 4;
    const rowH = (rect.height - rowGap * 3) / 4;
    if (colW <= 0 || rowH <= 0) return null;
    const col = Math.floor((clientX - rect.left) / (colW + colGap)) + 1;
    const row = Math.floor((clientY - rect.top) / (rowH + rowGap)) + 1;
    return {
      row: Math.min(4, Math.max(1, row)),
      col: Math.min(4, Math.max(1, col)),
    };
  }, []);

  /* ── 拖拽 ── */
  const endDrag = useCallback((commitMove: boolean) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
    if (ghostRef.current) {
      ghostRef.current.style.display = "none";
      ghostRef.current.innerHTML = "";
    }
    if (!drag) return;
    if (!commitMove || !drag.active) return;
    const next = moveLockWidget(entriesRef.current, drag.id, drag.targetRow, drag.targetCol);
    if (next !== entriesRef.current) commit(next);
  }, [commit]);

  const handleWidgetPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, entry: LockWidgetEntry) => {
    if (!editing) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    if (!WIDGET_SIZE_CELLS[entry.size]) return;
    dragRef.current = {
      id: entry.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // 抓取点相对组件左上角的偏移，拖动时保持手感
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      element,
      ghostW: rect.width,
      ghostH: rect.height,
      active: false,
      targetRow: entry.row,
      targetCol: entry.col,
    };
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // 老浏览器没有 pointer capture，window 上的监听兜底
    }
    event.stopPropagation();
  }, [editing]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;

      if (!drag.active) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        drag.active = true;
        setDraggingId(drag.id);
        const ghost = ghostRef.current;
        if (ghost) {
          ghost.innerHTML = "";
          const clone = drag.element.cloneNode(true) as HTMLElement;
          clone.style.width = `${drag.ghostW}px`;
          clone.style.height = `${drag.ghostH}px`;
          ghost.appendChild(clone);
          ghost.style.display = "block";
          ghost.style.width = `${drag.ghostW}px`;
          ghost.style.height = `${drag.ghostH}px`;
        }
      }

      const ghost = ghostRef.current;
      if (ghost) {
        ghost.style.transform = `translate3d(${event.clientX - drag.offsetX}px, ${event.clientY - drag.offsetY}px, 0)`;
      }

      // 用组件左上角推落点，比用指针更贴近"组件会落在哪"
      const anchor = pointerToCell(event.clientX - drag.offsetX + 4, event.clientY - drag.offsetY + 4);
      if (!anchor) return;
      const dragEntry = entriesRef.current.find((item) => item.id === drag.id);
      if (!dragEntry) return;
      const cells = WIDGET_SIZE_CELLS[dragEntry.size] ?? [1, 1];
      const [rows, cols] = cells;
      // 落点尽量不越界
      const row = Math.min(4 - rows + 1, Math.max(1, anchor.row));
      const col = Math.min(4 - cols + 1, Math.max(1, anchor.col));
      drag.targetRow = row;
      drag.targetCol = col;
      const ok = canPlaceAt(entriesRef.current, dragEntry.size, row, col, drag.id);
      setDropTarget(ok ? { row, col, rows, cols } : null);
    };

    const onUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      endDrag(true);
    };

    const onCancel = () => {
      if (dragRef.current) endDrag(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [endDrag, pointerToCell]);

  /* ── 长按进编辑 ── */
  const startLongPress = useCallback(() => {
    clearTimeout(longPressTimer.current);
    if (editing) return;
    longPressTimer.current = setTimeout(() => setEditing(true), LONG_PRESS_MS);
  }, [editing]);

  const cancelLongPress = useCallback(() => {
    clearTimeout(longPressTimer.current);
  }, []);

  useEffect(() => {
    // 指针可能被上层 setPointerCapture 截走，收不到 pointerup；
    // 挂 window 保证"一松手就不算长按"，避免快速上滑后又莫名进编辑态
    const cancel = () => clearTimeout(longPressTimer.current);
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);

  const handleAdd = useCallback((type: string, size: WidgetSize) => {
    const next = addLockWidget(entriesRef.current, type, size);
    if (next) commit(next);
    setPickerOpen(false);
  }, [commit]);

  const exitEditing = useCallback(() => {
    setEditing(false);
    setPickerOpen(false);
  }, []);

  return (
    <div
      className="lock-widget-area"
      data-editing={editing ? "1" : undefined}
      onPointerDown={(event) => {
        // 按在组件上时由组件自己处理拖动，这里只管空白处的"长按进编辑"
        if ((event.target as HTMLElement).closest(".lock-widget-slot")) return;
        if (editing || entries.length > 0) event.stopPropagation();
        startLongPress();
      }}
      onPointerMove={cancelLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
    >
      <div className="lock-widget-grid" ref={gridRef}>
        {widgets.map((widget) => {
          const cells = WIDGET_SIZE_CELLS[widget.size] ?? [1, 1];
          const [rows, cols] = cells;
          return (
            <div
              key={widget.id}
              className="lock-widget-slot"
              data-lock-flip-id={widget.id}
              data-dragging={draggingId === widget.id ? "1" : undefined}
              style={{
                gridRow: `${widget.row} / span ${rows}`,
                gridColumn: `${widget.col} / span ${cols}`,
              }}
              onPointerDown={(event) => {
                const entry = entries.find((item) => item.id === widget.id);
                if (!entry) return;
                if (!editing) {
                  // 未进编辑态时按住组件：同样可以长按进编辑
                  startLongPress();
                  return;
                }
                handleWidgetPointerDown(event, entry);
              }}
              onPointerMove={cancelLongPress}
              onPointerUp={cancelLongPress}
            >
              <WidgetRenderer widget={widget} preview />
              {editing && (
                <button
                  type="button"
                  className="lock-widget-remove"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    commit(removeLockWidget(entriesRef.current, widget.id));
                  }}
                  aria-label="移除组件"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}

        {/* 拖拽落点提示：和桌面同一个视觉语言 */}
        {dropTarget && (
          <div
            className="lock-widget-drop"
            style={{
              gridRow: `${dropTarget.row} / span ${dropTarget.rows}`,
              gridColumn: `${dropTarget.col} / span ${dropTarget.cols}`,
            }}
          />
        )}
      </div>

      {/* 拖影：跟着手指走的克隆 */}
      <div ref={ghostRef} className="lock-widget-ghost" aria-hidden />

      {editing && (
        <div className="lock-widget-actions">
          <button
            type="button"
            className="lock-widget-action"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={exitEditing}
          >
            取消
          </button>
          <button
            type="button"
            className="lock-widget-action lock-widget-action-primary"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setPickerOpen(true)}
          >
            添加
          </button>
        </div>
      )}

      {pickerOpen && (
        <div
          className="lock-widget-picker"
          onPointerDown={(event) => {
            event.stopPropagation();
            cancelLongPress();
          }}
          onClick={() => setPickerOpen(false)}
        >
          <div className="lock-widget-picker-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="lock-widget-picker-head">
              <span>添加组件</span>
              <button
                type="button"
                className="lock-widget-picker-close"
                onClick={() => setPickerOpen(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="lock-widget-picker-list">
              {lockedCatalog().map((entry) => {
                const disabled = !canAddLockWidget(entriesRef.current, entry.size);
                return (
                  <button
                    key={`${entry.type}-${entry.size}`}
                    type="button"
                    className="lock-widget-picker-item"
                    disabled={disabled}
                    onClick={() => handleAdd(entry.type, entry.size)}
                  >
                    <span className="lock-widget-picker-item-name">{entry.name}</span>
                    <span className="lock-widget-picker-item-meta">
                      {disabled ? "放不下了" : entry.size}
                    </span>
                    {!disabled && <Plus size={14} strokeWidth={2} aria-hidden />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* 目录是纯静态的，取一次就够（避免每次渲染重建数组） */
let catalogCache: ReturnType<typeof getLockWidgetCatalog> | null = null;
function lockedCatalog() {
  if (!catalogCache) catalogCache = getLockWidgetCatalog();
  return catalogCache;
}
