"use client";

// components/chat/persona-switch-sheet.tsx
// 账号管理（切换用户面具）
//
// 从「主页」那个头像点进来的**独立页面**，不是弹窗。
// 复用 components/ui/page-shell 的 PageShell：和设置页、钱包页一样是整页导航，
// 有左上角返回箭头、参与全局返回栈（返回手势 / 浏览器后退都能退）。
//
// 只放头像 + 昵称，不列角色、不做设置：角色归哪个账号由
// 「设置 → 绑定 → 角色 → 用户身份」决定（见 lib/persona-scope.ts），
// 不在切换的地方重复配置，避免同一件事有两个入口。

import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import type { UserIdentity } from "@/components/settings/user-identity";
import {
    loadIdentities,
    resolveActiveIdentityId,
    switchActiveIdentity,
    PERSONA_SWITCHED_EVENT,
} from "@/lib/persona-scope";

type AccountManagePageProps = {
    onBack: () => void;
    /** 切换成功后回调（带新的面具） */
    onSwitched?: (identity: UserIdentity) => void;
};

export function AccountManagePage({ onBack, onSwitched }: AccountManagePageProps) {
    const [identities, setIdentities] = useState<UserIdentity[]>(() => loadIdentities());
    const [activeId, setActiveId] = useState<string>(() => resolveActiveIdentityId());

    // 别处改过账号（设置页新增/改名/删除）后回到本页要对得上
    useEffect(() => {
        const sync = () => {
            setIdentities(loadIdentities());
            setActiveId(resolveActiveIdentityId());
        };
        sync();
        window.addEventListener(PERSONA_SWITCHED_EVENT, sync);
        window.addEventListener("settings-identities-updated", sync);
        return () => {
            window.removeEventListener(PERSONA_SWITCHED_EVENT, sync);
            window.removeEventListener("settings-identities-updated", sync);
        };
    }, []);

    const handlePick = (identity: UserIdentity) => {
        // 点当前账号：什么都不用做，留在本页
        if (identity.id === activeId) return;
        if (!switchActiveIdentity(identity.id)) return;
        setActiveId(identity.id);
        onSwitched?.(identity);
    };

    return (
        <PageShell
            title="账号管理"
            onBack={onBack}
            // 整页覆盖在主页之上：主页可能有自己的渐变底和隐藏的标题栏
            className="account-manage-page absolute inset-0 z-[100]"
        >
            {identities.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <User size={24} />
                    </div>
                    <span className="menu-label font-semibold">还没有账号</span>
                    <span className="menu-desc max-w-[240px]">
                        先到「设置 → 用户身份」新建一个身份卡片
                    </span>
                </div>
            ) : (
                <>
                    <div className="account-manage-list">
                        {identities.map(identity => {
                            const active = identity.id === activeId;
                            return (
                                <button
                                    key={identity.id}
                                    type="button"
                                    onClick={() => handlePick(identity)}
                                    className={`account-manage-row${active ? " is-active" : ""}`}
                                    aria-pressed={active}
                                    aria-label={active ? `${identity.name}（当前账号）` : `切换到 ${identity.name}`}
                                >
                                    <span className="account-manage-avatar">
                                        {identity.avatarUrl ? (
                                            /* eslint-disable-next-line @next/next/no-img-element */
                                            <img
                                                src={identity.avatarUrl}
                                                alt=""
                                                referrerPolicy="no-referrer"
                                            />
                                        ) : (
                                            <User size={20} />
                                        )}
                                    </span>
                                    {/* 只有头像和昵称 */}
                                    <span className="account-manage-name">
                                        {identity.name || "未命名账号"}
                                    </span>
                                    {active && (
                                        <span className="account-manage-badge">当前账号</span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                    <p className="menu-group-desc account-manage-hint">
                        点一下即可切换。每个账号只看到归属于它的角色；角色归谁在「设置 → 绑定 → 角色 → 用户身份」里设置。
                    </p>
                </>
            )}
        </PageShell>
    );
}
