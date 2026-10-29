"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

// ── 客户端崩溃兜底视图 ───────────────────────────────
// Next 默认在生产环境只给一句 “Application error: a client-side exception has occurred”，
// 页面上什么都看不到，用户只能去浏览器 console 里捞堆栈。
// 这里把出错现场（消息、digest、堆栈、地址、UA）直接摆到页面上，并提供两条自救路径：
//   1. 重试：让 React 重新渲染这一棵子树（大多数瞬时错误就此恢复）
//   2. 清除缓存并重载：清 Cache Storage + 注销 Service Worker 后硬刷新
//      —— 自部署场景最常见的一类崩溃就是旧 HTML 配新 chunk，这一步能直接解决。
// 只清缓存与 SW，不碰 IndexedDB/localStorage 里的聊天记录等用户数据。

const LOG_KEY = "float_client_error_log_v1";
const MAX_LOG_ENTRIES = 10;

type ErrorScope = "global" | "route";

type ClientErrorLogEntry = {
    at: string;
    scope: ErrorScope;
    message: string;
    digest?: string;
    url: string;
    ua: string;
};

/** 最近崩溃留档：下次排查不必再让用户接 chrome://inspect 才能拿到报错 */
function appendClientErrorLog(entry: ClientErrorLogEntry): void {
    if (typeof window === "undefined") return;
    try {
        const raw = window.localStorage.getItem(LOG_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        const list = Array.isArray(parsed) ? (parsed as ClientErrorLogEntry[]) : [];
        const next = [entry, ...list].slice(0, MAX_LOG_ENTRIES);
        window.localStorage.setItem(LOG_KEY, JSON.stringify(next));
    } catch {
        // 隐私模式或配额满：错误页里不能再抛一次，静默放弃留档
    }
}

const shellStyle: CSSProperties = {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "32px 20px",
    background: "#f8f7f2",
    color: "#2b2a27",
    fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    fontSize: "14px",
    lineHeight: 1.65,
    boxSizing: "border-box",
};

const cardStyle: CSSProperties = {
    width: "100%",
    maxWidth: "520px",
    background: "#fffefb",
    border: "1px solid rgba(0, 0, 0, 0.07)",
    borderRadius: "16px",
    padding: "22px 20px 20px",
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.06)",
};

const titleStyle: CSSProperties = {
    margin: "0 0 6px",
    fontSize: "17px",
    fontWeight: 600,
    letterSpacing: "0.01em",
};

const subtitleStyle: CSSProperties = {
    margin: "0 0 18px",
    fontSize: "13px",
    color: "#7a766e",
};

const buttonRowStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
    marginBottom: "14px",
};

const primaryButtonStyle: CSSProperties = {
    flex: "1 1 130px",
    minHeight: "40px",
    padding: "0 16px",
    borderRadius: "10px",
    border: "1px solid transparent",
    background: "#2b2a27",
    color: "#fdfcf9",
    fontSize: "14px",
    fontWeight: 500,
    cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
    flex: "1 1 130px",
    minHeight: "40px",
    padding: "0 16px",
    borderRadius: "10px",
    border: "1px solid rgba(0, 0, 0, 0.14)",
    background: "transparent",
    color: "#2b2a27",
    fontSize: "14px",
    cursor: "pointer",
};

const linkButtonStyle: CSSProperties = {
    padding: 0,
    border: "none",
    background: "none",
    color: "#6b665d",
    fontSize: "12.5px",
    cursor: "pointer",
    textDecoration: "underline",
};

const preStyle: CSSProperties = {
    margin: "10px 0 0",
    padding: "12px",
    maxHeight: "220px",
    overflow: "auto",
    borderRadius: "10px",
    background: "rgba(0, 0, 0, 0.035)",
    fontSize: "11.5px",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    WebkitOverflowScrolling: "touch",
};

const noteStyle: CSSProperties = {
    margin: "12px 0 0",
    fontSize: "12px",
    color: "#8a857c",
};

