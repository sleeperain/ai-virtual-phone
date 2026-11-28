"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Clock3 } from "lucide-react";

import type { Character } from "@/lib/character-types";
import { useDiaryGenerating } from "@/lib/diary-generating-tracker";
import {
  DIARY_ENTRIES_UPDATED_EVENT,
  DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT,
} from "@/lib/diary-entry-timer-service";
import {
  loadDiaryEntryTimerSettings,
  loadDiaryReplyRules,
  saveDiaryEntryTimerSettings,
  saveDiaryReplyRules,
} from "@/lib/diary-entry-storage";
import type {
  DiaryEntryTimerSettings,
  DiaryFontKind,
  DiaryReplyMode,
  DiaryReplyRules,
} from "@/lib/diary-entry-types";
import {
  loadMomentAvatar,
  loadMomentProfiles,
  momentUserOwner,
  saveMomentAvatar,
  saveMomentProfiles,
  type MomentProfileOwner,
  type MomentProfiles,
} from "@/lib/moment-storage";
import { READING_AVATAR_MAX_SIZE, compressReadingImage } from "@/lib/reading-image";
import { DiaryBrandHeader, type DiaryBrandView } from "./diary-brand-header";
import { CharacterAvatarGrid } from "./diary-character-grid";
import { useDiaryFont } from "./use-diary-font";

/** 用户设置的四个页签，从左到右：定时 / 隐私 / 字体 / 署名 */
export type DiarySettingsTab = "timer" | "privacy" | "font" | "profile";

const DIARY_SETTINGS_TABS: { id: DiarySettingsTab; label: string }[] = [
  { id: "timer", label: "定时" },
  { id: "privacy", label: "隐私" },
  { id: "font", label: "字体" },
  { id: "profile", label: "署名" },
];

const DIARY_REPLY_MODE_LABELS: Record<DiaryReplyMode, string> = {
  none: "不回应",
  immediate: "立即回应",
  delay: "延时回应",
  merge: "和下次互动合并",
};

const DIARY_REPLY_MODE_OPTIONS: DiaryReplyMode[] = ["none", "immediate", "delay", "merge"];

/** 设置页里能改字体的几本：日记 + 片刻纪事的三份（字号的尺子各自一把） */
type SettingsFontKind = Extract<DiaryFontKind, "character" | "moment" | "moment-user" | "moment-char">;

type DiaryUserSettingsPageProps = {
  /** 从哪个列表页进来的：品牌栏的地球/铃铛高亮跟着走 */
  view: DiaryBrandView;
  tab: DiarySettingsTab;
  onTabChange: (tab: DiarySettingsTab) => void;
  characters: Character[];
  /** 顶部栏 iFloat：回桌面 */
  onClose: () => void;
  /** 顶部栏地球/铃铛：先退出设置，再切到另一个列表页 */
  onSwitch: (view: DiaryBrandView) => void;
  /** 退出设置、回到当前列表页（点地球/铃铛时用，不再单独放返回按钮） */
  onExit: () => void;
  onNotice?: (message: string) => void;
};

/**
 * 用户设置：整页复用片刻纪事条目页的版式——
 * 品牌顶部栏 + 「用户设置」标签行 + 等分四页签 + 一页白卡内容。
 */
