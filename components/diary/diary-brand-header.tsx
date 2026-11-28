"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Globe, UserRound } from "lucide-react";

import { resolveUserIdentity } from "@/lib/settings-storage";
import type { UserIdentity } from "@/components/settings/user-identity";

export type DiaryBrandView = "entries" | "moments";

/**
 * 手记 / 片刻纪事共用的顶部栏：
 * 左侧是 iFloat 文字（点了回桌面，相当于原来的返回），
 * 右侧依次是「片刻纪事（地球）」→「TA的手记（实心铃铛）」→ 页面自己的按钮（字体 Aa 等）→ 用户圆形头像。
 * 头像点开是一张方形小菜单，菜单里「设置」进用户设置页。
 */
export function DiaryBrandHeader({ view, onClose, onSwitch, avatarLabel = "账户菜单", onOpenSettings, children }: {
  view: DiaryBrandView;
  onClose: () => void;
  onSwitch: (view: DiaryBrandView) => void;
  /** 头像按钮的无障碍说明 */
  avatarLabel?: string;
  /** 菜单里的「设置」：进入用户设置页 */
  onOpenSettings?: () => void;
  /** 页面自己的操作按钮（手记的字体 Aa 等），排在铃铛和头像之间 */
  children?: ReactNode;
}) {
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const sync = () => setIdentity(resolveUserIdentity(undefined, "diary"));
    sync();
    window.addEventListener("settings-identities-updated", sync);
    return () => window.removeEventListener("settings-identities-updated", sync);
  }, []);

  return (
    <header className="diary-app-header diary-entry-header diary-brand-header">
      <button type="button" className="diary-brand-mark" onClick={onClose} aria-label="返回桌面">
        iFloat
      </button>
      <span className="diary-entry-header-actions">
        <button
          type="button"
          className={`note-wall-menu-btn diary-brand-nav ${view === "moments" ? "is-active" : ""}`}
          onClick={() => onSwitch("moments")}
          aria-label="片刻纪事"
          aria-pressed={view === "moments"}
        >
          <Globe size={18} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`note-wall-menu-btn diary-brand-nav diary-brand-bell ${view === "entries" ? "is-active" : ""}`}
          onClick={() => onSwitch("entries")}
          aria-label="TA的手记"
          aria-pressed={view === "entries"}
        >
          {/* 实心铃铛：自绘，钟身 + 顶钮 + 底部长缝 + 铃舌，比 lucide 那版更接近系统铃铛图标 */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2.25a1.5 1.5 0 0 1 1.5 1.5v.4a6.75 6.75 0 0 1 5.25 6.6v3.4c0 .9.28 1.77.8 2.5l.66.92a1.2 1.2 0 0 1-.98 1.9H4.77a1.2 1.2 0 0 1-.98-1.9l.66-.92c.52-.73.8-1.6.8-2.5v-3.4a6.75 6.75 0 0 1 5.25-6.6v-.4a1.5 1.5 0 0 1 1.5-1.5z" />
            <path d="M9.4 20.25h5.2a2.6 2.6 0 0 1-5.2 0z" />
          </svg>
        </button>
        {children}
        <button
          type="button"
          className="diary-brand-avatar"
          onClick={() => { if (onOpenSettings) setMenuOpen(open => !open); }}
          aria-label={avatarLabel}
          aria-haspopup={onOpenSettings ? "menu" : undefined}
          aria-expanded={onOpenSettings ? menuOpen : undefined}
        >
          {identity?.avatarUrl ? <img src={identity.avatarUrl} alt="" /> : <UserRound size={15} aria-hidden="true" />}
        </button>
        {menuOpen ? (
          <>
            <div className="diary-brand-avatar-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="diary-brand-avatar-menu" role="menu" aria-label={avatarLabel}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings?.();
                }}
              >
                <span>设置</span>
              </button>
            </div>
          </>
        ) : null}
      </span>
    </header>
  );
}
