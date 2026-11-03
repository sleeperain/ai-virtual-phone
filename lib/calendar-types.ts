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
  /** 事项 emoji 图标（可选，一个 emoji） */
  emoji?: string;
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
