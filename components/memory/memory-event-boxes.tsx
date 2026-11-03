"use client";

// 事件盒的界面零件。刻意只用仓库里已有的视觉语言：
//   - 列表 = page-menu / menu-group / menu-item（和「记忆设置」页同构）
//   - 左侧图标 = card-icon + BINDING_ACCENTS.memory（和设置页图标同构）
//   - 摘要与空态 = g-card / mem-empty-card
//   - 确认 = 全局 ConfirmDialog
// 不再另造一套卡片样式，否则一眼就能看出是后来贴上去的。

import { useState, type CSSProperties } from "react";
import {
    AlertCircle,
    Archive,
    ChevronRight,
    History,
    Plus,
    RotateCcw,
    Sparkles,
    Wand2,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/modal";
import type { MemoryEntry } from "@/lib/memory-types";
import {
    EVENT_BOX_STATUS_META,
    formatBoxSpan,
    getBoxEntries,
    getEntryBoxId,
    isEntryArchived,
    type MemoryEventBox,
} from "@/lib/memory-event-boxes";
import { eventBoxNeedsRedigest } from "@/lib/memory-event-box-digest";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";
import type { AutoClusterCandidate } from "@/lib/memory-event-box-auto";

const boxIconStyle = { "--icon-color": BINDING_ACCENTS.memory } as CSSProperties;

/**
 * 事件盒图标：用和记忆详情底部「长期」tab 一致的 Archive（盒子），
 * 而不是文件夹——这页装的是事件档案，不是文件目录。
 * muted 用来区分归档态：归档后图标转灰，一眼能看出这盒已经封存。
 */
function BoxIcon({ muted }: { muted?: boolean }) {
    return (
        <span
            className="card-icon"
            style={muted ? { ...boxIconStyle, "--icon-color": "var(--c-icon)" } as CSSProperties : boxIconStyle}
        >
            <Archive size={22} strokeWidth={1.75} />
        </span>
    );
}

/**
 * 事件盒列表：和记忆设置页一模一样的 page-menu 结构。
 * 每行：图标 + 标题 + 副标题（条数 / 日期 / 状态） + 右侧箭头。
 */
export function EventBoxList({
    boxes,
    entries,
    busy,
    onOpen,
    onCreate,
    onAutoCluster,
    ungroupedCount,
}: {
    boxes: MemoryEventBox[];
    entries: MemoryEntry[];
    busy: boolean;
    onOpen: (boxId: string) => void;
    onCreate: () => void;
    onAutoCluster: () => void;
    ungroupedCount: number;
}) {
    // 列表行里的归档态用灰图标，和「长期」tab 的 Archive 同一个盒子形状

    return (
        <div className="page-menu">
            <p className="menu-group-desc mx-2">自动整理</p>
            <div className="menu-group">
                <div className="menu-item">
                    <BoxIcon />
                    <div className="menu-label-group">
                        <span className="menu-label">自动归纳</span>
                        <span className="menu-desc">
                            {ungroupedCount > 0
                                ? `把 ${ungroupedCount} 条未分组记忆按「同一件事」聚到一起，先给你看方案`
                                : "没有待分组的记忆"}
                        </span>
                    </div>
                    <div className="menu-right">
                        <button
                            className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                            onClick={onAutoCluster}
                            disabled={busy || ungroupedCount < 2}
                        >
                            <Wand2 size={12} className="mr-1" />
                            {busy ? "分析中..." : "开始"}
                        </button>
                    </div>
                </div>
                <div className="menu-item">
                    <BoxIcon />
                    <div className="menu-label-group">
                        <span className="menu-label">新建事件盒</span>
                        <span className="menu-desc">手动建一个空盒子，之后把记忆放进去</span>
                    </div>
                    <div className="menu-right">
                        <button
                            className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                            onClick={onCreate}
                        >
                            <Plus size={12} className="mr-1" />
                            新建
                        </button>
                    </div>
                </div>
            </div>

            <p className="menu-group-desc mx-2">事件盒（{boxes.length}）</p>
            <div className="menu-group">
                {boxes.length === 0 ? (
                    <div className="menu-item">
                        <div className="menu-label-group">
                            <span className="menu-label">还没有事件盒</span>
                            <span className="menu-desc">点上面的「自动归纳」，或手动新建一个</span>
                        </div>
                    </div>
                ) : boxes.map(box => {
                    const boxEntries = getBoxEntries(entries, box.id);
                    const needsRedigest = eventBoxNeedsRedigest(box, entries);
                    const meta = [
                        `${boxEntries.length} 条`,
                        boxEntries.length > 0 ? formatBoxSpan(boxEntries) : "",
                        EVENT_BOX_STATUS_META[box.status].label,
                        box.archived ? "已归档" : "",
                        needsRedigest ? "有新记忆" : "",
                    ].filter(Boolean).join(" · ");
                    return (
                        <button key={box.id} className="menu-item" onClick={() => onOpen(box.id)}>
                            <BoxIcon muted={box.archived} />
                            <div className="menu-label-group">
                                <span className="menu-label">{box.title}</span>
                                <span className="menu-desc">{meta}</span>
                            </div>
                            <div className="menu-right">
                                <ChevronRight size={16} />
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/** 盒内页的操作区：摘要 + 总结 / 恢复。放在条目列表上方，用 menu-group 承载按钮。 */
export function EventBoxPanel({
    box,
    entries,
    busy,
    onDigest,
    onRestore,
    onRename,
    onDelete,
}: {
    box: MemoryEventBox;
    entries: MemoryEntry[];
    busy: boolean;
    onDigest: () => void;
    onRestore: () => void;
    onRename: () => void;
    onDelete: () => void;
}) {
    const [historyOpen, setHistoryOpen] = useState(false);
    const boxEntries = getBoxEntries(entries, box.id);
    const archivedCount = boxEntries.filter(isEntryArchived).length;
    const pendingCount = boxEntries.length - archivedCount;
    const needsRedigest = eventBoxNeedsRedigest(box, entries);
    const versions = box.digest?.versions ?? [];

    return (
        <>
            {box.archived && box.digest?.current ? (
                <div className="g-card mem-box-digest">
                    <div className="mem-box-digest-head">
                        <span>事件摘要</span>
                        {versions.length > 1 ? (
                            <button className="mem-superseded-jump" onClick={() => setHistoryOpen(prev => !prev)}>
                                <History size={12} style={{ marginRight: 3, verticalAlign: -2 }} />
                                {historyOpen ? "收起" : `历史 ${versions.length} 版`}
                            </button>
                        ) : null}
                    </div>
                    <p className="mem-box-digest-text">{box.digest.current}</p>
                    {historyOpen ? (
                        <div className="mem-box-digest-history">
                            {versions.slice(0, -1).reverse().map(item => (
                                <div key={item.version} className="mem-box-digest-version">
                                    <span className="mem-box-digest-version-tag">
                                        第 {item.version} 版 · {item.generatedAt.slice(0, 10)} · {item.sourceIds.length} 条
                                    </span>
                                    <p>{item.text}</p>
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}

            <div className="menu-group">
                <div className="menu-item">
                    <BoxIcon />
                    <div className="menu-label-group">
                        <span className="menu-label">{box.archived ? "重新总结" : "总结并归档"}</span>
                        <span className="menu-desc">
                            {box.archived
                                ? (pendingCount > 0 ? `有 ${pendingCount} 条新记忆待并入摘要` : "摘要已是最新")
                                : "压成一条摘要代表这组记忆，原文保留可恢复"}
                        </span>
                    </div>
                    <div className="menu-right">
                        <button
                            className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                            onClick={onDigest}
                            disabled={busy || boxEntries.length === 0}
                        >
                            <Sparkles size={12} className="mr-1" />
                            {busy ? "处理中..." : "总结"}
                        </button>
                    </div>
                </div>
                {box.archived ? (
                    <div className="menu-item">
                        <BoxIcon />
                        <div className="menu-label-group">
                            <span className="menu-label">恢复原始记忆</span>
                            <span className="menu-desc">删掉摘要，{archivedCount} 条原文恢复独立参与召回</span>
                        </div>
                        <div className="menu-right">
                            <button
                                className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                onClick={onRestore}
                                disabled={busy}
                            >
                                <RotateCcw size={12} className="mr-1" />
                                恢复
                            </button>
                        </div>
                    </div>
                ) : null}
                <button className="menu-item" onClick={onRename}>
                    <BoxIcon />
                    <div className="menu-label-group">
                        <span className="menu-label">重命名与状态</span>
                        <span className="menu-desc">当前：{EVENT_BOX_STATUS_META[box.status].label}{box.note ? ` · ${box.note}` : ""}</span>
                    </div>
                    <div className="menu-right">
                        <ChevronRight size={16} />
                    </div>
                </button>
                <button className="menu-item" onClick={onDelete}>
                    <BoxIcon />
                    <div className="menu-label-group">
                        <span className="menu-label menu-label-danger">删除这个盒子</span>
                        <span className="menu-desc">盒内 {boxEntries.length} 条记忆全部保留为独立记忆</span>
                    </div>
                    <div className="menu-right">
                        <ChevronRight size={16} />
                    </div>
                </button>
            </div>

            {needsRedigest ? (
                <p className="mem-box-hint">
                    归档后又进来了 {pendingCount} 条新记忆，它们目前仍会单独参与召回。点「总结」把新内容并进摘要。
                </p>
            ) : null}
        </>
    );
}

/** 条目 ⋯ 菜单里的「移入事件盒」弹层：沿用 modal-sheet + menu-item 结构 */
export function EventBoxPicker({
    boxes,
    entry,
    onPick,
    onPickNew,
    onRemove,
    onClose,
}: {
    boxes: MemoryEventBox[];
    entry: MemoryEntry;
    onPick: (boxId: string) => void;
    onPickNew: () => void;
    onRemove: () => void;
    onClose: () => void;
}) {
    const currentBoxId = getEntryBoxId(entry);
    return (
        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={onClose}>
            <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <span style={{ width: 28 }} />
                    <h3 className="modal-title">移入事件盒</h3>
                    <button className="modal-header-btn modal-header-btn-muted" onClick={onClose}>
                        <span style={{ fontSize: 18, lineHeight: 1 }}>×</span>
                    </button>
                </div>
                <div className="modal-body" data-ui="modal-body" style={{ paddingBottom: 20 }}>
                    <div className="menu-group" style={{ marginTop: 8 }}>
                        {boxes.map(box => (
                            <button key={box.id} className="menu-item" onClick={() => onPick(box.id)}>
                                <BoxIcon muted={box.id !== currentBoxId} />
                                <div className="menu-label-group">
                                    <span className="menu-label">{box.title}</span>
                                    <span className="menu-desc">{EVENT_BOX_STATUS_META[box.status].label}</span>
                                </div>
                                <div className="menu-right">
                                    {box.id === currentBoxId ? <span className="menu-desc">当前</span> : <ChevronRight size={16} />}
                                </div>
                            </button>
                        ))}
                        <div className="menu-item">
                            <BoxIcon />
                            <div className="menu-label-group">
                                <span className="menu-label">新建事件盒</span>
                                <span className="menu-desc">建好后这条记忆直接放进去</span>
                            </div>
                            <div className="menu-right">
                                <button
                                    className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                    onClick={onPickNew}
                                >
                                    <Plus size={12} className="mr-1" />
                                    新建
                                </button>
                            </div>
                        </div>
                        {currentBoxId ? (
                            <button className="menu-item" onClick={onRemove}>
                                <BoxIcon />
                                <div className="menu-label-group">
                                    <span className="menu-label menu-label-danger">移出事件盒</span>
                                    <span className="menu-desc">恢复为独立记忆，重新单独参与召回</span>
                                </div>
                                <div className="menu-right">
                                    <ChevronRight size={16} />
                                </div>
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}

/** 新建 / 重命名：沿用记忆编辑弹层的字段行样式 */
export function EventBoxNameDialog({
    title,
    initialTitle,
    initialStatus,
    initialNote,
    confirmLabel,
    onConfirm,
    onCancel,
}: {
    title: string;
    initialTitle?: string;
    initialStatus?: MemoryEventBox["status"];
    initialNote?: string;
    confirmLabel: string;
    onConfirm: (value: { title: string; status: MemoryEventBox["status"]; note: string }) => void;
    onCancel: () => void;
}) {
    const [name, setName] = useState(initialTitle ?? "");
    const [status, setStatus] = useState<MemoryEventBox["status"]>(initialStatus ?? "active");
    const [note, setNote] = useState(initialNote ?? "");
    const canSave = name.trim().length > 0;

    return (
        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={onCancel}>
            <div className="modal-sheet mem-edit-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <button className="modal-header-btn modal-header-btn-muted" onClick={onCancel}>×</button>
                    <h3 className="modal-title">{title}</h3>
                    <button
                        className="modal-header-btn modal-header-btn-action"
                        disabled={!canSave}
                        onClick={() => canSave && onConfirm({ title: name.trim(), status, note: note.trim() })}
                    >
                        <span style={{ fontSize: 18, lineHeight: 1 }}>✓</span>
                    </button>
                </div>
                <div className="modal-body mem-edit-body" data-ui="modal-body">
                    <div className="mem-edit-field-row">
                        <label className="mem-edit-field-label">盒子名称</label>
                        <input
                            className="ui-input ts-12"
                            value={name}
                            autoFocus
                            placeholder="例如：学法语的那段日子"
                            onChange={event => setName(event.target.value)}
                        />
                    </div>
                    <div className="mem-edit-field-row">
                        <label className="mem-edit-field-label">状态</label>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {(Object.keys(EVENT_BOX_STATUS_META) as MemoryEventBox["status"][]).map(key => (
                                <button
                                    key={key}
                                    type="button"
                                    className="ui-chip"
                                    style={{ fontSize: 11, padding: "4px 10px" }}
                                    data-selected={status === key ? "" : undefined}
                                    onClick={() => setStatus(key)}
                                >
                                    {EVENT_BOX_STATUS_META[key].label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="mem-edit-field-row">
                        <label className="mem-edit-field-label">备注（可选）</label>
                        <input
                            className="ui-input ts-12"
                            value={note}
                            placeholder="一句话说明这件事"
                            onChange={event => setNote(event.target.value)}
                        />
                    </div>
                    <button
                        className="ui-btn ui-btn-primary mem-edit-save-btn"
                        disabled={!canSave}
                        onClick={() => canSave && onConfirm({ title: name.trim(), status, note: note.trim() })}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * 自动归纳的方案预览：算出候选后先给用户过一眼，误判成本远高于这一眼。
 * 支持逐组取消，剩下的点「全部整理」一次性建盒 + 归档。
 */
export function AutoClusterPreview({
    candidates,
    selected,
    busy,
    busyLabel,
    onToggle,
    onConfirm,
    onCancel,
}: {
    candidates: AutoClusterCandidate[];
    selected: Record<string, boolean>;
    busy: boolean;
    busyLabel?: string;
    onToggle: (key: string) => void;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const chosenCount = candidates.filter(item => selected[item.key] !== false).length;
    return (
        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={busy ? undefined : onCancel}>
            <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <span style={{ width: 28 }} />
                    <h3 className="modal-title">归纳方案（{candidates.length} 组）</h3>
                    <button className="modal-header-btn modal-header-btn-muted" onClick={onCancel} disabled={busy}>×</button>
                </div>
                <div className="modal-body" data-ui="modal-body" style={{ maxHeight: "62vh", overflowY: "auto", paddingBottom: 16 }}>
                    <p className="menu-group-desc mx-2" style={{ marginBottom: 8 }}>
                        取消勾选不需要的组。确认后会建盒、生成摘要并归档，原始记忆始终保留。
                    </p>
                    <div className="menu-group">
                        {candidates.map(candidate => {
                            const checked = selected[candidate.key] !== false;
                            return (
                                <button
                                    key={candidate.key}
                                    className="menu-item"
                                    onClick={() => onToggle(candidate.key)}
                                    disabled={busy}
                                >
                                    <span className="card-icon" style={{ "--icon-color": checked ? BINDING_ACCENTS.memory : "var(--c-icon)" } as CSSProperties}>
                                        <Archive size={22} strokeWidth={1.75} />
                                    </span>
                                    <div className="menu-label-group">
                                        <span className="menu-label" style={{ opacity: checked ? 1 : 0.5 }}>{candidate.title}</span>
                                        <span className="menu-desc">
                                            {candidate.entries.length} 条 · {candidate.earliest} ~ {candidate.latest} · {Math.round(candidate.cohesion * 100)}% 相关
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    <button
                        className="ui-btn ui-btn-primary mem-edit-save-btn"
                        disabled={busy || chosenCount === 0}
                        onClick={onConfirm}
                    >
                        {busy ? (busyLabel || "处理中...") : `整理 ${chosenCount} 组`}
                    </button>
                </div>
            </div>
        </div>
    );
}

/** 删除 / 恢复确认：直接用全局 ConfirmDialog，和记忆库其它危险操作一致 */
export function EventBoxConfirmDialog({
    kind,
    entryCount,
    archivedCount,
    onConfirm,
    onCancel,
}: {
    kind: "delete" | "restore";
    entryCount: number;
    archivedCount: number;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return kind === "delete" ? (
        <ConfirmDialog
            title="删除这个事件盒？"
            message={`盒内 ${entryCount} 条记忆不会被删除，会恢复成独立记忆继续参与召回。${archivedCount > 0 ? "归档状态也会一并解除。" : ""}`}
            icon={AlertCircle}
            variant="danger"
            confirmLabel="删除盒子"
            onConfirm={onConfirm}
            onCancel={onCancel}
        />
    ) : (
        <ConfirmDialog
            title="恢复原始记忆？"
            message={`会删掉这次生成的摘要，把 ${archivedCount} 条原始记忆恢复为独立召回。盒子本身保留。`}
            icon={AlertCircle}
            confirmLabel="恢复"
            onConfirm={onConfirm}
            onCancel={onCancel}
        />
    );
}
