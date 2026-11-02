"use client";

// components/chat/backpack-modal.tsx
// 原生背包 · 主界面
//
// 归属只有两种：我的背包 / 某个角色的背包（不含群聊）。
// 顶部标题就是归属选择器，点一下弹角色列表；下面一行是搜索框。
// 我的背包里点物品是「送给…」（列角色名，送出会发卡片），
// 角色背包里是「放入到…」（转移，不发卡片）。

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    Ban,
    Check,
    Gift,
    ListChecks,
    Package,
    Plus,
    RefreshCw,
    Search,
    Sparkles,
    Trash2,
    X,
} from "lucide-react";
import {
    filterBackpackItems,
    loadBackpackItems,
    loadBackpackTargets,
    mutateBackpackItems,
    removeBackpackItems,
} from "@/lib/backpack-storage";
import { rescanShoppingOrders } from "@/lib/backpack-legacy";
import { BACKPACK_CHANGED_EVENT, type BackpackItem, type BackpackTarget } from "@/lib/backpack-types";
import { BackpackItemEditor } from "./backpack-item-editor";
import { BackpackTransferPicker } from "./backpack-transfer-picker";

export type BackpackDeliverRequest = {
    item: BackpackItem;
    /** 目标角色 id */
    targetCharacterId: string;
    /** 目标角色名，用于卡片与提示 */
    targetName: string;
};

type BackpackModalProps = {
    /** 当前聊天会话，决定打开时默认查看谁的背包 */
    sessionId?: string;
    /** 当前聊天的角色（私聊）——用于默认选中 */
    currentCharacterId?: string;
    onClose: () => void;
    /** 送给角色：由聊天室转移归属并发送礼物卡片 */
    onDeliver?: (request: BackpackDeliverRequest) => boolean;
    toast?: (text: string) => void;
};

