"use client";

// components/chat/backpack-modal.tsx
// 原生背包 · 主界面
//
// 归属切换：我的背包 / 每个私聊角色的背包 / 每个群的礼物堆。
// 「送给…」只出现在我的背包（列角色名）；角色背包与群礼物堆用「放入到…」。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Ban,
    Eye,
    Gift,
    ListChecks,
    Package,
    Plus,
    RefreshCw,
    Sparkles,
    Trash2,
    X,
} from "lucide-react";
import {
    ensureBackpackMigrated,
    loadBackpackItems,
    loadBackpackTargets,
    mutateBackpackItems,
    removeBackpackItems,
    resetBackpackMigrationFlag,
    updateBackpackItem,
} from "@/lib/backpack-storage";
import { BACKPACK_CHANGED_EVENT, type BackpackItem, type BackpackTransferTarget } from "@/lib/backpack-types";
import { BackpackItemEditor } from "./backpack-item-editor";
import { BackpackTransferPicker } from "./backpack-transfer-picker";

export type BackpackDeliverRequest = {
    item: BackpackItem;
    /** 目标角色会话 id */
    targetSessionId: string;
    /** 目标角色名，用于卡片标题与提示 */
    targetName: string;
};

type BackpackModalProps = {
    /** 当前聊天会话，用于默认选中并决定送卡去向 */
    sessionId?: string;
    onClose: () => void;
    /** 送出购物/背包物品给角色：由聊天室发一张礼物卡片 */
    onDeliver?: (request: BackpackDeliverRequest) => void;
    toast?: (text: string) => void;
};

function resolveDefaultTargetId(sessionId: string | undefined, targets: BackpackTransferTarget[]): string {
    if (!sessionId) return "user";
    const matched = targets.find(t => t.id === sessionId);
    return matched ? matched.id : "user";
}

