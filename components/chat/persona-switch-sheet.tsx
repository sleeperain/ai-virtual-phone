"use client";

// components/chat/persona-switch-sheet.tsx
// 账号管理（切换用户面具）
//
// 从「主页」那个头像点进来的**独立页面**，不是弹窗、也不是叠在主页里的浮层。
// 渲染方式和钱包页 / 表情包管理完全一致：由 UserProfilePanel 早返回整页替换，
// 复用 PageShell，拥有自己的返回箭头并参与全局返回栈。
//
// 踩过的坑：一开始把这个页面放在主页的 <PageShell> 内部当浮层，结果
// 主页那套 `.user-profile-page-root .page-body { position:absolute; top:calc(...) }`
// 的自定义 CSS 会连带命中内层 PageShell 的 .page-body —— 内层内容被挪到外层
// 标题栏下方、背景又被强制透明，看起来就是「整页空白」。
// 早返回替换主页就没有这个问题。
//
// 底栏（chat-tab-bar）由本组件自己负责：挂载时收起、卸载时恢复。
// 不依赖 onBack 一定会被调用——无论是点返回箭头、手势后退还是别处把状态置回去，
// 只要组件卸载就一定把底栏还回来，不会卡在「底栏不见了」。

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

    // 整页打开时收起底部 tab 栏；卸载时无论走哪条路径都恢复
    useEffect(() => {
        window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: true }));
        return () => {
            window.dispatchEvent(new CustomEvent("chat-hide-tabbar", { detail: false }));
        };
    }, []);

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
        // 点当前账号：也直接返回——用户点条目就是「我要用这个」的意思，
        // 留在本页会让人以为没生效。
        if (identity.id !== activeId) {
            if (!switchActiveIdentity(identity.id)) return;
            setActiveId(identity.id);
            onSwitched?.(identity);
        }
        // 切换后立刻回主页：底栏由本组件的卸载清理逻辑恢复
        onBack();
    };

    return (
        <PageShell title="账号管理" onBack={onBack} className="account-manage-page">
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
