"use client";

import { useState } from "react";

import { DiaryEntriesApp } from "./diary-entries-app";
import { MomentsApp } from "./moments-app";
import type { DiaryBrandView } from "./diary-brand-header";

type DiaryAppProps = {
  onClose: () => void;
  onNotice?: (message: string) => void;
};

/**
 * 手记 App 的入口：不再有「手记首页」那张卡片列表页，
 * 打开就直接进 TA的手记；和片刻纪事之间用顶部栏的铃铛 / 星星切换。
 */
export function DiaryApp({ onClose, onNotice }: DiaryAppProps) {
  const [view, setView] = useState<DiaryBrandView>("entries");

  if (view === "moments") {
    return (
      <MomentsApp
        onClose={onClose}
        onSwitch={setView}
        onNotice={onNotice}
      />
    );
  }

  return (
    <DiaryEntriesApp
      kind="character"
      onClose={onClose}
      onSwitch={setView}
      onNotice={onNotice}
    />
  );
}
