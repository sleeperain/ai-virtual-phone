"use client";

// components/chat/backpack-item-editor.tsx
// 原生背包 · 物品详情 / 新建
//
// 结构与 inline style 照搬「背包」插件 3.25.0 的 openItemEditModal：
//   图标行 → 图片控制 → 来源/价值 grid → 时间 → 备注 → 底部按钮
// class 沿用插件：bp-input-field / bp-readonly-value / bp-readonly-hint
// 唯一改动：字号走 calc(px * --app-text-scale)，购物来源字段锁定只读。

import { useEffect, useMemo, useRef, useState } from "react";
import {
    createManualBackpackItem,
    formatBackpackTime,
    loadBackpackTargets,
    parseBackpackTime,
    updateBackpackItem,
} from "@/lib/backpack-storage";
import type { BackpackItem } from "@/lib/backpack-types";

type BackpackItemEditorProps = {
    item: BackpackItem | null;
    isNew: boolean;
    targetId: string;
    targetName: string;
    isUserTarget: boolean;
    onClose: () => void;
    onSaved: () => void;
    onTransfer: (item: BackpackItem) => void;
    toast?: (text: string) => void;
};

const MAX_IMAGE_LEN = 250 * 1024;
const ALLOWED_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp|avif|apng);/i;

const TS = (px: number) => `calc(${px}px * var(--app-text-scale, 1))`;

/** 图标：尺寸照搬插件 ICONS */
const IconClose = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);
const IconCamera = () => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
        <circle cx="12" cy="13" r="3" />
    </svg>
);
const IconUpload = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
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

function isValidImageUrl(url: string): boolean {
    if (!url) return false;
    const trimmed = url.trim();
    if (trimmed.length > MAX_IMAGE_LEN) return false;
    if (/^data:image\/svg/i.test(trimmed)) return false;
    if (/^data:image\//i.test(trimmed)) return ALLOWED_DATA_IMAGE.test(trimmed);
    try {
        const u = new URL(trimmed, typeof location !== "undefined" ? location.href : undefined);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

/** 压缩到 200×200，与插件同一套参数 */
function compressImageFile(file: File, maxWidth = 200, maxHeight = 200): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => {
            const img = new Image();
            img.onload = () => {
                let w = img.width;
                let h = img.height;
                if (w > maxWidth || h > maxHeight) {
                    if (w / h > maxWidth / maxHeight) {
                        h = Math.round((h * maxWidth) / w);
                        w = maxWidth;
                    } else {
                        w = Math.round((w * maxHeight) / h);
                        h = maxHeight;
                    }
                }
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    reject(new Error("canvas unavailable"));
                    return;
                }
                const isPng = file.type === "image/png";
                if (!isPng) {
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, w, h);
                }
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL(isPng ? "image/png" : "image/jpeg", isPng ? undefined : 0.85));
            };
            img.onerror = () => reject(new Error("image decode failed"));
            img.src = String(e.target?.result ?? "");
        };
        reader.onerror = () => reject(new Error("file read failed"));
        reader.readAsDataURL(file);
    });
}