export function BackpackModal({ sessionId, onClose, onDeliver, toast }: BackpackModalProps) {
    const [targets, setTargets] = useState<BackpackTransferTarget[]>([]);
    const [items, setItems] = useState<BackpackItem[]>([]);
    const [targetId, setTargetId] = useState<string>("user");
    const [menuOpen, setMenuOpen] = useState(false);
    const [manageMode, setManageMode] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [editorState, setEditorState] = useState<{ item: BackpackItem | null } | null>(null);
    const [transferItem, setTransferItem] = useState<BackpackItem | null>(null);
    const [deliverItem, setDeliverItem] = useState<BackpackItem | null>(null);
    const [busy, setBusy] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    const refresh = useCallback(() => {
        setItems(loadBackpackItems());
        setTargets(loadBackpackTargets());
    }, []);

    useEffect(() => {
        const nextTargets = loadBackpackTargets();
        setTargets(nextTargets);
        setTargetId(prev => (prev === "user" ? resolveDefaultTargetId(sessionId, nextTargets) : prev));
        setItems(loadBackpackItems());
    }, [sessionId]);

    useEffect(() => {
        const handler = () => refresh();
        window.addEventListener(BACKPACK_CHANGED_EVENT, handler);
        return () => window.removeEventListener(BACKPACK_CHANGED_EVENT, handler);
    }, [refresh]);

    const currentTarget = useMemo(
        () => targets.find(t => t.id === targetId) ?? targets[0],
        [targets, targetId],
    );

    const viewingUser = targetId === "user";
    const viewingGroup = currentTarget?.isGroup === true;

    const visibleItems = useMemo(() => {
        if (viewingUser) return items.filter(it => it.recipient === "user");
        if (viewingGroup) return items.filter(it => it.recipient === "group" && it.sessionId === targetId);
        return items.filter(it => it.recipient === "character" && it.sessionId === targetId);
    }, [items, targetId, viewingUser, viewingGroup]);

    useEffect(() => {
        setSelected(new Set());
    }, [targetId]);

    const toggleSelect = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleRescan = () => {
        setMenuOpen(false);
        // 重新跑一遍迁移：把新到货的订单商品补进「我的背包」。
        // 迁移按订单号+商品号去重，重复点不会产出重复物品。
        setBusy(true);
        try {
            resetBackpackMigrationFlag();
            ensureBackpackMigrated();
            refresh();
            toast?.("已同步全部背包物品");
        } finally {
            setBusy(false);
        }
    };

    const handleBatchInject = (inject: boolean) => {
        if (selected.size === 0) {
            toast?.("未勾选任何物品");
            return;
        }
        mutateBackpackItems(list => {
            for (const item of list) {
                if (!selected.has(item.id)) continue;
                if (item.recipient !== "character") continue;
                item.injected = inject;
            }
        });
        toast?.(inject ? `已将选中的 ${selected.size} 件物品注入角色背包记忆` : `已取消选中的 ${selected.size} 件物品记忆`);
        refresh();
    };

    const handleBatchDelete = () => {
        if (selected.size === 0) {
            toast?.("未勾选任何物品");
            return;
        }
        removeBackpackItems([...selected]);
        toast?.(`已从背包中移除 ${selected.size} 件物品`);
        setSelected(new Set());
        refresh();
    };

    const openDeliverPicker = (item: BackpackItem) => {
        setDeliverItem(item);
    };

    const confirmDeliver = (target: BackpackTransferTarget) => {
        if (!deliverItem || !onDeliver) return;
        onDeliver({
            item: deliverItem,
            targetSessionId: target.id,
            targetName: target.rawName,
        });
        setDeliverItem(null);
        // 送出后物品转移到角色背包
        updateBackpackItem(deliverItem.id, {
            recipient: "character",
            sessionId: target.id,
            visibleTo: [],
            injected: true,
            timestamp: Date.now(),
        });
        refresh();
    };

    const emptyHint = viewingGroup
        ? "群里还没有礼物。群成员送出的礼物会自动出现在这里"
        : "背包空空如也，点左上菜单「添加物品」或「重新扫描」";

    const batchOpColumns = viewingUser || viewingGroup ? 1 : 3;

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onClose}>
            <div
                ref={rootRef}
                className="bp-modal"
                onClick={e => {
                    e.stopPropagation();
                    setMenuOpen(false);
                }}
            >
                <div className="bp-header" style={{ position: "relative" }}>
                    <button
                        type="button"
                        className="bp-icon-btn bp-header-left"
                        aria-label="菜单"
                        onClick={e => {
                            e.stopPropagation();
                            setMenuOpen(v => !v);
                        }}
                    >
                        <ListChecks />
                    </button>
                    <span className="bp-header-title">背包</span>
                    <button type="button" className="bp-icon-btn bp-header-right" aria-label="关闭" onClick={onClose}>
                        <X />
                    </button>

                    {menuOpen && (
                        <div className="bp-dropdown" onClick={e => e.stopPropagation()}>
                            <button type="button" className="bp-dropdown-item" onClick={() => {
                                setMenuOpen(false);
                                setEditorState({ item: null });
                            }}>
                                <Plus />
                                <span>添加物品</span>
                            </button>
                            <button type="button" className="bp-dropdown-item" onClick={handleRescan} disabled={busy}>
                                <RefreshCw />
                                <span>重新扫描</span>
                            </button>
                            <button type="button" className="bp-dropdown-item" onClick={() => {
                                setMenuOpen(false);
                                setManageMode(true);
                                setSelected(new Set());
                            }}>
                                <ListChecks />
                                <span>批量管理</span>
                            </button>
                        </div>
                    )}
                </div>

                <div className="bp-select-bar">
                    <span className="bp-select-label">正在查看</span>
                    <select
                        className="bp-select"
                        value={targetId}
                        onChange={e => setTargetId(e.target.value)}
                    >
                        {targets.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                    </select>
                </div>

                <div className="bp-list">
                    {visibleItems.length === 0 ? (
                        <div className="bp-empty">
                            <Package size={36} strokeWidth={1.2} />
                            <div className="bp-empty-hint">{emptyHint}</div>
                        </div>
                    ) : (
                        visibleItems.map(item => {
                            const isSelected = selected.has(item.id);
                            const visCount = Array.isArray(item.visibleTo) ? item.visibleTo.filter(Boolean).length : 0;
                            let badge: { kind?: string; text: string; title: string } | null = null;
                            if (item.recipient === "character" && item.injected) {
                                badge = { text: "✓", title: "已注入角色背包记忆" };
                            } else if (item.recipient === "user" && visCount > 0) {
                                badge = { kind: "eye", text: String(visCount), title: `${visCount} 个角色可见` };
                            } else if (item.recipient === "group") {
                                badge = {
                                    kind: "group",
                                    text: visCount > 0 ? String(visCount) : "群",
                                    title: `群礼物堆${visCount > 0 ? ` · ${visCount} 个角色可见` : ""}`,
                                };
                            }

                            const noteText = item.note && item.note.trim();
                            let subText: string;
                            if (item.recipient === "group") {
                                const giver = item.giver || item.source || "群友";
                                subText = noteText ? `由 ${giver} 赠予 · ${noteText}` : `由 ${giver} 赠予`;
                            } else {
                                subText = noteText || item.source || "未标注";
                            }
                            if (item.recipient === "user" && !manageMode && visCount === 0 && !noteText) {
                                subText = "尚未让任何角色知道 · 点开可设置";
                            }

                            return (
                                <div
                                    key={item.id}
                                    className="bp-item"
                                    data-selected={isSelected ? "true" : undefined}
                                    onClick={() => {
                                        if (manageMode) {
                                            toggleSelect(item.id);
                                        } else {
                                            setEditorState({ item });
                                        }
                                    }}
                                >
                                    {manageMode && (
                                        <input
                                            type="checkbox"
                                            className="bp-item-check"
                                            checked={isSelected}
                                            onChange={() => toggleSelect(item.id)}
                                            onClick={e => e.stopPropagation()}
                                        />
                                    )}
                                    <div className="bp-item-icon">
                                        {item.customImage ? (
                                            <img src={item.customImage} alt="" className="bp-item-icon-img" />
                                        ) : item.previewIcon ? (
                                            <span aria-hidden>{item.previewIcon}</span>
                                        ) : (
                                            <Gift size={18} strokeWidth={1.6} />
                                        )}
                                        {badge && (
                                            <span className="bp-item-badge" data-kind={badge.kind} title={badge.title}>
                                                {badge.text}
                                            </span>
                                        )}
                                    </div>
                                    <div className="bp-item-body">
                                        <div className="bp-item-title">{item.title}</div>
                                        <div className="bp-item-sub">{subText}</div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                {manageMode && (
                    <div className="bp-batch-bar">
                        <div className="bp-batch-top">
                            <div className="bp-batch-left">
                                <button
                                    type="button"
                                    className="bp-text-btn"
                                    onClick={() => {
                                        if (selected.size === visibleItems.length) setSelected(new Set());
                                        else setSelected(new Set(visibleItems.map(it => it.id)));
                                    }}
                                >
                                    {selected.size === visibleItems.length && visibleItems.length > 0 ? "取消全选" : "全选"}
                                </button>
                                <span className="bp-batch-count">已选 {selected.size} 项</span>
                            </div>
                            <button
                                type="button"
                                className="bp-text-btn"
                                data-tone="muted"
                                onClick={() => {
                                    setManageMode(false);
                                    setSelected(new Set());
                                }}
                            >
                                退出管理
                            </button>
                        </div>
                        <div className="bp-batch-ops" style={{ gridTemplateColumns: `repeat(${batchOpColumns}, 1fr)` }}>
                            {!viewingUser && !viewingGroup && (
                                <>
                                    <button
                                        type="button"
                                        className="bp-batch-op"
                                        style={{ background: "color-mix(in srgb, var(--c-success) 14%, transparent)", color: "var(--c-success)" }}
                                        onClick={() => handleBatchInject(true)}
                                    >
                                        <Sparkles />
                                        <span>注入记忆</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="bp-batch-op"
                                        style={{ background: "var(--c-input)", color: "var(--c-text)" }}
                                        onClick={() => handleBatchInject(false)}
                                    >
                                        <Ban />
                                        <span>取消注入</span>
                                    </button>
                                </>
                            )}
                            {(viewingUser || viewingGroup) && (
                                <button
                                    type="button"
                                    className="bp-batch-op"
                                    style={{ background: "color-mix(in srgb, #3b82f6 12%, transparent)", color: "#3b82f6" }}
                                    onClick={() => {
                                        if (selected.size === 0) {
                                            toast?.("未勾选任何物品");
                                            return;
                                        }
                                        toast?.("可见范围设置请在物品详情里逐件调整");
                                    }}
                                >
                                    <Eye />
                                    <span>可见角色</span>
                                </button>
                            )}
                            <button
                                type="button"
                                className="bp-batch-op"
                                style={{ background: "color-mix(in srgb, var(--c-danger) 12%, transparent)", color: "var(--c-danger)" }}
                                onClick={handleBatchDelete}
                            >
                                <Trash2 />
                                <span>删除</span>
                            </button>
                        </div>
                    </div>
                )}

                {editorState && (
                    <BackpackItemEditor
                        item={editorState.item}
                        isNew={editorState.item === null}
                        targetId={targetId}
                        targetName={currentTarget?.rawName ?? ""}
                        isGroupTarget={viewingGroup}
                        isUserTarget={viewingUser}
                        onClose={() => setEditorState(null)}
                        onSaved={() => {
                            setEditorState(null);
                            refresh();
                        }}
                        onTransfer={item => {
                            setTransferItem(item);
                        }}
                        toast={toast}
                    />
                )}

                {transferItem && (
                    <BackpackTransferPicker
                        item={transferItem}
                        onClose={() => setTransferItem(null)}
                        onDone={() => {
                            setTransferItem(null);
                            refresh();
                        }}
                        toast={toast}
                    />
                )}

                {deliverItem && (
                    <BackpackTransferPicker
                        item={deliverItem}
                        mode="deliver"
                        onClose={() => setDeliverItem(null)}
                        onDone={target => {
                            if (target) confirmDeliver(target);
                            else setDeliverItem(null);
                        }}
                        toast={toast}
                    />
                )}

                {/* 首屏无物品时给个进入点，避免用户以为坏了 */}
                {visibleItems.length === 0 && !manageMode && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "0 16px 14px" }}>
                        <button
                            type="button"
                            className="bp-btn"
                            data-variant="accent"
                            onClick={() => setEditorState({ item: null })}
                        >
                            <Plus size={13} />
                            <span>添加物品</span>
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}


