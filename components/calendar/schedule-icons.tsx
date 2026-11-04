"use client";

// 日程图标的渲染器：路径数据在 lib/calendar-icons.ts，这里只负责画。
// 风格和日历其它线条图标一致（24×24、无填充、1.8 描边、圆头圆角）。

import { CALENDAR_ICON_PATHS, isCalendarIconKey } from "@/lib/calendar-icons";

export function ScheduleIcon({
  name,
  size = 15,
  className,
}: {
  name?: string | null;
  size?: number;
  className?: string;
}) {
  if (!isCalendarIconKey(name)) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {CALENDAR_ICON_PATHS[name].map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
