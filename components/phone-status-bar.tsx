"use client";

import { useEffect, useState } from "react";

/* ══════════════════════════════════════════
   手机顶部状态栏（时间 / 信号 / WiFi / 电池）

   锁屏要显示和桌面一致的状态栏，但桌面那份（StatusClock /
   StatusConnectivity / StatusBattery）内联在 desktop-shell.tsx 里，
   而 desktop-shell 有 5000+ 行且会连带引一堆服务模块——开屏阶段为了一个
   状态栏去 import 它，首屏要白等一大坨 JS，正是解锁卡顿的来源之一。
   所以这里放一份等价实现，只依赖 React。

   ⚠️ 改动外观时请与 desktop-shell.tsx 里的同名组件同步，
   两处样式都走 phone-shell.css 的 .phone-status-bar / .status-* 类。
   ══════════════════════════════════════════ */

type BatteryManagerLike = {
  level: number;
  charging?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

type NetworkInformationLike = {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function StatusClock() {
  const [label, setLabel] = useState("--:--");

  useEffect(() => {
    const update = () => {
      setLabel(
        new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
      );
    };
    update();
    const timer = window.setInterval(update, 10000);
    return () => window.clearInterval(timer);
  }, []);

  return <span className="status-time">{label}</span>;
}

function StatusConnectivity() {
  const [showSignal, setShowSignal] = useState(true);
  const [showWifi, setShowWifi] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;
    const nav = navigator as Navigator & {
      connection?: NetworkInformationLike;
      mozConnection?: NetworkInformationLike;
      webkitConnection?: NetworkInformationLike;
    };
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;

    const sync = () => {
      const online = nav.onLine !== false;
      if (!online) {
        setShowSignal(false);
        setShowWifi(false);
        return;
      }
      const connType = conn?.type;
      if (!connType || connType === "unknown") {
        setShowSignal(true);
        setShowWifi(true);
        return;
      }
      if (connType === "none") {
        setShowSignal(false);
        setShowWifi(false);
        return;
      }
      if (connType === "cellular") {
        setShowSignal(true);
        setShowWifi(false);
        return;
      }
      if (connType === "wifi" || connType === "ethernet") {
        setShowSignal(true);
        setShowWifi(true);
        return;
      }
      setShowSignal(true);
      setShowWifi(true);
    };

    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    conn?.addEventListener?.("change", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      conn?.removeEventListener?.("change", sync);
    };
  }, []);

  return (
    <>
      {showSignal && (
        <svg viewBox="0 0 72 51" className="status-signal" fill="currentColor">
          <path d="M11.6,41.9c0,1.4,0,2.8,0,4.3c0,2.3-1.4,3.7-3.6,3.8c-1.5,0.1-3,0.1-4.4,0c-1.9-0.1-3.2-1.2-3.4-3c-0.3-3.4-0.2-6.8,0-10.1c0.1-1.8,1.5-3,3.3-3.1c1.5-0.1,3-0.1,4.4,0c2.2,0.1,3.6,1.5,3.7,3.8C11.6,39,11.6,40.5,11.6,41.9z" />
          <path d="M31.7,36.9c0,2.8,0,5.7,0,8.5c0,3.5-1.1,4.6-4.5,4.6c-1.2,0-2.4,0-3.6,0c-2-0.1-3.4-1.5-3.4-3.4c-0.1-6.5-0.1-13,0-19.6c0-1.9,1.6-3.4,3.6-3.5c1.4-0.1,2.7,0,4.1,0c2.3,0.1,3.8,1.4,3.8,3.8C31.8,30.5,31.7,33.7,31.7,36.9z" />
          <path d="M40.4,30.3c0-5,0-10.1,0-15.1c0-3,1.2-4.2,4.2-4.2c1,0,2,0,3,0c2.9,0,4.2,1.4,4.2,4.2c0,9,0,17.9,0,26.9c0,1.4,0,2.7,0,4.1c0,2.3-1.4,3.8-3.7,3.8c-1.3,0-2.6,0-3.9,0c-2.5-0.1-3.8-1.3-3.8-3.9C40.4,40.9,40.4,35.6,40.4,30.3z" />
          <path d="M72,25.7c0,6.6,0,13.3,0,19.9c0,3.2-1.2,4.4-4.4,4.4c-1.1,0-2.3,0-3.4,0c-2.3-0.1-3.7-1.4-3.8-3.8c0-2.9,0-5.8,0-8.7c0-10.6,0-21.2,0-31.8c0-3.3,1.2-4.5,4.5-4.5c0.9,0,1.8,0,2.7,0c3.1,0,4.4,1.3,4.4,4.5C72,12.3,72,19,72,25.7z" />
        </svg>
      )}
      {showWifi && (
        <svg viewBox="98 0 67 51" className="status-wifi" fill="currentColor">
          <path d="M134.6,0c9.8,0.1,20.4,4.8,29.2,13.7c1.6,1.6,1.6,2.1,0,3.8c-0.8,0.8-1.6,1.6-2.3,2.5c-1.1,1.3-2.1,1.2-3.3,0c-3.5-3.7-7.6-6.5-12.3-8.6c-13-5.6-28.3-2.7-38.7,7.3c-0.5,0.5-0.9,0.9-1.4,1.4c-1,1.1-2,1.1-3-0.1c-0.9-1.1-2-2-3-3.1c-0.9-0.9-0.9-1.8,0-2.8C107.7,5.4,119.9,0,134.6,0z" />
          <path d="M132.1,13.9c8.9,0.2,16.5,3.5,22.8,9.8c1.1,1.1,1.1,2.1,0,3.2c-0.9,0.9-1.8,1.9-2.7,2.8c-1.1,1.2-2,1.1-3.1,0c-3.9-3.9-8.6-6.3-14.1-6.9c-7.5-0.9-13.9,1.5-19.4,6.5c-1.9,1.8-2.1,1.8-3.9,0c-0.8-0.8-1.6-1.7-2.5-2.6c-1.1-1-1-2,0-3C115.5,17.5,123.1,14.1,132.1,13.9z" />
          <path d="M131.9,27.8c5.4,0.1,9.8,2,13.6,5.5c1.1,1,1.2,2,0.1,3c-0.9,0.9-1.9,1.8-2.7,2.8c-1.1,1.4-2.1,1.3-3.4,0.2c-3.6-3-7.7-3.7-12.1-1.9c-1.3,0.5-2.4,1.3-3.4,2.2c-0.9,0.8-1.8,0.9-2.6-0.1c-1.1-1.1-2.1-2.2-3.2-3.3c-0.9-1-0.8-1.8,0.1-2.8C122.2,29.8,126.8,27.9,131.9,27.8z" />
          <path d="M132,41.6c1.8,0,3.5,0.5,5,1.6c0.9,0.6,1.1,1.3,0.2,2.2c-1.5,1.5-2.9,2.9-4.4,4.4c-0.7,0.7-1.2,0.6-1.8,0c-1.5-1.6-2.9-3.1-4.4-4.6c-0.7-0.8-0.5-1.3,0.2-1.9C128.4,42.1,130.1,41.5,132,41.6z" />
        </svg>
      )}
    </>
  );
}

