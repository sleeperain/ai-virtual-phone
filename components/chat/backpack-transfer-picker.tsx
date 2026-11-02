"use client";

// components/chat/backpack-transfer-picker.tsx
// 原生背包 · 转送目标选择
//
// mode="transfer"（默认）：角色背包 / 群礼物堆 →「放入到…」，可选我的背包与其他角色。
// mode="deliver"：我的背包 →「送给…」，只列角色名（不显示「【某角色】的背包」这种后缀）。

import { useMemo } from "react";
import { loadBackpackTargets, saveTransferTargets, loadTransferTargets } from "@/lib/backpack-storage";
import type { BackpackItem, BackpackTransferTarget } from "@/lib/backpack-types";

type BackpackTransferPickerProps = {
    item: BackpackItem;
    mode?: "transfer" | "deliver";
    onClose: () => void;
    /** deliver 模式回传选中的角色目标；transfer 模式回传 null（内部已直接落地） */
    onDone: (target?: BackpackTransferTarget | null) => void;
    toast?: (text: string) => void;
};

export function BackpackTransferPicker({
    item,
    mode = "transfer",
    onClose,
    onDone,
    toast,
}: BackpackTransferPickerProps) {
    const sourceIsUser = item.recipient === "user";
    const sourceSessionId = item.recipient === "user" ? "user" : item.sessionId;

    const candidates = useMemo(() => {
        const all = loadBackpackTargets();
        if (mode === "deliver") {
            // 送给角色：只列角色，且排除物品已经所在的那个会话
            return all.filter(t => !t.isUser && !t.isGroup && t.id !== item.sessionId);
        }
        if (sourceIsUser) {
            // 我的背包 → 放入到：角色背包（群礼物堆不在转送白名单里，与角色侧规则一致）
            return all.filter(t => !t.isUser && !t.isGroup);
        }
        // 角色背包 / 群礼物堆 → 放入到：我的背包 + 其他角色
        return all.filter(t => t.isUser || (!t.isGroup && t.id !== sourceSessionId));
    }, [mode, sourceIsUser, sourceSessionId, item.sessionId]);

    const handlePick = (target: BackpackTransferTarget) => {
        if (mode === "deliver") {
            onDone(target);
            return;
        }
        // 转送同时把目标记进该来源的白名单，下次列表里还能看到它
        try {
            const config = { ...loadTransferTargets() };
            const key = String(sourceSessionId || "");
            const current = new Set(config[key] ?? []);
            if (!target.isUser) current.add(target.id);
            config[key] = [...current];
            saveTransferTargets(config);
        } catch {
            /* 白名单写失败不影响这次转送本身 */
        }
        onDone(null);
    };

    const title = mode === "deliver"
        ? "送给…"
        : sourceIsUser
            ? "放入到…"
            : item.recipient === "group"
                ? "从礼物堆拿出到…"
                : "放入到…";

    return (
        <div className="bp-sub-overlay" onClick={onClose}>
            <div className="bp-sub-panel" onClick={e => e.stopPropagation()}>
                <div className="bp-sub-head">
                    <div>
                        <div className="bp-sub-title">{title}</div>
                        <div className="bp-sub-hint">
                            {mode === "deliver"
                                ? "选一位角色，物品会转到对方背包并发送礼物卡片"
                                : sourceIsUser
                                    ? "把「我的背包」里的这件物品放进谁的背包"
                                    : "把这件物品放进哪里"}
                        </div>
                    </div>
                </div>
                <div className="bp-sub-list">
                    {candidates.length === 0 ? (
                        <div className="bp-sub-empty">
                            没有可放入的目标
                            {mode === "deliver" ? "（还没有其他角色会话）" : ""}
                        </div>
                    ) : (
                        candidates.map(t => (
                            <div
                                key={t.id}
                                className="bp-pick-row"
                                onClick={() => handlePick(t)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={e => {
                                    if (e.key === "Enter" || e.key === " ") handlePick(t);
                                }}
                            >
                                <span className="bp-pick-name">
                                    {mode === "deliver" ? t.rawName : t.name}
                                </span>
                            </div>
                        ))
                    )}
                </div>
                <div className="bp-sub-foot">
                    <button type="button" className="bp-btn" data-variant="ghost" onClick={onClose}>
                        取消
                    </button>
                </div>
            </div>
        </div>
    );
}
