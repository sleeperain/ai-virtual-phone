"use client";

// components/chat/backpack-transfer-picker.tsx
// 原生背包 · 目标选择
//
// 结构与 class 照搬「背包」插件 3.25.0 的转送浮层：
//   浮层 backdrop + 12px 圆角面板 + bp-transfer-item 列表
// mode="deliver"：我的背包 →「送给…」，只列角色名，由调用方转移归属并发卡片
// mode="transfer"：角色背包 →「放入到…」，可选我的背包与其他角色，只转移

import { useMemo } from "react";
import {
    loadCharacterTargets,
    loadTransferTargets,
    moveBackpackItem,
    saveTransferTargets,
} from "@/lib/backpack-storage";
import type { BackpackItem, BackpackTarget } from "@/lib/backpack-types";
import { appToastId, showAppToast } from "@/lib/app-toast";

type BackpackTransferPickerProps = {
    item: BackpackItem;
    mode?: "transfer" | "deliver";
    onClose: () => void;
    onDone: (target?: BackpackTarget | null) => void;
};

const TS = (px: number) => `calc(${px}px * var(--app-text-scale, 1))`;

/** 与 backpack-modal 一致：走 app 级 toast，弹窗打开时也看得见 */
function toast(text: string): void {
    showAppToast({ id: appToastId("backpack"), text });
}

export function BackpackTransferPicker({
    item,
    mode = "transfer",
    onClose,
    onDone,
}: BackpackTransferPickerProps) {
    const sourceCharacterId = item.recipient === "character" ? item.characterId : "";

    const candidates = useMemo(() => {
        const characters = loadCharacterTargets(sourceCharacterId);
        if (mode === "deliver") return characters;
        return [{ id: "user", name: "我的背包", rawName: "我的背包", isUser: true }, ...characters];
    }, [mode, sourceCharacterId]);

    const handlePick = (target: BackpackTarget) => {
        if (mode === "deliver") {
            onDone(target);
            return;
        }
        const moved = moveBackpackItem(item.id, target.id);
        if (!moved) {
            toast("放入失败");
            return;
        }
        // 顺手把目标记进该来源的白名单，下次列表里还能看到它
        try {
            const config = { ...loadTransferTargets() };
            const key = String(sourceCharacterId || "user");
            const current = new Set(config[key] ?? []);
            if (!target.isUser) current.add(target.id);
            config[key] = [...current];
            saveTransferTargets(config);
        } catch {
            /* 白名单写失败不影响这次转送本身 */
        }
        toast(target.isUser ? "已放入到我的背包" : `已放入到${target.name}`);
        onDone(null);
    };

    return (
        <div className="bp-sub-overlay" onClick={onClose}>
            {/* 和「查看谁的背包」「让哪些角色知道这件物品」共用同一套 .bp-sub-panel：
                宽 min(78vw,300px)、高度按内容长、超额在列表里滑动。
                遮罩 .bp-sub-overlay 已是 fixed + z-index 10000，能压过详情弹窗的 .modal-overlay */}
            <div className="bp-sub-panel" onClick={e => e.stopPropagation()}>
                <div className="bp-sub-head">
                    <div className="bp-sub-title">
                        {mode === "deliver" ? "送给…" : "放入到"}
                    </div>
                </div>

                <div className="bp-sub-list">
                    {candidates.length === 0 ? (
                        <div className="bp-sub-empty">
                            {mode === "deliver" ? "还没有可送礼的角色" : "没有可放入的目标"}
                        </div>
                    ) : (
                        candidates.map(t => (
                            <div
                                key={t.id}
                                className="bp-transfer-item"
                                onClick={() => handlePick(t)}
                            >
                                {/* 和「查看谁的背包」一致：只显示人名（「我的背包」也照原样），
                                    不再拼成「【角色名】的背包」 */}
                                {t.rawName}
                            </div>
                        ))
                    )}
                </div>

                <div className="bp-sub-foot">
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            border: "none",
                            background: "rgba(128,128,128,0.12)",
                            color: "var(--c-text)",
                            padding: "6px 14px",
                            borderRadius: 6,
                            fontSize: TS(12),
                            cursor: "pointer",
                        }}
                    >
                        取消
                    </button>
                </div>
            </div>
        </div>
    );
}