export function BackpackItemEditor({
    item,
    isNew,
    targetId,
    targetName,
    isUserTarget,
    onClose,
    onSaved,
    onTransfer,
    toast,
}: BackpackItemEditorProps) {
    const shoppingLock = item?.shopping ?? null;
    const canEditTitle = isNew || !item || item.isManual || item.isRoleAdded;
    const canEditDate = !shoppingLock && (isNew || !item || item.isManual || item.isRoleAdded);

    const [title, setTitle] = useState(item?.title ?? "");
    const [source, setSource] = useState(
        shoppingLock ? shoppingLock.merchantLabel : (item?.source === "未标注" ? "" : item?.source ?? ""),
    );
    const [value, setValue] = useState(item?.value === "--" ? "" : item?.value ?? "");
    const [date, setDate] = useState(
        item?.date && item.date !== "近期" ? item.date : formatBackpackTime(Date.now()),
    );
    const [note, setNote] = useState(item?.note ?? "");
    const [customImage, setCustomImage] = useState(item?.customImage ?? "");
    const [imgBoxOpen, setImgBoxOpen] = useState(false);
    const [urlDraft, setUrlDraft] = useState(item?.customImage?.startsWith("data:") ? "" : item?.customImage ?? "");
    const [saving, setSaving] = useState(false);
    const [visibleTo, setVisibleTo] = useState<string[]>(
        Array.isArray(item?.visibleTo) ? item.visibleTo.filter(Boolean) : [],
    );
    const [visibleOpen, setVisibleOpen] = useState(false);
    const [visibleDraft, setVisibleDraft] = useState<Set<string>>(new Set());
    const fileRef = useRef<HTMLInputElement>(null);

    const characterTargets = useMemo(() => loadBackpackTargets().filter(t => !t.isUser), []);

    useEffect(() => {
        if (!visibleOpen) return;
        setVisibleDraft(new Set(Array.isArray(item?.visibleTo) ? item.visibleTo.filter(Boolean) : []));
    }, [visibleOpen, item?.visibleTo]);

    const handlePickFile = async (file: File) => {
        try {
            toast?.("正在处理图片...");
            const compressed = await compressImageFile(file);
            if (compressed.length > MAX_IMAGE_LEN) {
                toast?.("图片过大，请换一张");
                return;
            }
            setCustomImage(compressed);
            toast?.("预览已更新，点击保存即可生效");
        } catch {
            toast?.("图片读取失败");
        }
    };

    const handleSave = () => {
        if (saving) return;
        const finalTitle = (canEditTitle ? title : item?.title ?? "").trim();
        if (!finalTitle) {
            toast?.("请输入物品名称");
            return;
        }
        let finalImage = customImage;
        if (finalImage && !isValidImageUrl(finalImage)) finalImage = "";

        setSaving(true);
        try {
            if (isNew) {
                createManualBackpackItem({
                    title: finalTitle,
                    source: shoppingLock ? shoppingLock.merchantLabel : (source || "心意手作"),
                    value,
                    date: canEditDate ? date : undefined,
                    note,
                    customImage: finalImage,
                    recipient: isUserTarget ? "user" : "character",
                    characterId: isUserTarget ? "" : targetId,
                });
                toast?.("已添加物品到背包");
            } else if (item) {
                const patch: Partial<BackpackItem> = {
                    value: value || "--",
                    note,
                    customImage: finalImage,
                    userEdited: true,
                };
                // 订单来源的物品：来源与时间由订单锁定，不写回界面值
                if (!shoppingLock) patch.source = source || "未标注";
                if (canEditTitle) patch.title = finalTitle;
                if (canEditDate) {
                    patch.date = date || "近期";
                    const ts = parseBackpackTime(date);
                    if (ts) patch.timestamp = ts;
                }
                if (item.recipient === "user") patch.visibleTo = visibleTo.slice();
                updateBackpackItem(item.id, patch);
                toast?.("已保存物品修改");
            }
            onSaved();
        } finally {
            setSaving(false);
        }
    };

    const saveVisible = () => {
        const ids = [...visibleDraft];
        setVisibleTo(ids);
        if (item && !isNew) {
            updateBackpackItem(item.id, { visibleTo: ids, userEdited: true });
        }
        toast?.(ids.length > 0 ? `已让 ${ids.length} 个角色知道这件物品` : "已设为仅自己知道");
        setVisibleOpen(false);
    };

    const transferLabel = isNew
        ? ""
        : (isUserTarget || item?.recipient === "user") ? "送给…" : "放入到…";

    const lockTag = (
        <span className="bp-lock-tag">
            <span>订单锁定</span>
        </span>
    );

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onClose}>
            <div
                onClick={e => e.stopPropagation()}
                style={{
                    position: "relative",
                    display: "flex",
                    flexDirection: "column",
                    width: "min(92vw, 450px)",
                    maxHeight: "84vh",
                    background: "var(--c-page-body-bg,#ffffff)",
                    color: "var(--c-text,#1f2937)",
                    borderRadius: 16,
                    overflow: "hidden",
                    boxShadow: "0 16px 40px rgba(0,0,0,0.22)",
                    fontFamily: "inherit",
                }}
            >
                {/* 标题栏 */}
                <div style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "14px 18px",
                    borderBottom: "1px solid rgba(128,128,128,0.12)",
                }}>
                    <span style={{ fontWeight: 600, fontSize: TS(14), color: "var(--c-text)" }}>
                        {isNew ? "添加物品到背包" : "物品详情与修改"}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{
                            border: "none",
                            background: "transparent",
                            color: "var(--c-text)",
                            padding: 2,
                            cursor: "pointer",
                            display: "flex",
                            opacity: 0.75,
                        }}
                    >
                        <IconClose />
                    </button>
                </div>

                {/* 内容 */}
                <div style={{
                    padding: "16px 18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    overflowY: "auto",
                    maxHeight: "70vh",
                }}>
                    {/* 图标 + 名称 */}
                    <div style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: 12,
                        borderRadius: 10,
                        background: "rgba(128,128,128,0.05)",
                        border: "1px solid rgba(128,128,128,0.1)",
                    }}>
                        <div
                            onClick={() => setImgBoxOpen(v => !v)}
                            title="点击更换图片"
                            style={{
                                position: "relative",
                                width: 44,
                                height: 44,
                                borderRadius: 10,
                                background: "var(--bp-accent-light)",
                                color: "var(--bp-accent)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                flexShrink: 0,
                                cursor: "pointer",
                                overflow: "hidden",
                            }}
                        >
                            {customImage ? (
                                /* eslint-disable-next-line @next/next/no-img-element */
                                <img src={customImage} className="backpack-custom-thumb" alt="" />
                            ) : item?.previewIcon ? (
                                <span style={{ fontSize: TS(18) }} aria-hidden>{item.previewIcon}</span>
                            ) : (
                                <IconGift />
                            )}
                        </div>
                        <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <span style={{ fontSize: TS(11), color: "var(--c-icon)" }}>物品名称</span>
                                <button
                                    type="button"
                                    onClick={() => setImgBoxOpen(v => !v)}
                                    style={{
                                        border: "none",
                                        background: "transparent",
                                        color: "var(--bp-accent)",
                                        fontSize: TS(11),
                                        padding: 0,
                                        cursor: "pointer",
                                    }}
                                >
                                    更换图片
                                </button>
                            </div>
                            {canEditTitle ? (
                                <input
                                    className="bp-input-field"
                                    value={title}
                                    onChange={e => setTitle(e.target.value)}
                                    placeholder="例如：冻干草莓脆"
                                    style={{ fontWeight: 600, fontSize: TS(13) }}
                                />
                            ) : (
                                <>
                                    <div className="bp-readonly-value">{item?.title ?? ""}</div>
                                    <div className="bp-readonly-hint">名称来自卡片，如需修改请手动添加一件物品</div>
                                </>
                            )}
                        </div>
                    </div>

                    {/* 图片控制区 */}
                    {imgBoxOpen && (
                        <div style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 10,
                            padding: 12,
                            borderRadius: 10,
                            background: "rgba(128,128,128,0.06)",
                            border: "1px solid rgba(128,128,128,0.12)",
                        }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                <span style={{ fontSize: TS(12), fontWeight: 600, color: "var(--c-text)" }}>
                                    更换物品图片
                                </span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setCustomImage("");
                                        setUrlDraft("");
                                    }}
                                    style={{
                                        border: "none",
                                        background: "transparent",
                                        color: "#9ca3af",
                                        fontSize: TS(11),
                                        padding: 0,
                                        cursor: "pointer",
                                    }}
                                >
                                    恢复默认图标
                                </button>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <input
                                    ref={fileRef}
                                    type="file"
                                    accept="image/*"
                                    style={{ display: "none" }}
                                    onChange={e => {
                                        const file = e.target.files?.[0];
                                        if (file) void handlePickFile(file);
                                        e.target.value = "";
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={() => fileRef.current?.click()}
                                    style={{
                                        border: "none",
                                        background: "rgba(128,128,128,0.15)",
                                        color: "var(--c-text)",
                                        padding: "6px 10px",
                                        borderRadius: 6,
                                        fontSize: TS(11),
                                        cursor: "pointer",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 4,
                                    }}
                                >
                                    <IconUpload />
                                    <span>上传本地图片</span>
                                </button>
                                <span style={{ fontSize: TS(10), color: "var(--c-icon)" }}>自动轻量压缩</span>
                            </div>

                            <div style={{ display: "flex", gap: 6 }}>
                                <input
                                    className="bp-input-field"
                                    value={urlDraft}
                                    onChange={e => setUrlDraft(e.target.value)}
                                    placeholder="输入图片链接 (URL)..."
                                    style={{ flex: 1, fontSize: TS(11), padding: "5px 8px" }}
                                />
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!urlDraft.trim()) {
                                            toast?.("请输入有效的图片 URL");
                                            return;
                                        }
                                        if (!isValidImageUrl(urlDraft.trim())) {
                                            toast?.("图片链接无效或过大，仅支持 http/https/data:image");
                                            return;
                                        }
                                        setCustomImage(urlDraft.trim());
                                        toast?.("预览已更新，点击保存即可生效");
                                    }}
                                    style={{
                                        border: "none",
                                        background: "rgba(128,128,128,0.15)",
                                        color: "var(--c-text)",
                                        padding: "5px 12px",
                                        borderRadius: 6,
                                        fontSize: TS(11),
                                        cursor: "pointer",
                                    }}
                                >
                                    应用
                                </button>
                            </div>
                        </div>
                    )}

                    {/* 来源 / 价值 */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 12px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                                <span style={{ fontSize: TS(11), color: "var(--c-icon)" }}>来源 / 赠予人</span>
                                {shoppingLock && lockTag}
                            </div>
                            {shoppingLock ? (
                                <div className="bp-readonly-value" style={{ fontWeight: 400 }}>
                                    {shoppingLock.merchantLabel}
                                </div>
                            ) : (
                                <input
                                    className="bp-input-field"
                                    value={source}
                                    onChange={e => setSource(e.target.value)}
                                    placeholder="例如：穆叶"
                                />
                            )}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            <span style={{ fontSize: TS(11), color: "var(--c-icon)" }}>价值</span>
                            <input
                                className="bp-input-field"
                                value={value}
                                onChange={e => setValue(e.target.value)}
                                placeholder="例如：29.90"
                            />
                        </div>
                    </div>

                    {/* 商品详情（购物来源，锁定） */}
                    {shoppingLock?.detail && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                                <span style={{ fontSize: TS(11), color: "var(--c-icon)" }}>商品详情</span>
                                {lockTag}
                            </div>
                            <div className="bp-readonly-value" style={{ fontWeight: 400 }}>
                                {shoppingLock.detail}
                            </div>
                        </div>
                    )}

                    {/* 时间 */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                            <span style={{ fontSize: TS(11), color: "var(--c-icon)" }}>
                                送出时间 / 记录时间
                            </span>
                            {shoppingLock && lockTag}
                        </div>
                        {canEditDate ? (
                            <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                                <input
                                    className="bp-input-field"
                                    value={date}
                                    onChange={e => setDate(e.target.value)}
                                    placeholder="例如：09/12 14:30"
                                    style={{ flex: 1 }}
                                />
                                <button
                                    type="button"
                                    title="填入当前时间"
                                    onClick={() => setDate(formatBackpackTime(Date.now()))}
                                    style={{
                                        border: "1px solid rgba(128,128,128,0.2)",
                                        background: "rgba(128,128,128,0.08)",
                                        color: "var(--c-text)",
                                        padding: "0 12px",
                                        borderRadius: 8,
                                        fontSize: TS(11),
                                        cursor: "pointer",
                                        whiteSpace: "nowrap",
                                        fontFamily: "inherit",
                                        flexShrink: 0,
                                    }}
                                >
                                    现在
                                </button>
                            </div>
                        ) : (
                            <div style={{
                                fontSize: TS(12),
                                color: "var(--c-text)",
                                padding: "7px 10px",
                                background: "rgba(128,128,128,0.06)",
                                borderRadius: 8,
                                border: "1px solid rgba(128,128,128,0.12)",
                                userSelect: "text",
                            }}>
                                {item?.date || "近期"}
                            </div>
                        )}
                        {!canEditDate && !shoppingLock && (
                            <div className="bp-readonly-hint">时间来自卡片，如需修改请手动添加一件物品</div>
                        )}
                    </div>

                    {/* 备注 */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <span style={{ fontSize: TS(12), fontWeight: 600, color: "var(--c-text)" }}>物品备注</span>
                        <textarea
                            className="bp-input-field"
                            value={note}
                            onChange={e => setNote(e.target.value)}
                            placeholder="填写物品备注说明（可不填）..."
                            style={{ height: 78, padding: "8px 10px", resize: "none", lineHeight: 1.5 }}
                        />
                    </div>
                </div>

                {/* 底部按钮 */}
                <div style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    padding: "12px 18px",
                    background: "rgba(128,128,128,0.04)",
                    borderTop: "1px solid rgba(128,128,128,0.1)",
                    flexWrap: "wrap",
                }}>
                    {!isNew && (
                        <button
                            type="button"
                            onClick={() => onTransfer(item!)}
                            style={{
                                border: "1px solid rgba(128,128,128,0.25)",
                                background: "transparent",
                                color: "var(--c-text)",
                                padding: "6px 12px",
                                borderRadius: 6,
                                fontSize: TS(12),
                                cursor: "pointer",
                            }}
                        >
                            {transferLabel}
                        </button>
                    )}
                    {!isNew && item?.recipient === "user" && (
                        <button
                            type="button"
                            onClick={() => setVisibleOpen(true)}
                            style={{
                                border: "1px solid rgba(59,130,246,0.35)",
                                background: "rgba(59,130,246,0.08)",
                                color: "#3b82f6",
                                padding: "6px 12px",
                                borderRadius: 6,
                                fontSize: TS(12),
                                cursor: "pointer",
                            }}
                        >
                            {visibleTo.length > 0 ? `可见角色(${visibleTo.length})` : "可见角色"}
                        </button>
                    )}
                    <div style={{ flex: 1 }} />
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
                    <button
                        type="button"
                        disabled={saving}
                        onClick={handleSave}
                        style={{
                            border: "none",
                            background: "var(--bp-accent)",
                            color: "#ffffff",
                            padding: "6px 16px",
                            borderRadius: 6,
                            fontSize: TS(12),
                            fontWeight: 500,
                            cursor: saving ? "not-allowed" : "pointer",
                            opacity: saving ? 0.5 : 1,
                        }}
                    >
                        保存
                    </button>
                </div>

                {/* 可见角色浮层 */}
                {visibleOpen && (
                    <div className="bp-sub-overlay" onClick={() => setVisibleOpen(false)}>
                        <div className="bp-sub-panel" onClick={e => e.stopPropagation()}>
                            <div className="bp-sub-head">
                                <div>
                                    <div className="bp-sub-title">让哪些角色知道这件物品</div>
                                    <div className="bp-sub-hint">
                                        {visibleDraft.size === 0
                                            ? "（当前没有角色知道这件物品）"
                                            : `当前让 ${visibleDraft.size} 个角色知道`}
                                    </div>
                                </div>
                            </div>
                            <div className="bp-sub-list">
                                {characterTargets.length === 0 ? (
                                    <div className="bp-sub-empty">暂无可选角色</div>
                                ) : (
                                    characterTargets.map(t => (
                                        <label key={t.id} className="bp-target-edit-item">
                                            <input
                                                type="checkbox"
                                                className="bp-pick-check"
                                                checked={visibleDraft.has(t.id)}
                                                onChange={e => {
                                                    setVisibleDraft(prev => {
                                                        const next = new Set(prev);
                                                        if (e.target.checked) next.add(t.id);
                                                        else next.delete(t.id);
                                                        return next;
                                                    });
                                                }}
                                            />
                                            <span className="bp-pick-name">{t.rawName}</span>
                                        </label>
                                    ))
                                )}
                            </div>
                            <div className="bp-sub-foot" style={{ justifyContent: "space-between" }}>
                                <button
                                    type="button"
                                    onClick={() => setVisibleDraft(new Set(characterTargets.map(t => t.id)))}
                                    style={{
                                        border: "none",
                                        background: "transparent",
                                        color: "var(--bp-accent)",
                                        fontSize: TS(12),
                                        padding: 0,
                                        cursor: "pointer",
                                    }}
                                >
                                    全选
                                </button>
                                <div style={{ display: "flex", gap: 8 }}>
                                    <button
                                        type="button"
                                        onClick={() => setVisibleOpen(false)}
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
                                    <button
                                        type="button"
                                        onClick={saveVisible}
                                        style={{
                                            border: "none",
                                            background: "var(--bp-accent)",
                                            color: "#ffffff",
                                            padding: "6px 16px",
                                            borderRadius: 6,
                                            fontSize: TS(12),
                                            fontWeight: 500,
                                            cursor: "pointer",
                                        }}
                                    >
                                        保存
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
