"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { WidgetRenderer } from "@/components/widgets/widget-renderer";
import { WIDGET_SIZE_CELLS, type WidgetSize } from "@/lib/widget-types";
import {
  canAddLockWidget,
  createLockWidgetEntry,
  getLockWidgetCatalog,
  layoutLockWidgets,
  loadLockWidgetEntries,
  saveLockWidgetEntries,
  type LockWidgetEntry,
} from "@/lib/lock-widgets";

/* ══════════════════════════════════════════
   锁屏上的组件区

   - 固定 2 行 × 4 列网格，摆在时间下方；组件按顺序自动排位
   - 长按组件区（含空白处）进编辑态：顶部出现「取消」「添加」，组件右上角出现删除
   - 添加时打开选择器，只列能放进这块网格的组件

   组件渲染直接复用桌面的 WidgetRenderer（preview 模式跳过桌面网格定位），
   尺寸由外层 grid 的格子决定，不依赖桌面的 --slot-* 变量。
   ══════════════════════════════════════════ */

/** 长按多久进编辑态 */
const LONG_PRESS_MS = 480;

export function LockWidgetArea({
  onEditingChange,
}: {
  /** 通知父级：编辑态时锁屏不该响应上滑解锁 */
  onEditingChange?: (editing: boolean) => void;
}) {
  const [entries, setEntries] = useState<LockWidgetEntry[]>([]);
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setEntries(loadLockWidgetEntries());
  }, []);

  useEffect(() => {
    onEditingChange?.(editing);
  }, [editing, onEditingChange]);

  useEffect(() => () => clearTimeout(longPressTimer.current), []);

  // 兜底：指针可能被上层的 setPointerCapture 截走，组件自己收不到 pointerup。
  // 挂在 window 上保证"手指一松就不算长按"，避免快速上滑解锁后又莫名进了编辑态。
  useEffect(() => {
    const cancel = () => clearTimeout(longPressTimer.current);
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);

  const placed = useMemo(() => layoutLockWidgets(entries), [entries]);

  const commit = useCallback((next: LockWidgetEntry[]) => {
    setEntries(next);
    saveLockWidgetEntries(next);
  }, []);

  const startLongPress = useCallback(() => {
    clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => setEditing(true), LONG_PRESS_MS);
  }, []);

  const cancelLongPress = useCallback(() => {
    clearTimeout(longPressTimer.current);
  }, []);

  const handleAdd = useCallback((type: string, size: WidgetSize) => {
    const next = [...entries, createLockWidgetEntry(type, size)];
    commit(next);
    setPickerOpen(false);
  }, [entries, commit]);

  const handleRemove = useCallback((id: string) => {
    commit(entries.filter((entry) => entry.id !== id));
  }, [entries, commit]);

  const exitEditing = useCallback(() => {
    setEditing(false);
    setPickerOpen(false);
  }, []);

  return (
    <div
      className="lock-widget-area"
      data-editing={editing ? "1" : undefined}
      onPointerDown={(event) => {
        // 这里按下去是在摆弄组件，不该触发上滑解锁。
        // 但空着的时候（没有组件、也不在编辑）不拦：那块区域照样可以上滑解锁。
        if (editing || placed.length > 0) event.stopPropagation();
        startLongPress();
      }}
      onPointerMove={() => cancelLongPress()}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
    >
      <div className="lock-widget-grid">
        {placed.map((widget) => {
          const cells = WIDGET_SIZE_CELLS[widget.size];
          const [rows, cols] = cells ?? [1, 1];
          return (
            <div
              key={widget.id}
              className="lock-widget-slot"
              style={{
                gridRow: `span ${rows}`,
                gridColumn: `span ${cols}`,
              }}
            >
              <WidgetRenderer widget={widget} preview />
              {editing && (
                <button
                  type="button"
                  className="lock-widget-remove"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleRemove(widget.id);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  aria-label="移除组件"
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

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
              {getLockWidgetCatalog().map((entry) => {
                const disabled = !canAddLockWidget(entries, entry.size);
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
