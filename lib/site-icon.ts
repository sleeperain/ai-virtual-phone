/**
 * 网页图标（favicon）：把主题里存的那张图挂到文档的 <link rel="icon"> 上。
 *
 * 只动 rel="icon" / rel="shortcut icon" 两处，不碰 apple-touch-icon 和
 * manifest 里的 icons —— 后两者是「添加到主屏幕」用的安装图标，由服务端
 * 静态资源决定，浏览器不接受 data: URL，改了反而会让桌面上那个图标失效。
 *
 * 本模块不 import 任何存储模块：theme-storage 要反过来 import 这里的
 * 事件常量，反向依赖会成环。
 */

export const DEFAULT_SITE_ICON_HREF = "/icon-192.png";

/** 主题里的网页图标变了（上传 / 恢复默认 / 导入主题包 / 重置外观），通知全局同步 */
export const SITE_ICON_CHANGED_EVENT = "ai-phone-site-icon-changed";

function ensureIconLink(): HTMLLinkElement {
  const link = document.createElement("link");
  link.rel = "icon";
  link.href = DEFAULT_SITE_ICON_HREF;
  link.type = "image/png";
  document.head.appendChild(link);
  return link;
}

/**
 * 应用网页图标。传 null 表示恢复安装包自带的那张。
 * 用 data: URL 直接指过去：换图后 href 变了，浏览器会自己重新解析，
 * 不需要额外加时间戳参数。
 */
export function applySiteIcon(dataUrl: string | null): void {
  if (typeof document === "undefined" || !document.head) return;

  const href = dataUrl && dataUrl.startsWith("data:") ? dataUrl : DEFAULT_SITE_ICON_HREF;
  const existing = Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"]')
  );
  const links = existing.length > 0 ? existing : [ensureIconLink()];

  for (const link of links) {
    link.href = href;
    if (href === DEFAULT_SITE_ICON_HREF) {
      link.setAttribute("type", "image/png");
      link.removeAttribute("sizes");
    } else {
      // 自定义图可能是 png / jpeg / webp / svg，交给浏览器自己嗅探
      link.removeAttribute("type");
      link.removeAttribute("sizes");
    }
  }
}

/** 广播「网页图标变了」，由全局的 SiteIconSync 重新读一遍主题并应用 */
export function notifySiteIconChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SITE_ICON_CHANGED_EVENT));
}
