export type CalendarOwnerType = "user" | "character";

export type CalendarColorKey =
  | "blue"
  | "green"
  | "amber"
  | "rose"
  | "violet"
  | "teal"
  | "slate"
  | "lilac";

export type CalendarScheduleItem = {
  id: string;
  date: string;       // YYYY-MM-DD
  weekday: string;    // 周一 ~ 周日
  startTime: string;  // HH:MM
  endTime: string;    // HH:MM
  location: string;
  title: string;
  /** 旧版 emoji 图标：只用来显示历史数据，新选的图标走 iconKey */
  emoji?: string;
  /** 内置线条 SVG 图标的键名（lib/calendar-icons.ts） */
  iconKey?: string;
  colorKey: CalendarColorKey;
  source: "manual" | "generated";
  createdAt: string;
  updatedAt: string;
};

export type CalendarWeekPlan = {
  id: string;
  ownerType: CalendarOwnerType;
  ownerId: string;
  weekStart: string; // YYYY-MM-DD, Monday
  items: CalendarScheduleItem[];
  updatedAt: string;
};

/** 角色生活节律（常规作息）区分「工作日」与「节假日」两类 */
export type CalendarRoutineDayType = "workday" | "holiday";

export type CalendarRoutineItem = {
  id: string;
  dayType: CalendarRoutineDayType;
  startTime: string;  // HH:MM
  endTime: string;    // HH:MM
  location: string;
  title: string;
  /** 备注：比事项更细的活动描写（作息不再配图标，改成写一句话说明） */
  note: string;
  /** 历史数据里可能还留着 emoji，不再展示也不再写入 */
  emoji?: string;
  colorKey: CalendarColorKey;
  source: "manual" | "generated";
  createdAt: string;
  updatedAt: string;
};

export type CalendarCharacterRoutinePlan = {
  id: string;
  ownerId: string;
  items: CalendarRoutineItem[];
  updatedAt: string;
};
