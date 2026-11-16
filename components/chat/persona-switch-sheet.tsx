"use client";

// components/chat/persona-switch-sheet.tsx
// 切换账号（用户面具）
//
// 从「主页」那个头像点出来的弹窗：列当前所有面具，点头像/昵称即切换。
// 这里刻意只放头像 + 昵称，不列角色、不做设置——角色归哪个面具
// 由「设置 → 绑定 → 角色 → 用户身份」决定（见 lib/persona-scope.ts 的说明），
// 不在切换的地方重复配置，避免出现两个地方都能改同一件事。

import { useEffect, useMemo, useState } from "react";
import { Check, User, X } from "lucide-react";
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
        return () => window.removeEventListener(PERSONA_SWITCHED_EVENT, sync);
    }, []);

    const items = useMemo(() => identities, [identities]);

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
        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={onClose}>
            <div
                className="modal-sheet"
                data-ui="modal-sheet"
                onClick={e => e.stopPropagation()}
            >
                <div className="modal-header" data-ui="modal-header">
                    <span className="modal-header-title">切换账号</span>
                    <button
                        type="button"
                        onClick={onClose}
                        className="modal-header-btn modal-header-btn-muted"
                        aria-label="关闭"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="modal-body hide-scrollbar flex flex-col gap-1.5 pb-10" data-ui="modal-body">
                    {items.length === 0 ? (
                        <div className="ts-13 text-[var(--c-icon)] text-center py-8">
                            还没有账号。请先到「设置 → 用户身份」新建一个。
                        </div>
                    ) : (
                        items.map(identity => {
                            const active = identity.id === activeId;
                            return (
                                <button
                                    key={identity.id}
                                    type="button"
                                    onClick={() => handlePick(identity)}
                                    className="flex items-center gap-3 w-full px-3 py-2.5 rounded-2xl text-left transition-colors"
                                    style={{
                                        background: active
                                            ? "color-mix(in srgb, var(--c-success) 12%, transparent)"
                                            : "transparent",
                                        border: `1px solid ${active ? "color-mix(in srgb, var(--c-success) 38%, transparent)" : "transparent"}`,
                                    }}
                                    aria-pressed={active}
                                >
                                    <div className="w-[42px] h-[42px] rounded-full overflow-hidden bg-[var(--c-input)] flex items-center justify-center shrink-0">
                                        {identity.avatarUrl ? (
                                            /* eslint-disable-next-line @next/next/no-img-element */
                                            <img
                                                src={identity.avatarUrl}
                                                alt=""
                                                className="w-full h-full object-cover"
                                                referrerPolicy="no-referrer"
                                            />
                                        ) : (
                                            <User size={20} className="text-[var(--c-icon)]" />
                                        )}
                                    </div>
                                    <span className="flex-1 min-w-0 ts-15 font-semibold text-[var(--c-text-title)] truncate">
                                        {identity.name || "未命名账号"}
                                    </span>
                                    {active && (
                                        <Check size={18} className="shrink-0" style={{ color: "var(--c-success)" }} />
                                    )}
                                </button>
                            );
                        })
                    )}
                </div>
            </div>
        </div>
    );
}
