"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Bell, Globe, UserRound } from "lucide-react";

import { resolveUserIdentity } from "@/lib/settings-storage";
import type { UserIdentity } from "@/components/settings/user-identity";

export type DiaryBrandView = "entries" | "moments";

/**
 * 手记 / 片刻纪事共用的顶部栏：
 * 左侧是 iFloat 文字（点了回桌面，相当于原来的返回），
 * 右侧依次是「片刻纪事（地球）」→「TA的手记（实心铃铛）」→ 页面自己的按钮（字体 Aa 等）→ 用户圆形头像。
 */
export function DiaryBrandHeader({ view, onClose, onSwitch, avatarLabel, onAvatarClick, children }: {
  view: DiaryBrandView;
  onClose: () => void;
  onSwitch: (view: DiaryBrandView) => void;
  /** 头像按钮的无障碍说明，点了打开当前页面的设置 */
  avatarLabel: string;
  onAvatarClick: () => void;
  /** 页面自己的操作按钮（手记的字体 Aa 等），排在铃铛和头像之间 */
  children?: ReactNode;
}) {
  const [identity, setIdentity] = useState<UserIdentity | null>(null);

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
          {/* 实心铃铛：填充当前颜色、去掉描边 */}
          <Bell size={18} fill="currentColor" stroke="none" aria-hidden="true" />
        </button>
        {children}
        <button type="button" className="diary-brand-avatar" onClick={onAvatarClick} aria-label={avatarLabel}>
          {identity?.avatarUrl ? <img src={identity.avatarUrl} alt="" /> : <UserRound size={15} aria-hidden="true" />}
        </button>
      </span>
    </header>
  );
}