export function BackpackModal({
    sessionId,
    currentCharacterId,
    onClose,
    onDeliver,
    toast,
}: BackpackModalProps) {
    const [targets, setTargets] = useState<BackpackTarget[]>([]);
    const [items, setItems] = useState<BackpackItem[]>([]);
    const [targetId, setTargetId] = useState<string>("user");
    const [targetPickerOpen, setTargetPickerOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [menuOpen, setMenuOpen] = useState(false);
    const [manageMode, setManageMode] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [editorState, setEditorState] = useState<{ item: BackpackItem | null } | null>(null);
    const [transferItem, setTransferItem] = useState<BackpackItem | null>(null);
    const [deliverItem, setDeliverItem] = useState<BackpackItem | null>(null);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(() => {
        setItems(loadBackpackItems());
        setTargets(loadBackpackTargets());
    }, []);

    useEffect(() => {
        const nextTargets = loadBackpackTargets();
        setTargets(nextTargets);
        // 私聊进来默认看对方背包，其它情况看我的背包
        setTargetId(currentCharacterId && nextTargets.some(t => t.id === currentCharacterId)
            ? currentCharacterId
            : "user");
        setItems(loadBackpackItems());
    }, [currentCharacterId]);

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
    const targetTitle = currentTarget?.name ?? "我的背包";

    const visibleItems = useMemo(() => {
        const owned = filterBackpackItems(items, targetId);
        const keyword = query.trim().toLowerCase();
        if (!keyword) return owned;
        return owned.filter(it => {
            const haystack = [
                it.title,
                it.source,
                it.note,
                it.value,
                it.date,
                it.shopping?.merchantLabel,
                it.shopping?.detail,
            ].filter(Boolean).join(" ").toLowerCase();
            return haystack.includes(keyword);
        });
    }, [items, targetId, query]);

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
        // 把新到货的订单商品补进「我的背包」；按订单号+商品号去重，重复点不会重复入包
        setBusy(true);
        try {
            const added = rescanShoppingOrders();
            refresh();
            toast?.(added > 0 ? `收录了 ${added} 件新到货商品` : "已同步全部背包物品");
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
        toast?.(inject
            ? `已将选中的 ${selected.size} 件物品注入角色背包记忆`
            : `已取消选中的 ${selected.size} 件物品记忆`);
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

    const confirmDeliver = (target: BackpackTarget) => {
        if (!deliverItem || !onDeliver) {
            setDeliverItem(null);
            return;
        }
        const ok = onDeliver({
            item: deliverItem,
            targetCharacterId: target.id,
            targetName: target.rawName,
        });
        if (ok) setDeliverItem(null);
        refresh();
    };

    const emptyHint = query.trim()
        ? `没有找到与「${query.trim()}」相关的物品`
        : "背包空空如也，点左上菜单「添加物品」或「重新扫描」";

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onClose}>
            <div
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

                    <button
                        type="button"
                        className="bp-title-btn"
                        onClick={e => {
                            e.stopPropagation();
                            setTargetPickerOpen(true);
                        }}
                    >
                        <span className="bp-header-title">{targetTitle}</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="6 9 12 15 18 9" />
                        </svg>
                    </button>

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

                <div className="bp-search-bar">
                    <Search size={14} strokeWidth={1.8} className="bp-search-icon" />
                    <input
                        className="bp-search-input"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={viewingUser ? "搜索我的物品" : "搜索他背包里的物品"}
                    />
                    {query && (
                        <button type="button" className="bp-search-clear" onClick={() => setQuery("")} aria-label="清空搜索">
                            <X size={13} strokeWidth={2.2} />
                        </button>
                    )}
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
                            const showBadge = item.recipient === "character" && item.injected;

                            const noteText = item.note && item.note.trim();
                            let subText = noteText || item.source || "未标注";
                            if (item.recipient === "user" && !manageMode && visCount === 0 && !noteText) {
                                subText = "尚未让任何角色知道 · 点开可设置";
                            }

                            return (
                                <div
                                    key={item.id}
                                    className="bp-item"
                                    data-selected={isSelected ? "true" : undefined}
                                    onClick={() => {
                                        if (manageMode) toggleSelect(item.id);
                                        else setEditorState({ item });
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
                                        {showBadge && (
                                            <span className="bp-item-badge" title="已注入角色背包记忆">✓</span>
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
                        <div className="bp-batch-ops" style={{ gridTemplateColumns: `repeat(${viewingUser ? 1 : 3}, 1fr)` }}>
                            {!viewingUser && (
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
                        isUserTarget={viewingUser}
                        onClose={() => setEditorState(null)}
                        onSaved={() => {
                            setEditorState(null);
                            refresh();
                        }}
                        onTransfer={item => {
                            // 我的背包 → 「送给…」（发卡片）；角色背包 → 「放入到…」（纯转移）
                            if (item.recipient === "user") setDeliverItem(item);
                            else setTransferItem(item);
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

                {targetPickerOpen && (
                    <div className="bp-sub-overlay" onClick={() => setTargetPickerOpen(false)}>
                        <div className="bp-sub-panel" onClick={e => e.stopPropagation()}>
                            <div className="bp-sub-head">
                                <div>
                                    <div className="bp-sub-title">查看谁的背包</div>
                                    <div className="bp-sub-hint">群聊不在其中，礼物一律归到具体角色</div>
                                </div>
                            </div>
                            <div className="bp-sub-list">
                                {targets.map(t => (
                                    <div
                                        key={t.id}
                                        className="bp-pick-row"
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => {
                                            setTargetId(t.id);
                                            setTargetPickerOpen(false);
                                        }}
                                        onKeyDown={e => {
                                            if (e.key === "Enter" || e.key === " ") {
                                                setTargetId(t.id);
                                                setTargetPickerOpen(false);
                                            }
                                        }}
                                    >
                                        <span className="bp-pick-name">{t.name}</span>
                                        {t.id === targetId && <Check size={14} strokeWidth={2.2} className="bp-pick-check-mark" />}
                                    </div>
                                ))}
                            </div>
                            <div className="bp-sub-foot">
                                <button type="button" className="bp-btn" data-variant="ghost" onClick={() => setTargetPickerOpen(false)}>
                                    关闭
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {visibleItems.length === 0 && !manageMode && !query.trim() && (
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

                {visibleItems.length === 0 && !manageMode && query.trim() && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "0 16px 14px" }}>
                        <button type="button" className="bp-btn" data-variant="ghost" onClick={() => setQuery("")}>
                            清空搜索
                        </button>
                    </div>
                )}

            </div>
        </div>
    );
}

/** 供物品详情弹窗决定底部按钮文案 */
export function resolveTransferButtonLabel(item: BackpackItem, viewingUser: boolean): string {
    if (viewingUser || item.recipient === "user") return "送给…";
    return "放入到…";
}
