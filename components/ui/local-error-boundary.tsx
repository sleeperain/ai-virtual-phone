"use client";

// 局部错误边界：把「一个组件崩掉」限制在它自己那一块里。
//
// 为什么需要它：整台虚拟手机的桌面、音乐播放页、桌面歌词挂在同一棵 React 树上，
// 任何一个组件在渲染期抛错，React 18 会把异常一路冒泡到根节点 → 整个页面变成
// 「界面出了点问题」的错误页。实报：歌词数据里少个字段，用户连手机桌面都进不去。
//
// 用法：
//   <LocalErrorBoundary label="桌面歌词" silent><MusicFloat /></LocalErrorBoundary>
//   <LocalErrorBoundary label="播放页"><MusicPlayer /></LocalErrorBoundary>
//
// silent 不等于静默删功能：它只是把兜底卡片从屏幕中央挪到底部一条窄提示，
// 仍然写明「哪块没加载出来 + 错误原因」，并提供复制按钮。浮层坏掉时用户
// 至少知道发生了什么，而不是以为功能被删了。
//
// 注意能力边界：错误边界只能捕获「渲染 / 生命周期 / 子树构造」阶段的异常。
// 事件回调、setTimeout、Promise 里的异常走不到这里，那类问题要各自 try/catch。

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 局部崩溃的广播事件：边界吞掉异常后，外层还能收到一份。
 * 手机上打不开控制台，silent 边界把浮层按 null 渲染出去，用户只会觉得
 * 「这个功能被删了」，所以必须有一条能给用户看的通路。
 */
export const LOCAL_ERROR_EVENT = "app-local-error";

export type LocalErrorDetail = {
    label: string;
    message: string;
    stack?: string;
};

type LocalErrorBoundaryProps = {
    /** 出错时报出来的名字，例如「播放页」「桌面歌词」 */
    label: string;
    children: ReactNode;
    /** 崩溃时直接不渲染。浮层 / 装饰类组件适合用它，避免兜底卡片挡住界面 */
    silent?: boolean;
    /** 自定义兜底提示 */
    hint?: string;
};

type LocalErrorBoundaryState = {
    failed: boolean;
    message: string;
    stack?: string;
    /** 重试次数：崩溃 → 重试 → 再崩 是无底洞，上限到了就别再让用户点 */
    retries: number;
    /** 用户手动关掉的小标记（silent 外层用） */
    dismissed: boolean;
};

/** 崩溃后允许重试的次数上限。超过就说明不是偶发，重试只会把界面拖进
 *  「崩→重挂载→再崩」的循环，那才是真正让人感觉卡的原因。 */
const MAX_RETRIES = 2;

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message || error.name;
    if (typeof error === "string") return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

export class LocalErrorBoundary extends Component<LocalErrorBoundaryProps, LocalErrorBoundaryState> {
    state: LocalErrorBoundaryState = { failed: false, message: "", retries: 0, dismissed: false };

    static getDerivedStateFromError(error: unknown): Partial<LocalErrorBoundaryState> {
        return { failed: true, message: describeError(error), dismissed: false };
    }

