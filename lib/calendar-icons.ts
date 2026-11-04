// 日程图标：一套内置的线条 SVG（24×24、描边 1.8、圆头），取代原来那排 emoji 预设。
// 只放纯数据（键名、中文名、路径），不带 JSX——存储层、提示词层要校验键名，
// 渲染交给 components/calendar/schedule-icons.tsx，避免 lib 被 React 污染。

export const CALENDAR_ICON_KEYS = [
  "pin",
  "star",
  "briefcase",
  "book",
  "laptop",
  "activity",
  "dumbbell",
  "utensils",
  "coffee",
  "film",
  "gamepad",
  "music",
  "cart",
  "bag",
  "plane",
  "hospital",
  "phone",
  "moon",
  "heart",
  "cake",
  "palette",
  "broom",
  "paw",
  "users",
  "home",
] as const;

export type CalendarIconKey = (typeof CALENDAR_ICON_KEYS)[number];

export const CALENDAR_ICON_LABELS: Record<CalendarIconKey, string> = {
  pin: "图钉",
  star: "重要",
  briefcase: "工作",
  book: "学习",
  laptop: "电脑",
  activity: "运动",
  dumbbell: "健身",
  utensils: "用餐",
  coffee: "咖啡",
  film: "电影",
  gamepad: "游戏",
  music: "音乐",
  cart: "购物",
  bag: "逛街",
  plane: "出行",
  hospital: "医院",
  phone: "电话",
  moon: "休息",
  heart: "约会",
  cake: "生日",
  palette: "创作",
  broom: "家务",
  paw: "宠物",
  users: "聚会",
  home: "在家",
};

/** 每个图标就是若干条 path 的 d（圆的路径由 a 弧拼出来，全统一成 path 好渲染） */
export const CALENDAR_ICON_PATHS: Record<CalendarIconKey, string[]> = {
  pin: [
    "M12 17v5",
    "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z",
  ],
  star: ["m12 3 2.8 6 6.2.9-4.5 4.4 1 6.2-5.5-3-5.5 3 1-6.2L3 9.9 9.2 9z"],
  briefcase: [
    "M4 7h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z",
    "M16 17V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v12",
  ],
  book: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20", "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"],
  laptop: [
    "M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
    "M2 20h20",
  ],
  activity: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  dumbbell: ["M6.5 6.5l11 11", "M21 21l-1-1", "M3 3l1 1", "M18 22l4-4", "M2 6l4-4", "M3 10l7-7", "M14 21l7-7"],
  utensils: ["M3 2v7a2 2 0 0 0 4 0V2", "M5 11v11", "M18 2c-1.7 0-3 2.2-3 5s1.3 4 3 4", "M18 11v11"],
  coffee: [
    "M17 8h1a4 4 0 0 1 0 8h-1",
    "M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z",
    "M6 2v2",
    "M10 2v2",
    "M14 2v2",
  ],
  film: [
    "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    "M7 4v16",
    "M17 4v16",
    "M2 9h5",
    "M2 15h5",
    "M17 9h5",
    "M17 15h5",
  ],
  gamepad: ["M7 8h10a5 5 0 0 1 0 10H7a5 5 0 0 1 0-10z", "M7 11v4", "M5 13h4", "M16 12h.01", "M18.5 15h.01"],
  music: [
    "M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
    "M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
    "M9 18V6l12-2v12",
  ],
  cart: [
    "M9 21.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
    "M18 21.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
    "M2 3h3l2.6 12h11.2L22 7H6",
  ],
  bag: ["M6 8h12l1.5 12H4.5z", "M9 8V6a3 3 0 0 1 6 0v2"],
  plane: ["M22 2L11 13", "M22 2l-7 20-4-9-9-4z"],
  hospital: ["M4 21V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13", "M12 9v6", "M9 12h6", "M2 21h20"],
  phone: [
    "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z",
  ],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"],
  heart: ["M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l8.8 8.8 8.8-8.8a5.5 5.5 0 0 0 0-7.8z"],
  cake: [
    "M4 20h16",
    "M6 20v-7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v7",
    "M12 11V7",
    "M12 6.5a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z",
  ],
  palette: [
    "M12 21a9 9 0 1 1 9-9c0 2.2-1.8 3-3 3h-2a2 2 0 0 0-1.4 3.4A2 2 0 0 1 13 21z",
    "M9 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    "M15 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    "M8.5 14a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  ],
  broom: ["M9 4h6l1 7H8z", "M12 11v6", "M8 21h8", "M7 21l1.5-4h7L17 21"],
  paw: [
    "M7 9.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z",
    "M12 7.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z",
    "M17 9.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z",
    "M8 15.5c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5S14.2 19 12 19s-4-1.5-4-3.5z",
  ],
  users: [
    "M9 11.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z",
    "M2.5 20a6.5 6.5 0 0 1 13 0",
    "M16.5 5.2a3.2 3.2 0 0 1 0 5.6",
    "M18 20a6.5 6.5 0 0 0-2-4.7",
  ],
  home: ["m3 10 9-7 9 7", "M5 9.5V21h14V9.5"],
};

export function isCalendarIconKey(value: unknown): value is CalendarIconKey {
  return typeof value === "string" && (CALENDAR_ICON_KEYS as readonly string[]).includes(value);
}

/** 存进条目时先过一遍：不认识的键名一律当没选 */
export function sanitizeScheduleIconKey(value: unknown): string {
  return isCalendarIconKey(value) ? value : "";
}
