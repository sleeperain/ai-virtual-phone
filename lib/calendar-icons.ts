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



export function isCalendarIconKey(value: unknown): value is CalendarIconKey {
  return typeof value === "string" && (CALENDAR_ICON_KEYS as readonly string[]).includes(value);
}

/** 存进条目时先过一遍：不认识的键名一律当没选 */
export function sanitizeScheduleIconKey(value: unknown): string {
  return isCalendarIconKey(value) ? value : "";
}