    componentDidCatch(error: unknown, info: ErrorInfo): void {
        const message = describeError(error);
        const stack = info.componentStack ?? undefined;
        // 不往上抛，只留日志：宿主页面的控制台里能查到具体是哪个子树炸的
        console.warn(
            `[LocalErrorBoundary] 「${this.props.label}」渲染崩溃：${message}`,
            info.componentStack,
        );
        this.setState(prev => ({ stack, retries: prev.retries }));
        // 再广播一份给外层（桌面用它弹提示），否则静默兜底等于无声删功能
        try {
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent<LocalErrorDetail>(LOCAL_ERROR_EVENT, {
                    detail: {
                        label: this.props.label,
                        message,
                        stack,
                    },
                }));
            }
        } catch {
            // 事件派发失败不影响兜底渲染
        }
    }

    private retry = (): void => {
        if (this.state.retries >= MAX_RETRIES) return;
        this.setState(prev => ({ failed: false, message: "", retries: prev.retries + 1, dismissed: false }));
    };

    private dismiss = (): void => {
        this.setState({ dismissed: true });
    };

    /** 把这条错误抄给用户 / 反馈用：手机上没有控制台，这是唯一出口 */
    private copyDetail = (): void => {
        const text = [
            `组件：${this.props.label}`,
            `时间：${new Date().toISOString()}`,
            `错误：${this.state.message}`,
            this.state.stack ? `组件栈：${this.state.stack}` : "",
        ].filter(Boolean).join("\n");
        try {
            void navigator.clipboard?.writeText(text).catch(() => {
                window.prompt("复制失败，请手动复制：", text);
            });
        } catch {
            window.prompt("请手动复制：", text);
        }
    };

    render(): ReactNode {
        if (!this.state.failed) return this.props.children;

        // silent：浮层类组件不占屏幕中央，但绝不再"消失"——
        // 留一条贴在底部的窄提示，告诉用户这块没加载出来、可以点开看原因。
        if (this.props.silent) {
            if (this.state.dismissed) return null;
            return (
                <div
                    role="status"
                    style={{
                        position: "absolute",
                        left: 12,
                        right: 12,
                        bottom: 96,
                        zIndex: 9998,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "7px 10px",
                        borderRadius: 12,
                        background: "rgba(28, 28, 34, 0.78)",
                        color: "#f2f2f6",
                        backdropFilter: "blur(10px)",
                        WebkitBackdropFilter: "blur(10px)",
                        fontSize: 11.5,
                        lineHeight: 1.5,
                        fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
                    }}
                >
                    <span style={{ flex: 1, minWidth: 0, wordBreak: "break-all" }}>
                        「{this.props.label}」没加载出来：{this.state.message}
                    </span>
                    <button
                        type="button"
                        onClick={this.copyDetail}
                        style={{ flex: "0 0 auto", padding: "3px 8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.28)", background: "transparent", color: "#fff", fontSize: 11 }}
                    >
                        复制
                    </button>
                    <button
                        type="button"
                        onClick={this.dismiss}
                        aria-label="关闭提示"
                        style={{ flex: "0 0 auto", padding: "3px 6px", border: "none", background: "transparent", color: "rgba(255,255,255,0.62)", fontSize: 13, cursor: "pointer" }}
                    >
                        ✕
                    </button>
                </div>
            );
        }

        return (
            <div
                role="alert"
                style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    transform: "translate(-50%, -50%)",
                    zIndex: 9999,
                    width: "min(86%, 320px)",
                    boxSizing: "border-box",
                    padding: "18px 16px",
                    borderRadius: 16,
                    background: "rgba(28, 28, 34, 0.92)",
                    color: "#f2f2f6",
                    backdropFilter: "blur(14px)",
                    WebkitBackdropFilter: "blur(14px)",
                    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.28)",
                    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
                    fontSize: 13,
                    lineHeight: 1.65,
                }}
            >
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
                    「{this.props.label}」没能加载出来
                </div>
                <div style={{ opacity: 0.72, marginBottom: 12 }}>
                    {this.props.hint || "只有这一块出了问题，桌面和其它功能照常可用。"}
                </div>
                <div
                    style={{
                        opacity: 0.55,
                        fontSize: 11.5,
                        wordBreak: "break-all",
                        marginBottom: 12,
                    }}
                >
                    {this.state.message}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <button
                        type="button"
                        onClick={this.retry}
                        disabled={this.state.retries >= MAX_RETRIES}
                        style={{
                            flex: 1,
                            minHeight: 34,
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.22)",
                            background: "rgba(255,255,255,0.1)",
                            color: "#fff",
                            fontSize: 13,
                            opacity: this.state.retries >= MAX_RETRIES ? 0.45 : 1,
                            cursor: this.state.retries >= MAX_RETRIES ? "default" : "pointer",
                        }}
                    >
                        {this.state.retries >= MAX_RETRIES ? "重试次数已用完" : "重试"}
                    </button>
                    <button
                        type="button"
                        onClick={this.copyDetail}
                        style={{
                            flex: "0 0 auto",
                            minHeight: 34,
                            padding: "0 14px",
                            borderRadius: 10,
                            border: "1px solid rgba(255,255,255,0.22)",
                            background: "transparent",
                            color: "#fff",
                            fontSize: 13,
                            cursor: "pointer",
                        }}
                    >
                        复制错误
                    </button>
                </div>
            </div>
        );
    }
}

export default LocalErrorBoundary;
