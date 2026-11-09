"use client";

// 局部错误边界：把「一个组件崩掉」限制在它自己那一块里。
//
// 为什么需要它：整台虚拟手机的桌面、音乐播放页、桌面歌词挂在同一棵 React 树上，
// 任何一个组件在渲染期抛错，React 18 会把异常一路冒泡到根节点 → 整个页面变成
// 「界面出了点问题」的错误页。实报：歌词数据里少个字段，用户连手机桌面都进不去。
//
// 用法（浮层类组件用 silent，宁可没有也别挡住桌面）：
//   <LocalErrorBoundary label="桌面歌词" silent><MusicFloat /></LocalErrorBoundary>
//   <LocalErrorBoundary label="播放页"><MusicPlayer /></LocalErrorBoundary>
//
// 注意能力边界：错误边界只能捕获「渲染 / 生命周期 / 子树构造」阶段的异常。
// 事件回调、setTimeout、Promise 里的异常走不到这里，那类问题要各自 try/catch。

import { Component, type ErrorInfo, type ReactNode } from "react";

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
};

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
    state: LocalErrorBoundaryState = { failed: false, message: "" };

    static getDerivedStateFromError(error: unknown): Partial<LocalErrorBoundaryState> {
        return { failed: true, message: describeError(error) };
    }

    componentDidCatch(error: unknown, info: ErrorInfo): void {
        // 不往上抛，只留日志：宿主页面的控制台里能查到具体是哪个子树炸的
        console.warn(
            `[LocalErrorBoundary] 「${this.props.label}」渲染崩溃：${describeError(error)}`,
            info.componentStack,
        );
    }

    private retry = (): void => {
        this.setState({ failed: false, message: "" });
    };

    render(): ReactNode {
        if (!this.state.failed) return this.props.children;
        if (this.props.silent) return null;

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
                <button
                    type="button"
                    onClick={this.retry}
                    style={{
                        width: "100%",
                        minHeight: 34,
                        borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.22)",
                        background: "rgba(255,255,255,0.1)",
                        color: "#fff",
                        fontSize: 13,
                        cursor: "pointer",
                    }}
                >
                    重试
                </button>
            </div>
        );
    }
}

export default LocalErrorBoundary;
