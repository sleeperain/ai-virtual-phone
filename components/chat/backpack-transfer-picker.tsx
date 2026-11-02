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

type BackpackTransferPickerProps = {
    item: BackpackItem;
    mode?: "transfer" | "deliver";
    onClose: () => void;
    onDone: (target?: BackpackTarget | null) => void;
    toast?: (text: string) => void;
};

const TS = (px: number) => `calc(${px}px * var(--app-text-scale, 1))`;

export function BackpackTransferPicker({
    item,
    mode = "transfer",
    onClose,
    onDone,
    toast,
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
            toast?.("放入失败");
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
        toast?.(target.isUser ? "已放入到我的背包" : `已放入到${target.name}`);
        onDone(null);
    };

    return (
        <div
            className="bp-sub-overlay"
            onClick={onClose}
            style={{
                position: "absolute",
                inset: 0,
                background: "rgba(0,0,0,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 50,
                padding: 20,
            }}
        >
            <div
                onClick={e => e.stopPropagation()}
                style={{
                    background: "var(--c-page-body-bg,#fff)",
                    borderRadius: 12,
                    width: "100%",
                    maxWidth: 320,
                    overflow: "hidden",
                    boxShadow: "0 12px 32px rgba(0,0,0,0.3)",
                }}
            >
                <div style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid rgba(128,128,128,0.12)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                }}>
                    <span style={{ fontWeight: 600, fontSize: TS(13), color: "var(--c-text)" }}>
                        {mode === "deliver" ? "送给…" : "放入到"}
                    </span>
                </div>

                <div style={{ maxHeight: 280, overflowY: "auto", padding: 6 }}>
                    {candidates.length === 0 ? (
                        <div style={{
                            padding: "24px 12px",
                            textAlign: "center",
                            fontSize: TS(12),
                            color: "var(--c-icon)",
                        }}>
                            没有可放入的目标
                        </div>
                    ) : (
                        candidates.map(t => (
                            <div
                                key={t.id}
                                className="bp-transfer-item"
                                onClick={() => handlePick(t)}
                            >
                                {/* 送给某角色只显示角色名；放入到某处显示完整背包名 */}
                                {mode === "deliver" ? t.rawName : t.name}
                            </div>
                        ))
                    )}
                </div>

                <div style={{
                    padding: "8px 12px",
                    borderTop: "1px solid rgba(128,128,128,0.12)",
                    display: "flex",
                    justifyContent: "flex-end",
                }}>
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
