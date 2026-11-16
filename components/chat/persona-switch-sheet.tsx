"use client";

// components/chat/persona-switch-sheet.tsx
// 切换账号（用户面具）
//
// 从「主页」那个头像点出来的弹窗：列当前所有面具，点头像/昵称即切换。
//
// 复用 components/ui/modal 的 BottomSheet：和设置里的身份编辑、各处底部抽屉
// 是同一套 .modal-overlay-bottom + .modal-sheet + .modal-header，不再自己手写
// 遮罩和标题栏——之前那版是自己拼的，观感与全站其它弹窗不一致。
//
// 只放头像 + 昵称，不列角色、不做设置：角色归哪个面具由
// 「设置 → 绑定 → 角色 → 用户身份」决定（见 lib/persona-scope.ts），
// 不在切换的地方重复配置，避免同一件事有两个入口。

import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { BottomSheet } from "@/components/ui/modal";
import type { UserIdentity } from "@/components/settings/user-identity";
import {
    loadIdentities,
    resolveActiveIdentityId,
    switchActiveIdentity,
    PERSONA_SWITCHED_EVENT,
} from "@/lib/persona-scope";

type PersonaSwitchSheetProps = {
    onClose: () => void;
    /** 切换成功后回调（带新的面具） */
    onSwitched?: (identity: UserIdentity) => void;
};

export function PersonaSwitchSheet({ onClose, onSwitched }: PersonaSwitchSheetProps) {
    const [identities, setIdentities] = useState<UserIdentity[]>(() => loadIdentities());
    const [activeId, setActiveId] = useState<string>(() => resolveActiveIdentityId());

    // 别处改过面具（设置页新增/改名/删除）后重新打开要对得上
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
        if (identity.id === activeId) {
            onClose();
            return;
        }
        if (!switchActiveIdentity(identity.id)) return;
        setActiveId(identity.id);
        onSwitched?.(identity);
        onClose();
    };

    return (
        <BottomSheet title="切换账号" onClose={onClose}>
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
                <div className="persona-switch-list">
                    {identities.map(identity => {
                        const active = identity.id === activeId;
                        return (
                            <button
                                key={identity.id}
                                type="button"
                                onClick={() => handlePick(identity)}
                                className={`persona-switch-row${active ? " is-active" : ""}`}
                                aria-pressed={active}
                            >
                                <span className="persona-switch-avatar">
                                    {identity.avatarUrl ? (
                                        /* eslint-disable-next-line @next/next/no-img-element */
                                        <img
                                            src={identity.avatarUrl}
                                            alt=""
                                            referrerPolicy="no-referrer"
                                        />
                                    ) : (
                                        <User size={22} />
                                    )}
                                </span>
                                {/* 只有头像和昵称：条目之间留白拉开，不再挤成一行 */}
                                <span className="persona-switch-name">
                                    {identity.name || "未命名账号"}
                                </span>
                                {/* 用文字标注代替打勾：一眼看出这是「正在用的那个」 */}
                                {active && (
                                    <span className="persona-switch-badge">当前账号</span>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </BottomSheet>
    );
}
