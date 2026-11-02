"use client";

// components/chat/backpack-transfer-picker.tsx
// 原生背包 · 目标选择
//
// mode="deliver"：我的背包 →「送给角色」，只列角色名（不带「的背包」后缀），
//                确认后由调用方转移归属并发礼物卡片。
// mode="transfer"（默认）：角色背包 →「放入到…」，可选我的背包与其他角色，
//                只做转移，不发卡片。

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
    /** deliver 回传选中的角色目标；transfer 回传 null（已在此处落地） */
    onDone: (target?: BackpackTarget | null) => void;
    toast?: (text: string) => void;
};

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
        // 放入到…：我的背包 + 其他角色
        return [{ id: "user", name: "我的背包", rawName: "我的背包", isUser: true }, ...characters];
    }, [mode, sourceCharacterId]);

    const handlePick = (target: BackpackTarget) => {
        if (mode === "deliver") {
            onDone(target);
            return;
        }
        // 「放入到…」只转移归属，不发卡片
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
        toast?.(target.isUser ? "已放回我的背包" : `已放入${target.name}`);
        onDone(null);
    };

    const title = mode === "deliver" ? "送给…" : "放入到…";

    return (
        <div className="bp-sub-overlay" onClick={onClose}>
            <div className="bp-sub-panel" onClick={e => e.stopPropagation()}>
                <div className="bp-sub-head">
                    <div>
                        <div className="bp-sub-title">{title}</div>
                        <div className="bp-sub-hint">
                            {mode === "deliver"
                                ? "物品会转进对方背包，并在聊天里发一张礼物卡片"
                                : `把「${item.title}」放到哪里`}
                        </div>
                    </div>
                </div>
                <div className="bp-sub-list">
                    {candidates.length === 0 ? (
                        <div className="bp-sub-empty">
                            没有可放入的目标{mode === "deliver" ? "（还没有其他角色）" : ""}
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
                                {/* 送给某角色时只显示角色名；放入到某处时显示完整背包名 */}
                                <span className="bp-pick-name">{mode === "deliver" ? t.rawName : t.name}</span>
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