export function ClientErrorView({
    error,
    reset,
    scope,
}: {
    error: Error & { digest?: string };
    reset: () => void;
    scope: ErrorScope;
}) {
    const loggedRef = useRef(false);
    const [detailOpen, setDetailOpen] = useState(false);
    const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
    const [purging, setPurging] = useState(false);

    const detail = useMemo(() => {
        const lines = [
            `位置：${scope === "global" ? "根级崩溃（global-error）" : "页面级崩溃（error）"}`,
            `时间：${new Date().toISOString()}`,
            `地址：${typeof window === "undefined" ? "" : window.location.href}`,
            `信息：${error.message || "（没有 message）"}`,
            error.digest ? `digest：${error.digest}` : "",
            typeof navigator === "undefined" ? "" : `UA：${navigator.userAgent}`,
            error.stack ? `\n堆栈：\n${error.stack}` : "",
        ].filter(Boolean);
        return lines.join("\n");
    }, [error, scope]);

    // 只留一次档：React 严格模式下 effect 会重跑
    useEffect(() => {
        if (loggedRef.current) return;
        loggedRef.current = true;
        appendClientErrorLog({
            at: new Date().toISOString(),
            scope,
            message: error.message || String(error),
            digest: error.digest,
            url: typeof window === "undefined" ? "" : window.location.href,
            ua: typeof navigator === "undefined" ? "" : navigator.userAgent,
        });
    }, [error, scope]);

    const copyDetail = async () => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(detail);
            } else {
                // 非安全上下文（http / 部分 WebView）没有 clipboard API，退回老办法
                const area = document.createElement("textarea");
                area.value = detail;
                area.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
                document.body.appendChild(area);
                area.select();
                document.execCommand("copy");
                document.body.removeChild(area);
            }
            setCopyState("ok");
        } catch {
            setCopyState("fail");
        }
        window.setTimeout(() => setCopyState("idle"), 2400);
    };

    const purgeCacheAndReload = async () => {
        setPurging(true);
        try {
            if (typeof caches !== "undefined") {
                const keys = await caches.keys();
                await Promise.all(keys.map((key) => caches.delete(key)));
            }
            if ("serviceWorker" in navigator) {
                const registrations = await navigator.serviceWorker.getRegistrations();
                await Promise.all(registrations.map((registration) => registration.unregister()));
            }
        } catch {
            // 清理失败也照样尝试重载，能救一点是一点
        }
        window.location.reload();
    };

    return (
        <div style={shellStyle}>
            <div style={cardStyle}>
                <h1 style={titleStyle}>界面出了点问题</h1>
                <p style={subtitleStyle}>
                    这一页在渲染时崩了，你本地的数据没有丢。可以先点「重试」，多数情况能直接恢复；
                    如果刷新后一打开就又崩，用「清除缓存并重载」。
                </p>

                <div style={buttonRowStyle}>
                    <button type="button" style={primaryButtonStyle} onClick={reset} disabled={purging}>
                        重试
                    </button>
                    <button
                        type="button"
                        style={secondaryButtonStyle}
                        onClick={purgeCacheAndReload}
                        disabled={purging}
                    >
                        {purging ? "清理中..." : "清除缓存并重载"}
                    </button>
                </div>

                <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
                    <button
                        type="button"
                        style={linkButtonStyle}
                        onClick={() => setDetailOpen((open) => !open)}
                        aria-expanded={detailOpen}
                    >
                        {detailOpen ? "收起错误详情" : "查看错误详情"}
                    </button>
                    <button type="button" style={linkButtonStyle} onClick={() => { void copyDetail(); }}>
                        {copyState === "ok" ? "已复制" : copyState === "fail" ? "复制失败，请手动选取" : "复制错误详情"}
                    </button>
                </div>

                {detailOpen && <pre style={preStyle}>{detail}</pre>}

                <p style={noteStyle}>
                    「清除缓存并重载」只清浏览器缓存和离线缓存，不会动聊天记录、角色卡、书籍这些本地数据。
                    如果问题反复出现，把上面复制的错误详情发给小坊。
                </p>
            </div>
        </div>
    );
}
