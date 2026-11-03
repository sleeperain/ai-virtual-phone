"use client";

// 事件盒的界面零件：盒子网格、盒内页头、条目归盒弹层、盒子命名弹窗。
// 条目卡片的渲染留在 memory-bank-page 里复用同一套（盒内列表 = 加了筛选条件的条目列表），
// 避免再写一份长得不一样的卡片。

import { useState } from "react";
import {
    Folder,
    FolderPlus,
    ArrowLeft,
    MoreHorizontal,
    Trash2,
    Edit3,
    Sparkles,
    RotateCcw,
    AlertCircle,
    X,
    Check,
    History,
} from "lucide-react";
import type { MemoryEntry } from "@/lib/memory-types";
import {
    EVENT_BOX_STATUS_META,
    formatBoxSpan,
    getBoxEntries,
    getEntryBoxId,
    isEntryArchived,
    isEntryBoxDigest,
    type MemoryEventBox,
} from "@/lib/memory-event-boxes";
import { eventBoxNeedsRedigest } from "@/lib/memory-event-box-digest";

/** 盒子卡片的 ⋯ 菜单：重命名 / 删除 */
function BoxCardMenu({
    onRename,
    onDelete,
}: {
    onRename: () => void;
    onDelete: () => void;
}) {
    const [open, setOpen] = useState(false);
    return (
        <div className="mem-entry-menu-wrap">
            <button
                className="mem-entry-menu-btn"
                title="更多"
                onClick={event => {
                    event.stopPropagation();
                    setOpen(prev => !prev);
                }}
            >
                <MoreHorizontal size={16} />
            </button>
            {open && (
                <>
                    <button
                        className="mem-entry-menu-backdrop"
                        aria-label="关闭菜单"
                        onClick={event => {
                            event.stopPropagation();
                            setOpen(false);
                        }}
                    />
                    <div className="mem-entry-menu" onClick={event => event.stopPropagation()}>
                        <button onClick={() => { setOpen(false); onRename(); }}>
                            <Edit3 size={13} />
                            <span>重命名</span>
                        </button>
                        <button className="is-danger" onClick={() => { setOpen(false); onDelete(); }}>
                            <Trash2 size={13} />
                            <span>删除盒子</span>
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

export function EventBoxGrid({
    boxes,
    entries,
    onOpen,
    onCreate,
    onRename,
    onDelete,
}: {
    boxes: MemoryEventBox[];
    entries: MemoryEntry[];
    onOpen: (boxId: string) => void;
    onCreate: () => void;
    onRename: (box: MemoryEventBox) => void;
    onDelete: (box: MemoryEventBox) => void;
}) {
    return (
        <div className="mem-box-view">
            <div className="mem-entry-toolbar" style={{ flexWrap: "wrap" }}>
                <button className="mem-entry-add-btn" onClick={onCreate}>
                    <FolderPlus size={15} strokeWidth={1.8} />
                    <span>新建事件盒</span>
                </button>
                <span className="mem-box-toolbar-hint">
                    {boxes.length} 个盒子 · 共 {entries.filter(entry => !isEntryArchived(entry) && !isEntryBoxDigest(entry)).length} 条记忆
                </span>
            </div>

            {boxes.length === 0 ? (
                <div className="mem-empty-card">
                    <p>还没有事件盒。围绕同一件事的记忆可以归到一个盒子里，翻起来不用一路下滑。</p>
                    <button className="mem-empty-add-btn" onClick={onCreate}>
                        <FolderPlus size={14} />
                        <span>新建事件盒</span>
                    </button>
                </div>
            ) : (
                <div className="mem-box-grid">
                    {boxes.map(box => {
                        const boxEntries = getBoxEntries(entries, box.id);
                        const needsRedigest = eventBoxNeedsRedigest(box, entries);
                        return (
                            <div
                                key={box.id}
                                className="g-card mem-box-card"
                                onClick={() => onOpen(box.id)}
                            >
                                <div className="mem-box-card-head">
                                    <span className="mem-box-icon" aria-hidden>
                                        <Folder size={20} strokeWidth={1.75} />
                                    </span>
                                    <BoxCardMenu
                                        onRename={() => onRename(box)}
                                        onDelete={() => onDelete(box)}
                                    />
                                </div>
                                <span className="mem-box-title">{box.title}</span>
                                <span className="mem-box-meta">
                                    {boxEntries.length} 条
                                    {boxEntries.length > 0 ? ` · ${formatBoxSpan(boxEntries)}` : ""}
                                </span>
                                <div className="mem-box-flags">
                                    <span className="mem-box-status" data-status={box.status}>
                                        {EVENT_BOX_STATUS_META[box.status].label}
                                    </span>
                                    {box.archived ? (
                                        <span className="mem-box-flag">已归档</span>
                                    ) : null}
                                    {needsRedigest ? (
                                        <span className="mem-box-flag is-warn">有新记忆</span>
                                    ) : null}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export function EventBoxDetailHeader({
    box,
    entries,
    busy,
    onBack,
    onDigest,
    onRestore,
    onRename,
    onDelete,
}: {
    box: MemoryEventBox;
    entries: MemoryEntry[];
    busy: boolean;
    onBack: () => void;
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
        <div className="mem-box-detail-head">
            <div className="mem-box-detail-title-row">
                <button className="mem-box-back" onClick={onBack} title="返回事件盒">
                    <ArrowLeft size={16} />
                </button>
                <span className="mem-box-detail-title">{box.title}</span>
                <span className="mem-box-status" data-status={box.status}>
                    {EVENT_BOX_STATUS_META[box.status].label}
                </span>
                <div className="mem-entry-menu-wrap" style={{ marginLeft: "auto" }}>
                    <button className="mem-entry-menu-btn" onClick={onRename} title="重命名">
                        <Edit3 size={15} />
                    </button>
                    <button className="mem-entry-menu-btn" onClick={onDelete} title="删除盒子（记忆会保留）">
                        <Trash2 size={15} />
                    </button>
                </div>
            </div>

            <p className="mem-box-detail-meta">
                {boxEntries.length} 条
                {boxEntries.length > 0 ? ` · ${formatBoxSpan(boxEntries)}` : ""}
                {box.archived ? ` · 已归档 ${archivedCount} 条` : ""}
                {box.archived && pendingCount > 0 ? ` · ${pendingCount} 条待总结` : ""}
            </p>

            {box.archived && box.digest?.current ? (
                <div className="g-card mem-box-digest">
                    <div className="mem-box-digest-head">
                        <span>事件摘要</span>
                        {versions.length > 1 ? (
                            <button className="mem-superseded-jump" onClick={() => setHistoryOpen(prev => !prev)}>
                                <History size={12} style={{ marginRight: 3, verticalAlign: -2 }} />
                                历史 {versions.length} 版
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

            <div className="mem-box-actions">
                <button
                    className="ui-chip"
                    style={{ fontSize: 11, padding: "4px 10px" }}
                    disabled={busy || boxEntries.length === 0}
                    onClick={onDigest}
                >
                    <Sparkles size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                    {busy ? "处理中..." : box.archived ? "重新总结并归档" : "总结并归档"}
                </button>
                {box.archived ? (
                    <button
                        className="ui-chip"
                        style={{ fontSize: 11, padding: "4px 10px" }}
                        disabled={busy}
                        onClick={onRestore}
                    >
                        <RotateCcw size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                        恢复原始记忆
                    </button>
                ) : null}
            </div>

            {needsRedigest ? (
                <p className="mem-box-hint">
                    归档后又进来了 {pendingCount} 条新记忆，它们现在仍会单独参与召回。点「重新总结并归档」把它们并进摘要。
                </p>
            ) : null}
            {!box.archived && boxEntries.length > 0 ? (
                <p className="mem-box-hint">
                    归档后这组记忆由一条摘要代表参与召回，原始条目不会再单独发给模型，随时可以用「恢复原始记忆」撤回。
                </p>
            ) : null}
        </div>
    );
}

/** 条目 ⋯ 菜单里的「移入事件盒」弹层 */
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
            <div className="modal-sheet mem-box-picker" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <span style={{ width: 28 }} />
                    <h3 className="modal-title">移入事件盒</h3>
                    <button className="modal-header-btn modal-header-btn-muted" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>
                <div className="modal-body" data-ui="modal-body">
                    <p className="mem-box-picker-hint">把围绕同一件事的记忆放进同一个盒子，列表就不会散落各处。</p>
                    <div className="mem-box-picker-list">
                        {boxes.map(box => {
                            const active = box.id === currentBoxId;
                            return (
                                <button
                                    key={box.id}
                                    className="mem-box-picker-item"
                                    data-active={active ? "" : undefined}
                                    onClick={() => onPick(box.id)}
                                >
                                    <Folder size={16} strokeWidth={1.75} />
                                    <span className="mem-box-picker-name">{box.title}</span>
                                    <span className="mem-box-picker-status">{EVENT_BOX_STATUS_META[box.status].label}</span>
                                    {active ? <Check size={15} /> : null}
                                </button>
                            );
                        })}
                        <button className="mem-box-picker-item is-new" onClick={onPickNew}>
                            <FolderPlus size={16} strokeWidth={1.75} />
                            <span className="mem-box-picker-name">新建事件盒并放入</span>
                        </button>
                    </div>
                    {currentBoxId ? (
                        <button className="mem-box-picker-remove" onClick={onRemove}>
                            从这个事件盒移出（恢复为独立记忆）
                        </button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

/** 新建 / 重命名盒子。status 一起改，省得再开一个弹窗。 */
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
            <div className="modal-sheet mem-box-name-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <button className="modal-header-btn modal-header-btn-muted" onClick={onCancel}>
                        <X size={18} />
                    </button>
                    <h3 className="modal-title">{title}</h3>
                    <button
                        className="modal-header-btn modal-header-btn-action"
                        disabled={!canSave}
                        onClick={() => canSave && onConfirm({ title: name.trim(), status, note: note.trim() })}
                    >
                        <Check size={18} />
                    </button>
                </div>
                <div className="modal-body" data-ui="modal-body">
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
                        <div className="mem-box-status-options">
                            {(Object.keys(EVENT_BOX_STATUS_META) as MemoryEventBox["status"][]).map(key => (
                                <button
                                    key={key}
                                    className="ui-chip"
                                    style={{ fontSize: 11, padding: "4px 10px" }}
                                    data-selected={status === key ? "" : undefined}
                                    onClick={() => setStatus(key)}
                                    title={EVENT_BOX_STATUS_META[key].hint}
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
                    <p className="mem-box-picker-hint" style={{ marginTop: 8 }}>
                        {confirmLabel === "创建" ? "盒子建好后，在记忆条目的 ⋯ 菜单里选「移入事件盒」就能放进去。" : ""}
                    </p>
                </div>
            </div>
        </div>
    );
}

/** 删除盒子 / 恢复归档的确认提示（复用 ConfirmDialog 的外观太重，这里用轻量弹层） */
export function EventBoxConfirm({
    title,
    message,
    confirmLabel,
    danger,
    onConfirm,
    onCancel,
}: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={onCancel}>
            <div className="modal-sheet mem-box-name-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <span style={{ width: 28 }} />
                    <h3 className="modal-title">{title}</h3>
                    <button className="modal-header-btn modal-header-btn-muted" onClick={onCancel}>
                        <X size={18} />
                    </button>
                </div>
                <div className="modal-body" data-ui="modal-body">
                    <p className="mem-box-confirm-text">
                        <AlertCircle size={14} className={danger ? "mem-box-confirm-icon is-danger" : "mem-box-confirm-icon"} />
                        <span>{message}</span>
                    </p>
                    <div className="mem-box-confirm-actions">
                        <button className="ui-btn ui-btn-outline" onClick={onCancel}>取消</button>
                        <button
                            className={danger ? "ui-btn ui-btn-danger" : "ui-btn ui-btn-primary"}
                            onClick={onConfirm}
                        >
                            {confirmLabel}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
