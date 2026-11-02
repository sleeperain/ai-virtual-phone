"use client";

// components/chat/backpack-item-editor.tsx
// 原生背包 · 物品详情 / 新建
//
// 购物订单来源的物品：来源（店铺名）、购买时间、详情由订单锁定，
// 界面上只读并标注锁图标——用户在别处改不动物品的真实出处。

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Lock, Upload, X } from "lucide-react";
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
    /** "user" 或角色 id */
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

/** 压缩到 200×200，保持体积可控 */
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
    const [source, setSource] = useState(shoppingLock ? shoppingLock.merchantLabel : (item?.source === "未标注" ? "" : item?.source ?? ""));
    const [value, setValue] = useState(item?.value === "--" ? "" : item?.value ?? "");
    const [date, setDate] = useState(item?.date && item.date !== "近期" ? item.date : formatBackpackTime(Date.now()));
    const [note, setNote] = useState(item?.note ?? "");
    const [customImage, setCustomImage] = useState(item?.customImage ?? "");
    const [imgBoxOpen, setImgBoxOpen] = useState(false);
    const [urlDraft, setUrlDraft] = useState(item?.customImage?.startsWith("data:") ? "" : item?.customImage ?? "");
    const [saving, setSaving] = useState(false);
    const [visibleTo, setVisibleTo] = useState<string[]>(
        Array.isArray(item?.visibleTo) ? item.visibleTo.filter(Boolean) : [],
    );
    const [visibleOpen, setVisibleOpen] = useState(false);
    /** 「可见角色」弹窗里的勾选草稿 */
    const [visibleTargets, setVisibleTargets] = useState<Set<string>>(
        new Set(Array.isArray(item?.visibleTo) ? item.visibleTo.filter(Boolean) : []),
    );
    const fileRef = useRef<HTMLInputElement>(null);

    // 「可见角色」只列角色（不含群）：物品归属与可见范围都以角色为单位
    const usableTargets = useMemo(() => loadBackpackTargets().filter(t => !t.isUser), []);

    // 每次打开弹窗都从物品当前的 visibleTo 重新初始化草稿
    useEffect(() => {
        if (!visibleOpen) return;
        setVisibleTargets(new Set(Array.isArray(item?.visibleTo) ? item.visibleTo.filter(Boolean) : []));
    }, [visibleOpen, item?.visibleTo]);

    const handlePickFile = async (file: File) => {
        try {
            toast?.("正在处理图片…");
            const compressed = await compressImageFile(file);
            if (compressed.length > MAX_IMAGE_LEN) {
                toast?.("图片过大，请换一张");
                return;
            }
            setCustomImage(compressed);
            toast?.("预览已更新，保存后生效");
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
                    source: shoppingLock ? shoppingLock.merchantLabel : source,
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
                    value,
                    note,
                    customImage: finalImage,
                    userEdited: true,
                };
                // 来源被订单锁定时不写回，避免界面值覆盖真实店铺
                if (!shoppingLock) patch.source = source || "未标注";
                if (canEditTitle) patch.title = finalTitle;
                if (canEditDate) {
                    patch.date = date || "近期";
                    const ts = parseBackpackTime(date);
                    if (ts) patch.timestamp = ts;
                }
                if (item.recipient === "user") {
                    patch.visibleTo = visibleTo.slice();
                }
                updateBackpackItem(item.id, patch);
                toast?.("已保存物品修改");
            }
            onSaved();
        } finally {
            setSaving(false);
        }
    };

    // 「可见角色」改的是这件物品自己的 visibleTo：保存后这些角色
    // 就能在提示词里看到它，与转送白名单（哪些角色能接收）是两件事。
    const handleSaveVisible = () => {
        const ids = [...visibleTargets];
        setVisibleTo(ids);
        if (item && !isNew) {
            updateBackpackItem(item.id, { visibleTo: ids, userEdited: true });
        }
        toast?.(ids.length > 0 ? `已让 ${ids.length} 个角色知道这件物品` : "已设为仅自己知道");
        setVisibleOpen(false);
    };

    const lockedBadge = (
        <span className="bp-lock-tag">
            <Lock />
            <span>订单锁定</span>
        </span>
    );

    // 我的背包 → 送给角色（会发卡片）；角色背包 → 放入到别处（纯转移）
    const transferLabel = isNew
        ? ""
        : (isUserTarget || item?.recipient === "user")
            ? "送给…"
            : "放入到…";

    return (
        <div className="modal-overlay" data-ui="modal" onClick={onClose}>
            <div className="bp-sheet" onClick={e => e.stopPropagation()}>
                <div className="bp-sheet-head">
                    <span className="bp-sheet-title">{isNew ? "添加物品到背包" : "物品详情与修改"}</span>
                    <button type="button" className="bp-icon-btn" aria-label="关闭" onClick={onClose}>
                        <X />
                    </button>
                </div>

                <div className="bp-sheet-body">
                    <div className="bp-icon-row">
                        <button
                            type="button"
                            className="bp-icon-preview"
                            title="点击更换图片"
                            onClick={() => setImgBoxOpen(v => !v)}
                        >
                            {customImage ? (
                                <img src={customImage} alt="" className="bp-item-icon-img" />
                            ) : item?.previewIcon ? (
                                <span aria-hidden>{item.previewIcon}</span>
                            ) : (
                                <Camera size={18} strokeWidth={1.6} />
                            )}
                        </button>
                        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                <span className="bp-field-label">物品名称</span>
                                <button
                                    type="button"
                                    className="bp-text-btn"
                                    onClick={() => setImgBoxOpen(v => !v)}
                                >
                                    更换图片
                                </button>
                            </div>
                            {canEditTitle ? (
                                <input
                                    className="bp-input"
                                    value={title}
                                    onChange={e => setTitle(e.target.value)}
                                    placeholder="例如：冻干草莓脆"
                                    style={{ fontWeight: 600 }}
                                />
                            ) : (
                                <>
                                    <div className="bp-readonly">{item?.title ?? ""}</div>
                                    <div className="bp-readonly-hint">名称来自记录，如需修改请手动添加一件物品</div>
                                </>
                            )}
                        </div>
                    </div>

                    {imgBoxOpen && (
                        <div className="bp-img-box">
                            <div className="bp-img-box-head">
                                <span className="bp-img-box-title">更换物品图片</span>
                                <button
                                    type="button"
                                    className="bp-text-btn"
                                    data-tone="muted"
                                    onClick={() => {
                                        setCustomImage("");
                                        setUrlDraft("");
                                    }}
                                >
                                    恢复默认图标
                                </button>
                            </div>
                            <div className="bp-img-row">
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
                                    className="bp-btn"
                                    data-variant="outline"
                                    onClick={() => fileRef.current?.click()}
                                >
                                    <Upload size={12} />
                                    <span>上传本地图片</span>
                                </button>
                                <span className="bp-readonly-hint">自动轻量压缩</span>
                            </div>
                            <div className="bp-img-row">
                                <input
                                    className="bp-input"
                                    value={urlDraft}
                                    onChange={e => setUrlDraft(e.target.value)}
                                    placeholder="输入图片链接 (URL)…"
                                />
                                <button
                                    type="button"
                                    className="bp-btn"
                                    data-variant="ghost"
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
                                        toast?.("预览已更新，保存后生效");
                                    }}
                                >
                                    应用
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="bp-grid-2">
                        <div className="bp-field">
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                                <span className="bp-field-label">来源 / 赠予人</span>
                                {shoppingLock && lockedBadge}
                            </div>
                            {shoppingLock ? (
                                <div className="bp-readonly">{shoppingLock.merchantLabel}</div>
                            ) : (
                                <input
                                    className="bp-input"
                                    value={source}
                                    onChange={e => setSource(e.target.value)}
                                    placeholder="例如：穆叶"
                                />
                            )}
                        </div>
                        <div className="bp-field">
                            <span className="bp-field-label">价值</span>
                            <input
                                className="bp-input"
                                value={value}
                                onChange={e => setValue(e.target.value)}
                                placeholder="例如：29.90"
                            />
                        </div>
                    </div>

                    {shoppingLock?.detail && (
                        <div className="bp-field">
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                                <span className="bp-field-label">商品详情</span>
                                {lockedBadge}
                            </div>
                            <div className="bp-readonly" style={{ fontWeight: 400, color: "var(--c-text)" }}>
                                {shoppingLock.detail}
                            </div>
                        </div>
                    )}

                    <div className="bp-field">
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                            <span className="bp-field-label">送出时间 / 购买时间</span>
                            {shoppingLock && lockedBadge}
                        </div>
                        {canEditDate ? (
                            <div className="bp-date-row">
                                <input
                                    className="bp-input"
                                    value={date}
                                    onChange={e => setDate(e.target.value)}
                                    placeholder="例如：09/12 14:30"
                                />
                                <button
                                    type="button"
                                    className="bp-btn"
                                    data-variant="outline"
                                    onClick={() => setDate(formatBackpackTime(Date.now()))}
                                >
                                    现在
                                </button>
                            </div>
                        ) : (
                            <div className="bp-readonly" style={{ fontWeight: 400 }}>{item?.date || "近期"}</div>
                        )}
                        {!canEditDate && !shoppingLock && (
                            <div className="bp-readonly-hint">时间来自记录，如需修改请手动添加一件物品</div>
                        )}
                    </div>

                    <div className="bp-field">
                        <span className="bp-field-label">物品备注</span>
                        <textarea
                            className="bp-textarea"
                            value={note}
                            onChange={e => setNote(e.target.value)}
                            placeholder="填写物品备注说明（可不填）…"
                        />
                    </div>
                </div>

                <div className="bp-sheet-foot">
                    {!isNew && item && (
                        <button
                            type="button"
                            className="bp-btn"
                            data-variant="outline"
                            onClick={() => onTransfer(item)}
                        >
                            {transferLabel}
                        </button>
                    )}
                    {!isNew && item?.recipient === "user" && (
                        <button
                            type="button"
                            className="bp-btn"
                            data-variant="info"
                            onClick={() => setVisibleOpen(true)}
                        >
                            {visibleTo.length > 0 ? `可见角色(${visibleTo.length})` : "可见角色"}
                        </button>
                    )}
                    <div className="bp-foot-spacer" />
                    <button type="button" className="bp-btn" data-variant="ghost" onClick={onClose}>
                        取消
                    </button>
                    <button
                        type="button"
                        className="bp-btn"
                        data-variant="primary"
                        disabled={saving}
                        onClick={handleSave}
                    >
                        保存
                    </button>
                </div>

                {visibleOpen && (
                    <div className="bp-sub-overlay" onClick={() => setVisibleOpen(false)}>
                        <div className="bp-sub-panel" onClick={e => e.stopPropagation()}>
                            <div className="bp-sub-head">
                                <div>
                                    <div className="bp-sub-title">让哪些角色知道这件物品</div>
                                    <div className="bp-sub-hint">
                                        {visibleTo.length === 0 ? "当前没有角色知道这件物品" : `当前让 ${visibleTo.length} 个角色知道`}
                                    </div>
                                </div>
                            </div>
                            <div className="bp-sub-list">
                                {usableTargets.length === 0 ? (
                                    <div className="bp-sub-empty">暂无可选角色</div>
                                ) : (
                                    usableTargets.map(t => (
                                        <label key={t.id} className="bp-pick-row">
                                            <input
                                                type="checkbox"
                                                className="bp-pick-check"
                                                checked={visibleTargets.has(t.id)}
                                                onChange={e => {
                                                    setVisibleTargets(prev => {
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
                            <div className="bp-sub-foot">
                                <button
                                    type="button"
                                    className="bp-btn"
                                    data-variant="ghost"
                                    onClick={() => setVisibleOpen(false)}
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    className="bp-btn"
                                    data-variant="primary"
                                    onClick={handleSaveVisible}
                                >
                                    保存
                                </button>
                                <button
                                    type="button"
                                    className="bp-btn"
                                    data-variant="outline"
                                    onClick={() => {
                                        setVisibleTargets(new Set(usableTargets.map(t => t.id)));
                                    }}
                                >
                                    全选
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}


