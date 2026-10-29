"use client";

import { useEffect, useRef } from "react";

import { applySiteIcon, SITE_ICON_CHANGED_EVENT } from "@/lib/site-icon";
import { getThemeAssetDataUrl, readThemeProfile } from "@/lib/theme-storage";

/**
 * 把主题里存的网页图标挂到文档上。挂在 MainApp 里（此时 KV 已水合、
 * 主题已读出来），刷新页面也能恢复上次换的图标；之后主题一保存就会
 * 收到 SITE_ICON_CHANGED_EVENT 重新同步。
 */
export function SiteIconSync() {
  /** 已经应用过哪个资源 id（null = 安装包自带图标）；undefined = 还没应用过 */
  const appliedRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      const assetId = readThemeProfile().faviconAssetId;

      // 壁纸/主题色滑块的每一帧都会写一次主题、发一次事件，但 favicon 没变。
      // 这里先比 id 直接跳过，免得每帧都去 IndexedDB 读一遍大 base64。
      if (assetId === appliedRef.current) return;

      if (!assetId) {
        appliedRef.current = null;
        applySiteIcon(null);
        return;
      }

      try {
        const dataUrl = await getThemeAssetDataUrl(assetId);
        if (cancelled) return;
        appliedRef.current = assetId;
        applySiteIcon(dataUrl);
      } catch (error) {
        if (cancelled) return;
        console.warn("[SiteIcon] 网页图标读取失败，回退安装包图标：", error);
        appliedRef.current = null;
        applySiteIcon(null);
      }
    };

    void sync();
    window.addEventListener(SITE_ICON_CHANGED_EVENT, sync);
    return () => {
      cancelled = true;
      window.removeEventListener(SITE_ICON_CHANGED_EVENT, sync);
    };
  }, []);

  return null;
}
