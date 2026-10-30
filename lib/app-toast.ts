"use client";

/** 全屏通用 toast。
 *
 *  宿主是桌面壳根部那个 toast 组件（`components/weixin-sync-toast.tsx`，
 *  组件名还叫 WeixinSyncToast —— 它最早只为微信云同步服务，现在同时收这里的
 *  通用事件，这样任何 App、任何弹窗里发提示都不必自己画一块，
 *  也不会被弹窗的 transform / 滚动容器裁掉。
 */

export const APP_TOAST_EVENT = "ai-phone:app-toast";

export type AppToastDetail = {
    /** 同一个 id 的后续事件原地替换；text 传 null 表示撤下 */
    id: string;
    text?: string | null;
    /** true = 常驻到被同 id 的后续事件替换或撤下（适合「进行中」这类状态） */
    sticky?: boolean;
    /** 非 sticky 时停留多久，默认 2200ms */
    duration?: number;
};

export function showAppToast(detail: AppToastDetail): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent<AppToastDetail>(APP_TOAST_EVENT, { detail }));
}

export function dismissAppToast(id: string): void {
    showAppToast({ id, text: null });
}

/** 不会撞车的 toast id。带序号是必要的：同名 id 会互相替换，
 *  两个弹窗同时发提示时后发的会把前一个顶掉。 */
let seq = 0;
export function appToastId(prefix = "toast"): string {
    seq += 1;
    return `${prefix}-${seq}-${Date.now().toString(36)}`;
}