export function DiaryUserSettingsPage({
  view,
  tab,
  onTabChange,
  characters,
  onClose,
  onSwitch,
  onExit,
  onNotice,
}: DiaryUserSettingsPageProps) {
  const [timer, setTimer] = useState<DiaryEntryTimerSettings>(() => loadDiaryEntryTimerSettings());
  const [rules, setRules] = useState<DiaryReplyRules>(() => loadDiaryReplyRules());
  const [profiles, setProfiles] = useState<MomentProfiles>(() => loadMomentProfiles());
  // 署名头像（阅读图片库里的 blob → objectURL）
  const [avatars, setAvatars] = useState<Record<MomentProfileOwner, string>>({});
  const [avatarRevision, setAvatarRevision] = useState(0);
  const generatingIds = useDiaryGenerating();

  const notify = useCallback((message: string) => {
    onNotice?.(message);
  }, [onNotice]);

  // 五份字体里这个页面用得到四份；上传时把文件框指向哪一份就传给哪一份
  const entryFont = useDiaryFont("character", notify);
  const momentFont = useDiaryFont("moment", notify);
  const momentUserFont = useDiaryFont("moment-user", notify);
  const momentCharFont = useDiaryFont("moment-char", notify);
  const fontFileRef = useRef<HTMLInputElement | null>(null);
  const fontTargetRef = useRef<SettingsFontKind>("character");
  const fontHooks = {
    character: entryFont,
    moment: momentFont,
    "moment-user": momentUserFont,
    "moment-char": momentCharFont,
  } as const;

  const updateTimer = useCallback((next: DiaryEntryTimerSettings) => {
    setTimer(next);
    saveDiaryEntryTimerSettings(next);
    // 定时服务按存储里的设置跑，改完立刻通知它一次
    window.dispatchEvent(new CustomEvent(DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT));
    window.dispatchEvent(new CustomEvent(DIARY_ENTRIES_UPDATED_EVENT));
  }, []);

  const updateRules = useCallback((next: DiaryReplyRules) => {
    setRules(next);
    saveDiaryReplyRules(next);
  }, []);

  // 署名头像：角色换了或者刚传完一张，就重新读一遍
  useEffect(() => {
    let cancelled = false;
    let current: string[] = [];
    const loadAvatars = async () => {
      const ids = characters.map(character => character.id);
      const owners: MomentProfileOwner[] = ["user", ...ids, ...ids.map(momentUserOwner)];
      const entries = await Promise.all(owners.map(async owner => [owner, await loadMomentAvatar(owner)] as const));
      if (cancelled) return;
      const next: Record<MomentProfileOwner, string> = {};
      const urls: string[] = [];
      for (const [owner, blob] of entries) {
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        next[owner] = url;
      }
      current.forEach(url => URL.revokeObjectURL(url));
      current = urls;
      setAvatars(next);
    };
    setProfiles(loadMomentProfiles());
    void loadAvatars();
    return () => {
      cancelled = true;
      current.forEach(url => URL.revokeObjectURL(url));
    };
  }, [characters, avatarRevision]);

  const pickAvatar = useCallback(async (owner: MomentProfileOwner, file: File | null) => {
    try {
      await saveMomentAvatar(owner, file ? await compressReadingImage(file, READING_AVATAR_MAX_SIZE) : null);
      setAvatarRevision(value => value + 1);
    } catch (error) {
      notify("头像保存失败：" + String(error));
    }
  }, [notify]);

  const saveProfiles = useCallback((next: MomentProfiles) => {
    setProfiles(next);
    saveMomentProfiles(next);
  }, []);

  const setCharacterName = (characterId: string, name: string) => {
    const nextCharacters = { ...profiles.characters };
    if (name.trim()) nextCharacters[characterId] = { name };
    else delete nextCharacters[characterId];
    saveProfiles({ ...profiles, characters: nextCharacters });
  };

  const setBookUserName = (characterId: string, name: string) => {
    const userByCharacter = { ...profiles.userByCharacter };
    if (name.trim()) userByCharacter[characterId] = { name };
    else delete userByCharacter[characterId];
    saveProfiles({ ...profiles, userByCharacter });
  };

  const uploadFont = (kind: SettingsFontKind) => {
    fontTargetRef.current = kind;
    fontFileRef.current?.click();
  };

  const toggleTimerCharacter = (characterId: string) => {
    updateTimer({
      ...timer,
      characterIds: timer.characterIds.includes(characterId)
        ? timer.characterIds.filter(id => id !== characterId)
        : [...timer.characterIds, characterId],
    });
  };

  const momentTiers: { kind: SettingsFontKind; title: string; hint: string; custom: boolean }[] = [
    { kind: "moment", title: "系统字体", hint: "其它所有的字", custom: momentFont.hasCustomFont },
    { kind: "moment-user", title: "我的字体", hint: "剧情、聊天里我说的话", custom: momentUserFont.hasCustomFont },
    { kind: "moment-char", title: "角色字体", hint: "聊天里角色说的话；分享图里可选", custom: momentCharFont.hasCustomFont },
  ];

  return (
    <section className="diary-app diary-entry-app diary-settings-page">
      <input
        ref={fontFileRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2,font/*,application/font-woff,application/font-woff2"
        className="hidden"
        onChange={event => void fontHooks[fontTargetRef.current].upload(event)}
      />
      {/* 设置页自己不再挂头像菜单，右上角头像只是身份标识；
          退出设置不另放返回按钮——点顶部栏的地球 / 铃铛就切回列表 */}
      <DiaryBrandHeader
        view={view}
        onClose={onClose}
        onSwitch={(next) => {
          onExit();
          onSwitch(next);
        }}
        avatarLabel="用户设置"
      />

      <main className="diary-entry-main diary-moment-main diary-settings-main">
        {/* 标签行：原来片刻纪事那张「Bookmark」条，这里是「用户设置」 */}
        <div className="diary-moment-label-row diary-settings-label-row">
          <span>用户设置</span>
        </div>

        <div className="diary-hub-tabs diary-settings-tabs" role="tablist" aria-label="用户设置分类">
          {DIARY_SETTINGS_TABS.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`diary-hub-tab ${tab === item.id ? "is-active" : ""}`}
              onClick={() => onTabChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="diary-settings-scroll">
          <div className="diary-hub-entries diary-settings-body">
            {tab === "timer" ? (
              <>
                <section className="diary-settings-section">
                  <div className="diary-entry-setting-grid">
                    <label className="diary-entry-toggle-row">
                      <span>
                        <Clock3 size={17} />
                        定时写日记
                      </span>
                      <input
                        type="checkbox"
                        checked={timer.enabled}
                        onChange={event => updateTimer({ ...timer, enabled: event.target.checked })}
                      />
                    </label>
                    <label className="diary-entry-number-field">
                      <span>间隔小时</span>
                      <input
                        type="number"
                        min={1}
                        max={720}
                        value={timer.intervalHours}
                        onChange={event => updateTimer({
                          ...timer,
                          intervalHours: Math.max(1, Math.min(720, Number(event.target.value) || 24)),
                        })}
                      />
                    </label>
                  </div>
                  <p className="diary-settings-hint">默认一天一次；未选择角色时，会按全部角色处理。</p>
                </section>

                <section className="diary-entry-character-section">
                  <div className="diary-entry-section-title">
                    <strong>定时角色</strong>
                    <span>{timer.characterIds.length ? `已选 ${timer.characterIds.length} 个` : "默认全部"}</span>
                  </div>
                  <CharacterAvatarGrid
                    characters={characters}
                    selectedIds={timer.characterIds}
                    busyIds={generatingIds}
                    disabled={generatingIds.length > 0}
                    onToggle={toggleTimerCharacter}
                  />
                </section>
              </>
            ) : null}

            {tab === "privacy" ? (
              <>
                <section className="diary-settings-section">
                  <div className="diary-entry-setting-grid">
                    <label
                      className="diary-entry-toggle-row"
                      style={rules.default.mode !== "delay" ? { gridColumn: "1 / -1" } : undefined}
                    >
                      <span>默认回应方式</span>
                      <select
                        value={rules.default.mode}
                        onChange={event => updateRules({
                          ...rules,
                          default: { ...rules.default, mode: event.target.value as DiaryReplyMode },
                        })}
                      >
                        {DIARY_REPLY_MODE_OPTIONS.map(mode => (
                          <option key={mode} value={mode}>{DIARY_REPLY_MODE_LABELS[mode]}</option>
                        ))}
                      </select>
                    </label>
                    {rules.default.mode === "delay" ? (
                      <label className="diary-entry-number-field">
                        <span>延时小时</span>
                        <input
                          type="number"
                          min={0.05}
                          max={720}
                          step={0.25}
                          value={rules.default.delayHours}
                          onChange={event => updateRules({
                            ...rules,
                            default: {
                              ...rules.default,
                              delayHours: Math.max(0.05, Math.min(720, Number(event.target.value) || 24)),
                            },
                          })}
                        />
                      </label>
                    ) : null}
                  </div>
                  <p className="diary-settings-hint">
                    写完日记后，TA 会从聊天 App 发普通消息回应；可以统一设置，也能为每个角色单独指定。
                  </p>
                </section>

                <section className="diary-entry-character-section">
                  <div className="diary-entry-section-title">
                    <strong>按角色单独设置</strong>
                  </div>
                  <div className="diary-reply-rule-list">
                    {characters.map(character => {
                      const own = rules.characters[character.id]
                        ?? { mode: "inherit" as const, delayHours: rules.default.delayHours };
                      return (
                        <div key={character.id} className="diary-reply-rule-row">
                          <span className="diary-reply-rule-person">
                            {character.avatar ? <img src={character.avatar} alt="" /> : <Bot size={18} />}
                            <strong>{character.name}</strong>
                          </span>
                          <select
                            value={own.mode}
                            onChange={event => {
                              const mode = event.target.value as DiaryReplyMode | "inherit";
                              updateRules({
                                ...rules,
                                characters: { ...rules.characters, [character.id]: { mode, delayHours: own.delayHours } },
                              });
                            }}
                          >
                            <option value="inherit">跟随默认</option>
                            {DIARY_REPLY_MODE_OPTIONS.map(mode => (
                              <option key={mode} value={mode}>{DIARY_REPLY_MODE_LABELS[mode]}</option>
                            ))}
                          </select>
                          {own.mode === "delay" ? (
                            <input
                              type="number"
                              min={0.05}
                              max={720}
                              step={0.25}
                              value={own.delayHours}
                              onChange={event => {
                                const delayHours = Math.max(
                                  0.05,
                                  Math.min(720, Number(event.target.value) || rules.default.delayHours),
                                );
                                updateRules({
                                  ...rules,
                                  characters: {
                                    ...rules.characters,
                                    [character.id]: { mode: own.mode, delayHours },
                                  },
                                });
                              }}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>

                <p className="diary-entry-note">
                  「和下次互动合并」不会主动发起新对话，只在你们下次真的开口聊天时顺带带出这篇日记；
                  默认设为「不回应」，避免未经确认产生 API 调用。
                </p>
              </>
            ) : null}

            {tab === "font" ? (
              <>
                <section className="diary-settings-section">
                  <strong className="diary-settings-section-title">日记字体</strong>
                  <p className="diary-settings-hint">
                    {entryFont.hasCustomFont ? "已使用自定义字体" : "当前使用默认手写字体"}
                  </p>
                  <button type="button" className="diary-font-upload-action" onClick={() => uploadFont("character")}>
                    <span className="diary-font-upload-mark" aria-hidden="true">Aa</span>
                    <span>上传字体</span>
                  </button>
                  <label className="diary-font-size-control">
                    <span>
                      <strong>字号</strong>
                      <em>{Math.round(entryFont.scale * 100)}%</em>
                    </span>
                    <input
                      type="range"
                      min="0.85"
                      max="1.25"
                      step="any"
                      value={entryFont.scale}
                      onChange={event => entryFont.changeScale(Number(event.target.value))}
                    />
                  </label>
                  {entryFont.hasCustomFont ? (
                    <button type="button" className="diary-font-reset-btn" onClick={() => entryFont.reset()}>
                      恢复默认
                    </button>
                  ) : null}
                </section>

                <section className="diary-settings-section">
                  <strong className="diary-settings-section-title">片刻纪事字体</strong>
                  <p className="diary-settings-hint">我的、角色的没上传就和系统字体一样</p>
                  <div className="moment-font-tiers">
                    {momentTiers.map(tier => (
                      <div key={tier.kind} className="moment-font-tier">
                        <span>
                          <strong>{tier.title}</strong>
                          <em>
                            {tier.custom ? "已上传" : tier.kind === "moment" ? "默认手写体" : "跟系统字体"} · {tier.hint}
                          </em>
                        </span>
                        <button type="button" onClick={() => uploadFont(tier.kind)}>上传</button>
                        {tier.custom ? (
                          <button type="button" onClick={() => fontHooks[tier.kind].reset()}>恢复</button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                  <label className="diary-font-size-control">
                    <span>
                      <strong>字号</strong>
                      <em>{Math.round(momentFont.scale * 100)}%</em>
                    </span>
                    <input
                      type="range"
                      min="0.85"
                      max="1.25"
                      step="any"
                      value={momentFont.scale}
                      onChange={event => momentFont.changeScale(Number(event.target.value))}
                    />
                  </label>
                </section>
              </>
            ) : null}

            {tab === "profile" ? (
              <section className="diary-settings-section">
                <p className="diary-settings-hint">
                  分享卡片上用的名字和头像。每个角色可以单独设，不填就用角色卡的名字。
                </p>
                <div className="moment-profile-list">
                  {/* 默认的「我」：某个角色没单独设时用它 */}
                  <div className="moment-profile-group">
                    <strong className="moment-profile-group-title">默认</strong>
                    <MomentProfileRow
                      label="我"
                      placeholder="不填就用当前账号名"
                      name={profiles.user.name}
                      avatar={avatars.user}
                      initial="我"
                      onName={name => saveProfiles({ ...profiles, user: { name } })}
                      onAvatar={file => void pickAvatar("user", file)}
                    />
                  </div>

                  {/* 每个角色一组：这一段的署名 + 我在这本里的署名 */}
                  {characters.map(character => (
                    <div key={character.id} className="moment-profile-group">
                      <strong className="moment-profile-group-title">{character.name}</strong>
                      <MomentProfileRow
                        label="角色署名"
                        placeholder={character.name}
                        name={profiles.characters[character.id]?.name ?? ""}
                        avatar={avatars[character.id]}
                        fallbackAvatar={character.avatar || undefined}
                        initial={Array.from(character.name)[0] || "?"}
                        onName={name => setCharacterName(character.id, name)}
                        onAvatar={file => void pickAvatar(character.id, file)}
                      />
                      <MomentProfileRow
                        label="我"
                        placeholder={profiles.user.name || "不填就用上面的默认"}
                        name={profiles.userByCharacter[character.id]?.name ?? ""}
                        avatar={avatars[momentUserOwner(character.id)]}
                        fallbackAvatar={avatars.user || character.avatar || undefined}
                        initial="我"
                        onName={name => setBookUserName(character.id, name)}
                        onAvatar={file => void pickAvatar(momentUserOwner(character.id), file)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </main>
    </section>
  );
}

function MomentProfileRow({ label, placeholder, name, avatar, fallbackAvatar, initial, onName, onAvatar }: {
  label: string;
  placeholder: string;
  name: string;
  /** 自己设的头像 */
  avatar?: string;
  /** 没设时显示的原头像 */
  fallbackAvatar?: string;
  initial: string;
  onName: (name: string) => void;
  onAvatar: (file: File | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const shown = avatar || fallbackAvatar;
  return (
    <div className="moment-profile-row">
      <button type="button" className="moment-profile-avatar" onClick={() => fileRef.current?.click()} aria-label={`更换${label}的头像`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {shown ? <img src={shown} alt="" /> : <span>{initial}</span>}
      </button>
      <label className="moment-profile-fields">
        <span>
          {label}
          {avatar ? (
            <button type="button" className="moment-profile-reset" onClick={(event) => { event.preventDefault(); onAvatar(null); }}>
              用回原头像
            </button>
          ) : null}
        </span>
        <input
          value={name}
          maxLength={40}
          placeholder={placeholder}
          onChange={event => onName(event.target.value)}
        />
      </label>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] || null;
          event.target.value = "";
          if (file) onAvatar(file);
        }}
      />
    </div>
  );
}
