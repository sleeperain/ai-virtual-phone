"use client";

import { ClientErrorView } from "@/components/client-error-view";

// 根级错误边界：兜住根 layout 或首屏渲染阶段的崩溃。
// Next 在 global-error 生效时不套用 app/layout.tsx，所以这里必须自带 <html>/<body>，
// 样式也不能依赖 globals.css（可能没加载成），全部由 ClientErrorView 内联给。
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <html lang="zh-CN">
            <head>
                <meta name="viewport" content="width=device-width, initial-scale=1, viewportFit=cover" />
                <meta name="theme-color" content="#f8f7f2" />
                <title>界面出了点问题</title>
            </head>
            <body style={{ margin: 0, background: "#f8f7f2" }}>
                <ClientErrorView error={error} reset={reset} scope="global" />
            </body>
        </html>
    );
}
