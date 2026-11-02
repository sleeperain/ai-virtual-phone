"use client";

// components/chat/backpack-modal.tsx
// 原生背包 · 主界面
//
// 本文件的结构与 class 名照搬「背包」插件 3.25.0 的主弹窗：
//   backpack-modal-box / backpack-scroll-content / backpack-card-item
//   backpack-icon-wrap / backpack-icon-sparkle-badge / backpack-batch-bar
//   backpack-batch-btn / backpack-dropdown-menu / backpack-menu-action
// 改动仅两处：
//   1. 数据来自原生 lib/backpack-*，不再走插件 ctx
//   2. 「正在查看」那行换成搜索框；标题变成归属选择器（不含群聊）

import { useCallback, useEffect, useMemo, useState } from "react";
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
    targetCharacterId: string;
    targetName: string;
};

type BackpackModalProps = {
    sessionId?: string;
    currentCharacterId?: string;
    onClose: () => void;
    onDeliver?: (request: BackpackDeliverRequest) => boolean;
    toast?: (text: string) => void;
};

/* ── 图标：尺寸与 stroke 照搬插件 ICONS ── */
const IconMenu = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" y1="6" x2="20" y2="6" />
        <line x1="4" y1="12" x2="15" y2="12" />
        <line x1="4" y1="18" x2="9" y2="18" />
    </svg>
);
const IconClose = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);
const IconPlus = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);
const IconRefresh = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
        <path d="M3 3v5h5" />
        <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
        <path d="M16 21h5v-5" />
    </svg>
);
const IconManage = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m9 11 3 3L22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
);
const IconSparkles = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
);
const IconBan = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="m4.9 4.9 14.2 14.2" />
    </svg>
);
const IconEye = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);
const IconTrash = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6h18" />
        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
);
const IconEmptyBox = () => (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--c-icon, #9ca3af)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="m7.5 4.27 9 5.15" />
        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
        <path d="m3.3 7 8.7 5 8.7-5" />
        <path d="M12 22V12" />
    </svg>
);
const IconGift = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="8" width="18" height="4" rx="1" />
        <path d="M12 8v13" />
        <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
        <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />
    </svg>
);
const IconSearch = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" />
        <line x1="16" y1="16" x2="21" y2="21" />
    </svg>
);
const IconChevron = () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
    </svg>
);