function StatusBattery() {
  const [level, setLevel] = useState<number | null>(null);
  const [charging, setCharging] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    if (typeof nav.getBattery !== "function") return;
    let cancelled = false;
    let battery: BatteryManagerLike | null = null;
    const sync = () => {
      if (cancelled || !battery) return;
      const raw = Number(battery.level);
      if (Number.isFinite(raw)) {
        setLevel(Math.max(0, Math.min(1, raw)));
      }
      setCharging(Boolean(battery.charging));
    };
    void nav.getBattery().then((b) => {
      if (cancelled || !b) return;
      battery = b;
      sync();
      b.addEventListener?.("levelchange", sync);
      b.addEventListener?.("chargingchange", sync);
    }).catch(() => {});
    return () => {
      cancelled = true;
      battery?.removeEventListener?.("levelchange", sync);
      battery?.removeEventListener?.("chargingchange", sync);
    };
  }, []);

  const barWidth = level === null ? 14 : Math.max(0, Math.min(19, Math.round(level * 19 * 10) / 10));
  const barFill = charging
    ? "#22c55e"
    : level !== null && level < 0.05
      ? "#ef4444"
      : level !== null && level < 0.2
        ? "#eab308"
        : "currentColor";

  return (
    <svg viewBox="0 0 26 12" className="status-battery" fill="currentColor">
      <rect x="0.5" y="0.5" width="22" height="11" rx="2.6" fill="none" stroke="currentColor" strokeOpacity="0.42" strokeWidth="1" />
      <rect x="22.7" y="4" width="1.8" height="4" rx="0.7" opacity="0.42" />
      {barWidth > 0 && <rect x="2" y="2" width={barWidth} height="8" rx="1.5" fill={barFill} />}
    </svg>
  );
}

/**
 * 顶部状态栏。
 * @param tone "light" 用于锁屏这类深色背景：时间与图标转白，阴影略微加深保证可读。
 */
export function PhoneStatusBar({ tone }: { tone?: "light" }) {
  return (
    <header className="phone-status-bar" data-tone={tone}>
      <StatusClock />
      <div className="status-island" />
      <div className="status-right" aria-hidden>
        <StatusConnectivity />
        <StatusBattery />
      </div>
    </header>
  );
}
