"use client";

import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { ChevronLeft } from "lucide-react";

import { registerBackLayer } from "@/lib/back-navigation";

/**
 * 把本页的返回动作接进全局返回栈：系统返回手势 / 浏览器后退会先退这一层，
 * 走的是和点左上角返回箭头完全相同的逻辑。
 */
function usePageBackLayer(onBack: (() => void) | undefined): void {
  const onBackRef = useRef(onBack);

  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  // 只在「有没有返回动作」真正变化时注册/注销，页面间切换不会把栈越堆越深
  const enabled = typeof onBack === "function";

  useEffect(() => {
    if (!enabled) return;
    return registerBackLayer(() => {
      onBackRef.current?.();
    });
  }, [enabled]);
}

type PageShellProps = {
  title?: ReactNode;
  onBack?: () => void;
  leftAction?: ReactNode;
  rightAction?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyRef?: Ref<HTMLDivElement>;
};

export function PageShell({ title = "", onBack, leftAction, rightAction, children, footer, className, bodyRef }: PageShellProps) {
  usePageBackLayer(onBack);

  return (
    <div className={`page-shell ${className ?? ""}`}>
      <header className="page-header" data-ui="header">
        <div className="page-header-safe-area" />
        <div className="page-header-content">
          {onBack ? (
            <button className="page-back-btn" type="button" onClick={onBack} aria-label="返回">
              <ChevronLeft size={24} strokeWidth={1.5} />
            </button>
          ) : leftAction ? (
            <span>{leftAction}</span>
          ) : (
            <span style={{ width: 40 }} />
          )}
          <span className="page-title">{title}</span>
          <span className="page-header-right">{rightAction ?? <span style={{ width: 40 }} />}</span>
        </div>
      </header>
      <div ref={bodyRef} className="page-body" data-ui="body">
        {children}
      </div>
      {footer}
    </div>
  );
}

/**
 * Floating overlay header for canvas-style pages (e.g. character page).
 * Uses absolute positioning + pointer-events-none so the canvas beneath
 * remains interactive. The back button uses pointer-events-auto.
 */
type PageOverlayHeaderProps = {
  title: ReactNode;
  onBack: () => void;
  rightAction?: ReactNode;
  className?: string;
};

export function PageOverlayHeader({ title, onBack, rightAction, className }: PageOverlayHeaderProps) {
  usePageBackLayer(onBack);

  return (
    <header className={`page-header pointer-events-none absolute top-0 left-0 right-0 z-10 ${className ?? ""}`}>
      <div className="page-header-safe-area" />
      <div className="page-header-content">
        <button className="page-back-btn pointer-events-auto" type="button" onClick={onBack} aria-label="返回">
          <ChevronLeft size={24} strokeWidth={1.5} />
        </button>
        <span className="page-title">{title}</span>
        <span className="page-header-right pointer-events-auto">{rightAction ?? <span style={{ width: 40 }} />}</span>
      </div>
    </header>
  );
}
