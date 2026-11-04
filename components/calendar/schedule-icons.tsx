"use client";

// 日程图标的渲染器：直接使用 Lucide 官方组件库，保证与日历顶栏及全站线条图标视觉完全一致。

import {
  Activity,
  BookOpen,
  Briefcase,
  Cake,
  Coffee,
  Dumbbell,
  Film,
  Gamepad2,
  Heart,
  Home,
  Hospital,
  Laptop,
  Moon,
  Music,
  Palette,
  PawPrint,
  Phone,
  Pin,
  Plane,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Star,
  Users,
  Utensils,
  type LucideIcon,
} from "lucide-react";
import { isCalendarIconKey, type CalendarIconKey } from "@/lib/calendar-icons";

const LUCIDE_SCHEDULE_ICONS: Record<CalendarIconKey, LucideIcon> = {
  pin: Pin,
  star: Star,
  briefcase: Briefcase,
  book: BookOpen,
  laptop: Laptop,
  activity: Activity,
  dumbbell: Dumbbell,
  utensils: Utensils,
  coffee: Coffee,
  film: Film,
  gamepad: Gamepad2,
  music: Music,
  cart: ShoppingCart,
  bag: ShoppingBag,
  plane: Plane,
  hospital: Hospital,
  phone: Phone,
  moon: Moon,
  heart: Heart,
  cake: Cake,
  palette: Palette,
  broom: Sparkles,
  paw: PawPrint,
  users: Users,
  home: Home,
};

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
  const Icon = LUCIDE_SCHEDULE_ICONS[name];
  if (!Icon) return null;
  return (
    <Icon
      size={size}
      strokeWidth={1.85}
      className={className}
      aria-hidden="true"
    />
  );
}
