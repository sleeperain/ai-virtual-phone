"use client";

import { useEffect, useState } from "react";

/* ══════════════════════════════════════════
   极简大号时间（日期 + 星期一行，大字时间一行）

   原来只作为桌面组件 largeTime 存在 widget-renderer.tsx 里。
   锁屏也要同一套排板，所以抽出来共用：
   - 桌面组件：<LargeTimeDisplay />            尺寸/配色走 widgets.css 的 .wg-lt-*
   - 锁屏：    <LargeTimeDisplay variant="lock" date={now} />
               只改排版（白色大字），并复用调用方的时间，避免两边各跑一个定时器

   ⚠️ 桌面外观不能因为这个抽取发生变化：默认分支的 className 与结构保持原样。
   ══════════════════════════════════════════ */

const WEEKDAYS_CN = ["日", "一", "二", "三", "四", "五", "六"] as const;

export function LargeTimeDisplay({
  variant,
  date,
}: {
  /** "lock" = 锁屏排版：白色大字、无卡片底 */
  variant?: "lock";
  /** 传入时间则不自己走定时器（锁屏已有秒级计时，避免重复） */
  date?: Date;
}) {
  const [tick, setTick] = useState<Date>(() => new Date());

  useEffect(() => {
    if (date) return;
    const timer = setInterval(() => setTick(new Date()), 1000);
    return () => clearInterval(timer);
  }, [date]);

  const time = date ?? tick;
  const h = String(time.getHours()).padStart(2, "0");
  const m = String(time.getMinutes()).padStart(2, "0");
  const month = time.getMonth() + 1;
  const day = time.getDate();
  const weekday = `周${WEEKDAYS_CN[time.getDay()]}`;
  // 桌面组件原有写法是「6月8日 周五」（带空格）；锁屏按需求用「6月8日周五」
  const gap = variant === "lock" ? "" : " ";

  return (
    <div className="wg-large-time" data-variant={variant}>
      <div className="wg-lt-date">
        {month}月{day}日{gap}{weekday}
      </div>
      <div className="wg-lt-time">
        {h}:{m}
      </div>
    </div>
  );
}