const TS = (px: number) => `calc(${px}px * var(--app-text-scale, 1))`;

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
    const [pickerOpen, setPickerOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [menuOpen, setMenuOpen] = useState(false);
    const [manageMode, setManageMode] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [editorState, setEditorState] = useState<{ item: BackpackItem | null } | null>(null);
    const [transferItem, setTransferItem] = useState<BackpackItem | null>(null);
    const [deliverItem, setDeliverItem] = useState<BackpackItem | null>(null);

    const refresh = useCallback(() => {
        setItems(loadBackpackItems());
        setTargets(loadBackpackTargets());
    }, []);

    useEffect(() => {
        const nextTargets = loadBackpackTargets();
        setTargets(nextTargets);
        setTargetId(currentCharacterId && nextTargets.some(t => t.id === currentCharacterId)
            ? currentCharacterId
            : "user");
        setItems(loadBackpackItems());
    }, [currentCharacterId, sessionId]);

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
    const targetName = currentTarget?.name ?? "我的背包";

    const visibleItems = useMemo(() => {
        const owned = filterBackpackItems(items, targetId);
        const keyword = query.trim().toLowerCase();
        if (!keyword) return owned;
        return owned.filter(it => [
            it.title,
            it.source,
            it.note,
            it.value,
            it.date,
            it.shopping?.merchantLabel,
            it.shopping?.detail,
        ].filter(Boolean).join(" ").toLowerCase().includes(keyword));
    }, [items, targetId, query]);

    useEffect(() => setSelected(new Set()), [targetId]);

    const toggleSelect = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const allSelected = visibleItems.length > 0 && selected.size === visibleItems.length;

    const handleRescan = () => {
        setMenuOpen(false);
        const added = rescanShoppingOrders();
        refresh();
        toast?.(added > 0 ? `扫描收录了 ${added} 件新物品` : "已同步全部背包物品");
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

    const emptyHint = query.trim()
        ? `没有找到与「${query.trim()}」相关的物品`
        : "背包空空如也，点击左上菜单「添加物品」或「重新扫描」";

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onClose}>
            <div className="backpack-modal-box" onClick={e => e.stopPropagation()}>
                {/* 顶栏：结构与插件一致 */}
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto 1fr",
                    alignItems: "center",
                    padding: "14px 18px",
                    borderBottom: "1px solid rgba(128,128,128,0.12)",
                }}>
                    <button
                        type="button"
                        title="菜单"
                        onClick={e => {
                            e.stopPropagation();
                            setMenuOpen(v => !v);
                        }}
                        style={{
                            justifySelf: "start",
                            border: "none",
                            background: "transparent",
                            color: "var(--c-text)",
                            padding: 4,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            opacity: 0.75,
                            borderRadius: 4,
                        }}
                    >
                        <IconMenu />
                    </button>

                    <button type="button" className="bp-title-btn" onClick={() => setPickerOpen(true)}>
                        <span className="bp-title-label">{targetName}</span>
                        <IconChevron />
                    </button>

                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            justifySelf: "end",
                            border: "none",
                            background: "transparent",
                            color: "var(--c-text)",
                            padding: 4,
                            cursor: "pointer",
                            display: "flex",
                            opacity: 0.75,
                        }}
                    >
                        <IconClose />
                    </button>
                </div>

                <div className={`backpack-dropdown-menu ${menuOpen ? "show" : ""}`}>
                    <button
                        type="button"
                        className="backpack-menu-action"
                        onClick={() => {
                            setMenuOpen(false);
                            setEditorState({ item: null });
                        }}
                    >
                        <IconPlus />
                        <span>添加物品</span>
                    </button>
                    <button type="button" className="backpack-menu-action" onClick={handleRescan}>
                        <IconRefresh />
                        <span>重新扫描</span>
                    </button>
                    <button
                        type="button"
                        className="backpack-menu-action"
                        onClick={() => {
                            setMenuOpen(false);
                            setManageMode(true);
                            setSelected(new Set());
                        }}
                    >
                        <IconManage />
                        <span>批量管理</span>
                    </button>
                </div>

                {/* 搜索框：取代原「正在查看」那一行 */}
                <div className="bp-search-bar">
                    <div className="bp-search-box">
                        <IconSearch />
                        <input
                            className="bp-search-input"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder={viewingUser ? "搜索我的物品" : "搜索他背包里的物品"}
                        />
                        {query && (
                            <button type="button" className="bp-search-clear" onClick={() => setQuery("")} aria-label="清空">
                                <IconClose />
                            </button>
                        )}
                    </div>
                </div>

                {/* 列表 */}
                <div className="backpack-scroll-content">
                    {visibleItems.length === 0 ? (
                        <div style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: "48px 0",
                            opacity: 0.6,
                            gap: 8,
                        }}>
                            <IconEmptyBox />
                            <div style={{
                                fontSize: TS(12),
                                color: "var(--c-text)",
                                textAlign: "center",
                                maxWidth: 280,
                            }}>
                                {emptyHint}
                            </div>
                        </div>
                    ) : (
                        visibleItems.map(item => {
                            const isSelected = selected.has(item.id);
                            const noteText = item.note && item.note.trim();

                            let badge: { cls: string; text: string; title: string } | null = null;
                            if (item.recipient === "character" && item.injected) {
                                badge = { cls: "backpack-icon-sparkle-badge", text: "✓", title: "已注入角色背包记忆" };
                            } else if (item.recipient === "user") {
                                const visCount = item.visibleTo.filter(Boolean).length;
                                if (visCount > 0) {
                                    badge = {
                                        cls: "backpack-icon-sparkle-badge bp-eye-badge",
                                        text: String(visCount),
                                        title: `${visCount}个角色可见`,
                                    };
                                }
                            }

                            let subText = noteText || item.source || "未标注";
                            if (item.recipient === "user" && !manageMode && item.visibleTo.length === 0 && !noteText) {
                                subText = "尚未让任何角色知道 · 点开可设置";
                            }

                            return (
                                <div
                                    key={item.id}
                                    className={`backpack-card-item ${isSelected ? "selected" : ""}`}
                                    onClick={() => {
                                        if (manageMode) toggleSelect(item.id);
                                        else setEditorState({ item });
                                    }}
                                >
                                    {manageMode && (
                                        <input
                                            type="checkbox"
                                            data-id={item.id}
                                            checked={isSelected}
                                            onChange={() => toggleSelect(item.id)}
                                            onClick={e => e.stopPropagation()}
                                            style={{
                                                width: 16,
                                                height: 16,
                                                cursor: "pointer",
                                                marginRight: 2,
                                                accentColor: "var(--bp-accent)",
                                            }}
                                        />
                                    )}
                                    <div className="backpack-icon-wrap">
                                        {item.customImage ? (
                                            /* eslint-disable-next-line @next/next/no-img-element */
                                            <img
                                                src={item.customImage}
                                                className="backpack-custom-thumb"
                                                alt=""
                                                referrerPolicy="no-referrer"
                                                loading="lazy"
                                            />
                                        ) : item.previewIcon ? (
                                            <span style={{ fontSize: TS(18) }} aria-hidden>{item.previewIcon}</span>
                                        ) : (
                                            <IconGift />
                                        )}
                                        {badge && (
                                            <div className={badge.cls} title={badge.title}>{badge.text}</div>
                                        )}
                                    </div>
                                    <div className="backpack-card-body">
                                        <div style={{
                                            fontSize: TS(14),
                                            fontWeight: 600,
                                            color: "var(--c-text)",
                                            wordBreak: "break-word",
                                            lineHeight: 1.3,
                                        }}>
                                            {item.title}
                                        </div>
                                        <div style={{
                                            fontSize: TS(11),
                                            color: "var(--c-icon)",
                                            marginTop: 2,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}>
                                            {subText}
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                {/* 批量管理条：结构与插件一致 */}
                <div className={`backpack-batch-bar ${manageMode ? "show" : ""}`}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <button
                                type="button"
                                onClick={() => {
                                    if (allSelected) setSelected(new Set());
                                    else setSelected(new Set(visibleItems.map(it => it.id)));
                                }}
                                style={{
                                    border: "none",
                                    background: "transparent",
                                    color: "var(--bp-accent)",
                                    fontSize: TS(12),
                                    padding: 0,
                                    cursor: "pointer",
                                    fontWeight: 500,
                                }}
                            >
                                {allSelected ? "取消全选" : "全选"}
                            </button>
                            <span style={{ fontSize: TS(11), opacity: 0.4 }}>|</span>
                            <span style={{ fontSize: TS(12), color: "var(--c-text)", opacity: 0.8 }}>
                                已选 {selected.size} 项
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={() => {
                                setManageMode(false);
                                setSelected(new Set());
                            }}
                            style={{
                                border: "none",
                                background: "transparent",
                                color: "var(--c-text)",
                                fontSize: TS(12),
                                padding: 0,
                                cursor: "pointer",
                                opacity: 0.75,
                            }}
                        >
                            退出管理
                        </button>
                    </div>

                    <div style={{
                        display: "grid",
                        gridTemplateColumns: viewingUser ? "1fr 1fr" : "1fr 1fr 1fr",
                        gap: 8,
                    }}>
                        {!viewingUser && (
                            <>
                                <button
                                    type="button"
                                    className="backpack-batch-btn"
                                    style={{ background: "var(--bp-accent-light)", color: "var(--bp-accent)" }}
                                    onClick={() => handleBatchInject(true)}
                                >
                                    <IconSparkles />
                                    <span>注入记忆</span>
                                </button>
                                <button
                                    type="button"
                                    className="backpack-batch-btn"
                                    style={{ background: "rgba(128,128,128,0.12)", color: "var(--c-text)" }}
                                    onClick={() => handleBatchInject(false)}
                                >
                                    <IconBan />
                                    <span>取消注入</span>
                                </button>
                            </>
                        )}
                        {viewingUser && (
                            <button
                                type="button"
                                className="backpack-batch-btn"
                                style={{ background: "rgba(59,130,246,0.12)", color: "#3b82f6" }}
                                onClick={() => toast?.("可见范围请在物品详情里逐件调整")}
                            >
                                <IconEye />
                                <span>可见角色</span>
                            </button>
                        )}
                        <button
                            type="button"
                            className="backpack-batch-btn"
                            style={{ background: "rgba(239,68,68,0.12)", color: "#ef4444" }}
                            onClick={handleBatchDelete}
                        >
                            <IconTrash />
                            <span>删除</span>
                        </button>
                    </div>
                </div>

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
                            // 先收起详情弹窗再开目标列表：详情是 fixed 全屏遮罩，
                            // 两层叠着即使列表在上层，操作完详情也已经过期了。
                            setEditorState(null);
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
                            if (!target) {
                                setDeliverItem(null);
                                return;
                            }
                            const ok = onDeliver?.({
                                item: deliverItem,
                                targetCharacterId: target.id,
                                targetName: target.rawName,
                            });
                            if (ok) setDeliverItem(null);
                            refresh();
                        }}
                        toast={toast}
                    />
                )}

                {pickerOpen && (
                    <div className="bp-sub-overlay" onClick={() => setPickerOpen(false)}>
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
                                        className="bp-target-edit-item"
                                        onClick={() => {
                                            setTargetId(t.id);
                                            setPickerOpen(false);
                                        }}
                                    >
                                        <span className="bp-pick-name">{t.name}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="bp-sub-foot">
                                <button
                                    type="button"
                                    onClick={() => setPickerOpen(false)}
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
                                    关闭
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
