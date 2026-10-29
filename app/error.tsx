"use client";

import { ClientErrorView } from "@/components/client-error-view";

// 页面级错误边界：根 layout 正常时由它接管，字体、主题变量这些外壳仍然保留。
// 根布局自身再崩一层，还有 app/global-error.tsx 兜着。
export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return <ClientErrorView error={error} reset={reset} scope="route" />;
}
