"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type PointerEvent } from "react";
import { Bot, ChevronDown, ChevronLeft, ChevronRight, Clock3, Globe, NotebookPen, Trash2, UserRound, WandSparkles, X } from "lucide-react";
import { DotsThree } from "@phosphor-icons/react";

import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateDiaryEntryForCharacter } from "@/lib/diary-entry-engine";
import { useDiaryGenerating } from "@/lib/diary-generating-tracker";
import {
  DIARY_ENTRIES_UPDATED_EVENT,
  DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT,
} from "@/lib/diary-entry-timer-service";
import {
  clampDiaryIntervalHours,
  diaryCharacterIntervalHours,
  isDiaryCharacterScheduled,
  setDiaryCharacterScheduled,
  createDiaryEntry,
  deleteDiaryEntry,
  loadDiaryEntries,
  loadDiaryEntryTimerSettings,
  loadDiaryReplyRules,
  resolveDiaryReplyRule,
  saveDiaryEntryTimerSettings,
  saveDiaryReplyRules,
  updateDiaryEntry,
} from "@/lib/diary-entry-storage";
import type {
  DiaryEntry,
  DiaryEntryAuthorType,
  DiaryEntryBlock,
  DiaryEntryTimerSettings,
  DiaryEntryTrigger,
  DiaryEntryVisibility,
  DiaryReplyMode,
  DiaryReplyRules,
} from "@/lib/diary-entry-types";
import { cancelDiaryReply, scheduleDiaryReply } from "@/lib/diary-reply-service";
import { inheritedCharacterAppApiLabel, loadCharacterAppApiId } from "@/lib/app-api-binding";
import { loadApiConfigs, resolveUserIdentity } from "@/lib/settings-storage";
import type { UserIdentity } from "@/components/settings/user-identity";
import { AppApiPickerDialog } from "@/components/settings/app-api-picker-dialog";
import { useDiaryFont } from "./use-diary-font";
import { useDragToTrash } from "./use-drag-to-trash";

const DIARY_REPLY_MODE_LABELS: Record<DiaryReplyMode, string> = {
  none: "不回应",
  immediate: "立即回应",
  delay: "延时回应",
  merge: "和下次互动合并",
};

/** 手记首页的三个页签：日记=我写的、朋友=TA写的、通知=近期动态 */
type DiaryHubTab = "mine" | "friends" | "notices";

const DIARY_HUB_TABS: { id: DiaryHubTab; label: string }[] = [
  { id: "mine", label: "日记" },
  { id: "friends", label: "朋友" },
  { id: "notices", label: "通知" },
];

const DIARY_VISIBILITY_LABELS: Record<DiaryEntryVisibility, string> = {
  private: "私密",
  public: "公开",
  partial: "仅部分人可见",
};

function formatRelativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const diff = Date.now() - time;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatEntryTime(value);
}

/** 我写的日记卡片第二行：显示可见范围 */
function visibilitySummary(entry: DiaryEntry): string {
  const visibility = entry.visibility ?? "private";
  if (visibility === "public") return "公开";
  if (visibility === "partial") {
    const count = entry.visibleTo?.length ?? 0;
    return count > 0 ? `仅 ${count} 人可见` : "仅部分人可见";
  }
  return "私密";
}

function sortEntriesByTime(entries: DiaryEntry[]): DiaryEntry[] {
  return [...entries].sort((a, b) => {
    const timeA = new Date(a.createdAt).getTime();
    const timeB = new Date(b.createdAt).getTime();
    return (Number.isNaN(timeB) ? 0 : timeB) - (Number.isNaN(timeA) ? 0 : timeA);
  });
}

type DiaryEntriesAppProps = {
  /** "character" = TA的日记（角色自己写，AI 生成）；"user" = 我的日记（用户手写，给角色看） */
  kind: DiaryEntryAuthorType;
  onBack: () => void;
  onNotice?: (message: string) => void;
};

type DiaryBook = {
  characterId: string;
  characterName: string;
  avatar: string;
  entries: DiaryEntry[];
};

type ComposeTarget =
  /** authorType 决定这篇算「我写的」还是「TA 写的」——现在两个页签共用一个页面，不能只靠 kind */
  | { mode: "create"; characterId: string; authorType: DiaryEntryAuthorType }
  | { mode: "edit"; entry: DiaryEntry };

function formatEntryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "未知时间";
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function formatEntryDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "未知时间";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function blockPlainText(block: DiaryEntryBlock): string {
  if (block.type === "paragraph" || block.type === "quote") return block.text;
  if (block.type === "correction") return block.replacement || block.text;
  if (block.type === "image") return block.caption || block.description;
  if (block.type === "todo") return block.items.map(item => item.text).join(" / ");
  if (block.type === "bullet") return block.items.join(" / ");
  return "";
}

function getEntryMarkers(entry: DiaryEntry): string[] {
  return Array.from(new Set([
    entry.mood,
    ...entry.tags,
    entry.weather,
  ].map(item => item.trim()).filter(Boolean))).slice(0, 4);
}

function DiaryWritingStatus({ label = "写入中" }: { label?: string }) {
  return (
    <span className="diary-writing-status" aria-label={label}>
      <span>{label}</span>
      <span className="diary-writing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

export function DiaryEntriesApp({ kind, onBack, onNotice }: DiaryEntriesAppProps) {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [settings, setSettings] = useState<DiaryEntryTimerSettings>(() => loadDiaryEntryTimerSettings());
  const [replyRules, setReplyRules] = useState<DiaryReplyRules>(() => loadDiaryReplyRules());
  const [timerSettingsOpen, setTimerSettingsOpen] = useState(false);
  // 点进某个角色的日记本后，右上角只管这一本：它的定时和手记 API
  const [bookSettingsOpen, setBookSettingsOpen] = useState(false);
  const [replySettingsOpen, setReplySettingsOpen] = useState(false);
  const [writePanelOpen, setWritePanelOpen] = useState(false);
  const [composeTarget, setComposeTarget] = useState<ComposeTarget | null>(null);
  const [fontPanelOpen, setFontPanelOpen] = useState(false);
  const [activeEntry, setActiveEntry] = useState<DiaryEntry | null>(null);
  const [deleteCandidateEntry, setDeleteCandidateEntry] = useState<DiaryEntry | null>(null);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [localGeneratingIds, setGeneratingCharacterIds] = useState<string[]>([]);
  // Merge in the module-level tracker so background generation (timer, or a
  // batch started before leaving the app) is visible again after re-entry.
  const trackedGeneratingIds = useDiaryGenerating();
  const generatingCharacterIds = useMemo(
    () => Array.from(new Set([...localGeneratingIds, ...trackedGeneratingIds])),
    [localGeneratingIds, trackedGeneratingIds],
  );
  // 只滚日记列表这一块（工具条固定在页签下边线以上）
  const entryMainRef = useRef<HTMLDivElement | null>(null);
  const fontFileRef = useRef<HTMLInputElement | null>(null);
  // 手记首页三页签：日记（我写的）/ 朋友（TA写的）/ 通知（近期动态）
  const [tab, setTab] = useState<DiaryHubTab>("mine");
  const [userIdentity, setUserIdentity] = useState<UserIdentity | null>(null);
  // 页签上方那张发布卡片
  const [publishTitle, setPublishTitle] = useState("");
  const [publishBody, setPublishBody] = useState("");
  const [publishVisibility, setPublishVisibility] = useState<DiaryEntryVisibility>("private");
  const [publishVisibleTo, setPublishVisibleTo] = useState<string[]>([]);
  const [permissionOpen, setPermissionOpen] = useState(false);
  // 标题输入行默认收起，点正文/输入后才展开
  const [composeTitleOpen, setComposeTitleOpen] = useState(false);

  const notify = useCallback((message: string) => {
    onNotice?.(message);
  }, [onNotice]);

  const font = useDiaryFont(kind, notify);
  const trash = useDragToTrash<DiaryEntry>({
    enabled: Boolean(activeCharacterId),
    scrollRef: entryMainRef,
    onDrop: setDeleteCandidateEntry,
  });

  const refreshEntries = useCallback(() => {
    setEntries(loadDiaryEntries());
  }, []);

  const deleteEntry = useCallback((entry: DiaryEntry) => {
    deleteDiaryEntry(entry.id);
    cancelDiaryReply(entry.id);
    setActiveEntry(current => current?.id === entry.id ? null : current);
    setDeleteCandidateEntry(current => current?.id === entry.id ? null : current);
    refreshEntries();
    notify(`已删除${entry.authorType === "user" ? "" : ` ${entry.characterName}`}的日记。`);
  }, [notify, refreshEntries]);

  useEffect(() => {
    setCharacters(loadCharacters());
    refreshEntries();
    // 发布卡片左上角那个 26×26 头像跟着「当前账号」走
    const syncIdentity = () => setUserIdentity(resolveUserIdentity(undefined, "diary"));
    syncIdentity();
    window.addEventListener("settings-identities-updated", syncIdentity);
    return () => window.removeEventListener("settings-identities-updated", syncIdentity);
  }, [refreshEntries]);

  useEffect(() => {
    saveDiaryEntryTimerSettings(settings);
    window.dispatchEvent(new CustomEvent(DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT));
  }, [settings]);

  useEffect(() => {
    saveDiaryReplyRules(replyRules);
  }, [replyRules]);

  useEffect(() => {
    const handleEntriesUpdated = () => {
      refreshEntries();
      setSettings(loadDiaryEntryTimerSettings());
    };
    window.addEventListener(DIARY_ENTRIES_UPDATED_EVENT, handleEntriesUpdated);
    return () => window.removeEventListener(DIARY_ENTRIES_UPDATED_EVENT, handleEntriesUpdated);
  }, [refreshEntries]);

  const resolveTargets = useCallback((characterIds: string[]): Character[] => {
    const stored = loadCharacters();
    const uniqueIds = Array.from(new Set(characterIds.filter(Boolean)));
    return uniqueIds
      .map(characterId => characters.find(item => item.id === characterId) ?? stored.find(item => item.id === characterId))
      .filter(Boolean) as Character[];
  }, [characters]);

  const generateForCharacters = useCallback(async (characterIds: string[], trigger: DiaryEntryTrigger = "manual") => {
    const targets = resolveTargets(characterIds);
    if (targets.length === 0) {
      notify("找不到角色。");
      return;
    }

    const targetIds = targets.map(character => character.id);
    setGeneratingCharacterIds(prev => Array.from(new Set([...prev, ...targetIds])));
    try {
      const baseEntries = loadDiaryEntries();
      const results = await Promise.all(targets.map(async character => {
        try {
          return {
            status: "fulfilled" as const,
            character,
            draft: await generateDiaryEntryForCharacter(character.id, baseEntries, trigger),
          };
        } catch {
          return { status: "rejected" as const, character };
        }
      }));

      const createdEntries: DiaryEntry[] = [];
      const failedNames: string[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          failedNames.push(result.character.name);
          continue;
        }
        try {
          createdEntries.push(createDiaryEntry({
            characterId: result.character.id,
            characterName: result.character.name,
            title: result.draft.title,
            mood: result.draft.mood,
            weather: result.draft.weather,
            tags: result.draft.tags,
            body: result.draft.body,
            blocks: result.draft.blocks,
            trigger,
          }));
        } catch {
          failedNames.push(result.character.name);
        }
      }

      refreshEntries();
      if (createdEntries.length === 1 && failedNames.length === 0) {
        notify(`${createdEntries[0].characterName} 写了一篇日记。`);
      } else if (createdEntries.length > 0) {
        notify(`已生成 ${createdEntries.length} 篇日记${failedNames.length ? `，${failedNames.length} 个失败` : ""}。`);
      } else {
        notify(failedNames.length ? `日记生成失败：${failedNames.join("、")}` : "日记生成失败。");
      }
    } finally {
      setGeneratingCharacterIds(prev => prev.filter(id => !targetIds.includes(id)));
    }
  }, [notify, refreshEntries, resolveTargets]);

  const saveComposeEntry = useCallback((input: {
    characterId: string;
    authorType?: DiaryEntryAuthorType;
    title: string;
    mood: string;
    weather: string;
    tags: string[];
    signature: string;
    blocks: DiaryEntryBlock[];
  }, editingId?: string) => {
    // 表单传来的 authorType 优先（首页两个页签共用一套表单），兜底才用 kind
    const authorType = input.authorType ?? kind;
    // body 是给"近期日记"这类只读纯文本上下文用的摊平版本；用 blockPlainText 而不是只拼
    // paragraph/quote，这样 correction/todo/image 这些板块的内容也不会在摊平时丢掉。
    const body = input.blocks.map(blockPlainText).filter(Boolean).join("\n\n");
    if (!editingId) {
      const character = resolveTargets([input.characterId])[0];
      const created = createDiaryEntry({
        characterId: input.characterId,
        characterName: character?.name ?? "角色",
        authorType,
        title: input.title,
        mood: input.mood,
        weather: input.weather,
        tags: input.tags,
        // 用户写的日记署名是自己（没填就用当前账号名）
        signature: input.signature || (authorType === "user" ? (userIdentity?.name ?? "我") : ""),
        body,
        blocks: input.blocks,
        trigger: "manual",
      });
      refreshEntries();
      setComposeTarget(null);
      if (created.authorType === "user") scheduleDiaryReply(created);
      setTab("mine");
      notify("日记已保存。");
      return;
    }
    const updated = updateDiaryEntry(editingId, {
      title: input.title,
      mood: input.mood,
      weather: input.weather,
      tags: input.tags,
      signature: input.signature,
      body,
      blocks: input.blocks,
    });
    refreshEntries();
    setComposeTarget(null);
    if (updated) setActiveEntry(current => (current && current.id === updated.id ? updated : current));
    notify("日记已更新。");
  }, [kind, notify, refreshEntries, resolveTargets, userIdentity]);

  /** 顶部发布卡片的「发送」：直接写一篇「我的」日记，不再走选择角色的弹窗 */
  const publishEntry = useCallback(() => {
    const body = publishBody.trim();
    const title = publishTitle.trim();
    if (!body && !title) {
      notify("先写点什么再发送。");
      return;
    }
    // 日记条目必须有归属角色（存储层会把没有 characterId 的条目丢掉），取列表第一位兜底
    const target = characters[0];
    if (!target) {
      notify("还没有角色，先在手机里创建一位角色。");
      return;
    }
    const created = createDiaryEntry({
      characterId: target.id,
      characterName: target.name,
      authorType: "user",
      title,
      body,
      blocks: body ? [{ type: "paragraph", text: body }] : [],
      visibility: publishVisibility,
      visibleTo: publishVisibility === "partial" ? publishVisibleTo : [],
      trigger: "manual",
    });
    setPublishTitle("");
    setPublishBody("");
    setPublishVisibility("private");
    setPublishVisibleTo([]);
    setPermissionOpen(false);
    setComposeTitleOpen(false);
    setTab("mine");
    refreshEntries();
    scheduleDiaryReply(created);
    notify("日记已发布。");
  }, [
    characters,
    notify,
    publishBody,
    publishTitle,
    publishVisibility,
    publishVisibleTo,
    refreshEntries,
  ]);

  /** 写日记：不再弹「写给谁」，署名和可见范围都在发布卡片/表单里定，这里只借第一位角色做条目归属 */
  const openUserCompose = useCallback(() => {
    const target = characters[0];
    if (!target) {
      notify("还没有角色，先在手机里创建一位角色。");
      return;
    }
    setComposeTarget({ mode: "create", characterId: target.id, authorType: "user" });
  }, [characters, notify]);

  const togglePublishVisibleTo = useCallback((characterId: string) => {
    setPublishVisibleTo(prev => prev.includes(characterId)
      ? prev.filter(id => id !== characterId)
      : [...prev, characterId]);
  }, []);

  const kindEntries = useMemo(() => entries.filter(entry => entry.authorType === kind), [entries, kind]);

  const sortedKindEntries = useMemo(() => sortEntriesByTime(kindEntries), [kindEntries]);

  /** 「日记」页签：我写的；「朋友」页签：TA 写的 */
  const mySortedEntries = useMemo(
    () => sortEntriesByTime(entries.filter(entry => entry.authorType === "user")),
    [entries],
  );
  const friendSortedEntries = useMemo(
    () => sortEntriesByTime(entries.filter(entry => entry.authorType === "character")),
    [entries],
  );

  const books = useMemo<DiaryBook[]>(() => {
    const map = new Map<string, DiaryEntry[]>();
    for (const entry of sortedKindEntries) {
      const list = map.get(entry.characterId);
      if (list) list.push(entry);
      else map.set(entry.characterId, [entry]);
    }
    return Array.from(map.entries()).map(([characterId, characterEntries]) => ({
      characterId,
      characterName: characterEntries[0].characterName,
      avatar: characters.find(character => character.id === characterId)?.avatar ?? "",
      entries: characterEntries,
    }));
  }, [sortedKindEntries, characters]);

  const activeBook = useMemo(
    () => (activeCharacterId ? books.find(book => book.characterId === activeCharacterId) ?? null : null),
    [activeCharacterId, books],
  );

  return (
    <section className={`diary-app diary-entry-app ${trash.drag ? "is-entry-dragging" : ""}`} style={font.style}>
      {generatingCharacterIds.length > 0 && (
        <div className="diary-generating-toast" role="status">
          <span className="diary-generating-toast-spinner" aria-hidden="true" />
          正在生成日记{generatingCharacterIds.length > 1 ? `（${generatingCharacterIds.length} 篇）` : ""}…
        </div>
      )}
      <header className="diary-app-header diary-entry-header">
        <button
          type="button"
          className="diary-icon-btn"
          onClick={() => (kind === "user" && activeBook ? setActiveCharacterId(null) : onBack())}
          aria-label="返回"
        >
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>手记</h1>
        </div>
        <input
          ref={fontFileRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2,font/*,application/font-woff,application/font-woff2"
          className="hidden"
          onChange={font.upload}
        />
        <span className="diary-entry-header-actions">
          <button
            type="button"
            className="note-wall-menu-btn diary-font-upload-btn"
            onClick={() => setFontPanelOpen(true)}
            aria-label="日记字体设置"
            title="日记字体设置"
          >
            <span className="diary-font-upload-mark" aria-hidden="true">Aa</span>
          </button>
          <button
            type="button"
            className="note-wall-menu-btn"
            onClick={() => {
              // 「日记」页签管我写的日记怎么被回应；「朋友」页签管TA什么时候写、用哪个 API
              if (tab === "mine") setReplySettingsOpen(true);
              else if (activeBook) setBookSettingsOpen(true);
              else setTimerSettingsOpen(true);
            }}
            aria-label={tab === "mine" ? "聊天回应设置" : "日记设置"}
          >
            <DotsThree size={28} weight="bold" />
          </button>
        </span>
      </header>

      <main className="diary-entry-main">
        {/* 不参与滚动的工具条：输入卡片 + 按钮行 + 三个页签 */}
        <div className="diary-hub-toolbar">
          {/* 输入卡片：上边线贴在顶部栏下框线上；头像常驻，标题行点正文后才展开 */}
          <section
            className={`diary-hub-compose ${composeTitleOpen ? "is-expanded" : "is-collapsed"}`}
            onFocusCapture={() => setComposeTitleOpen(true)}
            onClick={() => setComposeTitleOpen(true)}
          >
            <span className="diary-hub-compose-avatar" aria-hidden="true">
              {userIdentity?.avatarUrl ? <img src={userIdentity.avatarUrl} alt="" /> : <UserRound size={14} />}
            </span>
            {composeTitleOpen ? (
              <>
                <input
                  type="text"
                  className="diary-hub-compose-title"
                  value={publishTitle}
                  onChange={event => setPublishTitle(event.target.value)}
                  placeholder="标题"
                  maxLength={80}
                  aria-label="日记标题"
                />
                <div className="diary-hub-compose-divider" aria-hidden="true" />
              </>
            ) : null}
            <textarea
              className="diary-hub-compose-body"
              value={publishBody}
              onChange={event => setPublishBody(event.target.value)}
              placeholder="写点什么…"
              rows={composeTitleOpen ? 4 : 1}
              aria-label="日记正文"
            />

            {/* 权限 + 发送：属于这张输入卡片的一部分，靠右一行（点按钮不触发展开标题） */}
            <div className="diary-hub-compose-actions" onClick={event => event.stopPropagation()}>
              <div className="diary-hub-permission">
                <button
                  type="button"
                  className="diary-hub-permission-btn"
                  onClick={() => setPermissionOpen(open => !open)}
                  aria-haspopup="true"
                  aria-expanded={permissionOpen}
                >
                  {DIARY_VISIBILITY_LABELS[publishVisibility]}
                  <ChevronDown size={12} />
                </button>
                {permissionOpen ? (
                  <>
                    <div className="diary-hub-permission-backdrop" onClick={() => setPermissionOpen(false)} />
                    <div className="diary-hub-permission-menu" role="menu">
                      {(Object.keys(DIARY_VISIBILITY_LABELS) as DiaryEntryVisibility[]).map(mode => (
                        <button
                          key={mode}
                          type="button"
                          role="menuitemradio"
                          aria-checked={publishVisibility === mode}
                          className={publishVisibility === mode ? "is-active" : ""}
                          onClick={() => {
                            setPublishVisibility(mode);
                            if (mode !== "partial") setPermissionOpen(false);
                          }}
                        >
                          {DIARY_VISIBILITY_LABELS[mode]}
                        </button>
                      ))}
                      {publishVisibility === "partial" ? (
                        <div className="diary-hub-permission-people">
                          {characters.length === 0 ? (
                            <p>暂无角色可选</p>
                          ) : characters.map(character => (
                            <label key={character.id}>
                              <input
                                type="checkbox"
                                checked={publishVisibleTo.includes(character.id)}
                                onChange={() => togglePublishVisibleTo(character.id)}
                              />
                              <span>{character.name}</span>
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
              <button
                type="button"
                className="diary-hub-send-btn"
                onClick={publishEntry}
                disabled={!publishTitle.trim() && !publishBody.trim()}
              >
                发送
              </button>
            </div>
          </section>

          {/* 三个页签：日记 / 朋友 / 通知，等分宽度，选中变蓝 */}
          <div className="diary-hub-tabs" role="tablist" aria-label="手记分类">
            {DIARY_HUB_TABS.map(item => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={`diary-hub-tab ${tab === item.id ? "is-active" : ""}`}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {/* 只有这一块滚动：起点就是三个页签的下边线 */}
        <div ref={entryMainRef} className="diary-hub-scroll">
          {tab === "notices" ? (
            <DiaryHubNoticeList entries={entries} characters={characters} userIdentity={userIdentity} />
          ) : null}

          {tab !== "notices" && (tab === "mine" ? mySortedEntries : friendSortedEntries).length === 0 ? (
            <div className="diary-entry-empty">
              <NotebookPen size={34} strokeWidth={1.5} />
              <h2>{tab === "mine" ? "还没有日记" : "还没有TA的日记"}</h2>
              <p>{tab === "mine" ? "在上面写一句，或者点右下角写下第一篇。" : "让角色先写一篇，纸面会从这里开始铺开。"}</p>
              <button type="button" onClick={() => (tab === "mine" ? openUserCompose() : setWritePanelOpen(true))}>
                {tab === "mine" ? "写下第一篇" : "让TA写一篇"}
              </button>
            </div>
          ) : null}

          {tab !== "notices"
            ? (tab === "mine" ? mySortedEntries : friendSortedEntries).map(entry => (
              <DiaryEntryCard
                key={entry.id}
                entry={entry}
                character={characters.find(c => c.id === entry.characterId)}
                userIdentity={userIdentity}
                isDragSource={trash.drag?.item.id === entry.id}
                onPointerDown={(event) => trash.onPointerDown(event, entry)}
                onPointerMove={trash.onPointerMove}
                onPointerUp={trash.onPointerUp}
                onPointerCancel={trash.onPointerCancel}
                onPointerLeave={trash.onPointerLeave}
                onClick={(event) => {
                  event.stopPropagation();
                  if (trash.isClickSuppressed()) {
                    event.preventDefault();
                    return;
                  }
                  setActiveEntry(entry);
                }}
              />
            ))
            : null}
        </div>
      </main>

      {tab === "mine" ? (
        <button
          type="button"
          className="diary-entry-write-btn"
          onClick={openUserCompose}
        >
          <NotebookPen size={18} strokeWidth={1.7} />
          <span>写日记</span>
        </button>
      ) : tab === "friends" ? (
        <button type="button" className="diary-entry-write-btn" onClick={() => setWritePanelOpen(true)}>
          <WandSparkles size={18} strokeWidth={1.7} />
          <span>让TA写</span>
        </button>
      ) : null}

      {bookSettingsOpen && activeBook && kind === "character" ? (
        <DiaryBookSettingsPanel
          characterId={activeBook.characterId}
          characterName={activeBook.characterName}
          characters={characters}
          settings={settings}
          onChange={setSettings}
          onClose={() => setBookSettingsOpen(false)}
        />
      ) : null}

      {timerSettingsOpen ? (
        <DiaryEntryTimerSettingsPanel
          characters={characters}
          settings={settings}
          generatingCharacterIds={generatingCharacterIds}
          onChange={setSettings}
          onClose={() => setTimerSettingsOpen(false)}
        />
      ) : null}

      {replySettingsOpen ? (
        <DiaryReplySettingsPanel
          characters={characters}
          rules={replyRules}
          onChange={setReplyRules}
          onClose={() => setReplySettingsOpen(false)}
        />
      ) : null}

      {writePanelOpen ? (
        <DiaryEntryWritePanel
          characters={characters}
          generatingCharacterIds={generatingCharacterIds}
          onGenerateMany={generateForCharacters}
          onClose={() => setWritePanelOpen(false)}
        />
      ) : null}

      {composeTarget ? (
        <DiaryEntryComposeForm
          target={composeTarget}
          characters={characters}
          defaultSignature={userIdentity?.name || "我"}
          onSave={saveComposeEntry}
          onClose={() => setComposeTarget(null)}
        />
      ) : null}

      {fontPanelOpen ? (
        <DiaryEntryFontPanel
          hasCustomFont={font.hasCustomFont}
          scale={font.scale}
          onUpload={() => fontFileRef.current?.click()}
          onScaleChange={font.changeScale}
          onReset={font.reset}
          onClose={() => setFontPanelOpen(false)}
        />
      ) : null}

      {activeEntry ? (
        <DiaryEntryDetail
          entry={activeEntry}
          userIdentity={userIdentity}
          onClose={() => setActiveEntry(null)}
          onEdit={() => { setComposeTarget({ mode: "edit", entry: activeEntry }); setActiveEntry(null); }}
          onDelete={() => {
            const entryToDelete = activeEntry;
            setActiveEntry(null);
            setDeleteCandidateEntry(entryToDelete);
          }}
        />
      ) : null}

      {deleteCandidateEntry ? (
        <div
          className="nw-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="diary-entry-delete-title"
          onClick={() => setDeleteCandidateEntry(null)}
        >
          <section className="nw-delete-confirm" onClick={event => event.stopPropagation()}>
            <div className="nw-delete-confirm-icon">
              <Trash2 size={24} strokeWidth={1.8} />
            </div>
            <h2 id="diary-entry-delete-title">删除日记</h2>
            <p>这篇日记会被删除，对应的短期记忆事件也会消失。</p>
            <div>
              <button type="button" className="nw-secondary-btn" onClick={() => setDeleteCandidateEntry(null)}>取消</button>
              <button type="button" className="nw-danger-btn" onClick={() => deleteEntry(deleteCandidateEntry)}>
                <span className="note-wall-primary-content">
                  <span>删除</span>
                </span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <div
        ref={trash.trashRef}
        className={`diary-entry-trash-bin ${trash.drag ? "is-visible" : ""} ${trash.drag?.isOverTrash ? "is-over" : ""}`}
        aria-hidden={!trash.drag}
      >
        <Trash2 size={30} strokeWidth={1.8} />
      </div>

      {trash.drag ? (
        <div
          className="diary-flat-card diary-entry-drag-ghost"
          style={{
            left: trash.drag.x,
            top: trash.drag.y,
            width: trash.drag.width,
            minHeight: trash.drag.height,
          }}
        >
          <DiaryEntryCardContent
            entry={trash.drag.item}
            character={characters.find(c => c.id === trash.drag?.item.characterId)}
            userIdentity={userIdentity}
          />
        </div>
      ) : null}
    </section>
  );
}

function DiaryEntryCardContent({ entry, character, userIdentity }: {
  entry: DiaryEntry;
  character?: Character;
  userIdentity?: Pick<UserIdentity, "name" | "avatarUrl"> | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const preview = useMemo(() => {
    // 过滤掉日程相关内容（待办/清单类 todo、bullet 等做某事相关板块）
    const filteredBlocks = entry.blocks.filter(b => b.type !== "todo" && b.type !== "bullet");
    const fromBlocks = filteredBlocks.map(blockPlainText).filter(Boolean).join("\n");
    if (fromBlocks) return fromBlocks;
    // 如果没有 blocks 或直接读取 body，过滤常见的待办/日程清单行（如以 - [ ] 或 待办: 等开头的行）
    return (entry.body || "")
      .split("\n")
      .filter(line => !/^\s*(-\s*\[[ xX]\]|待办|日程|清单|TODO|todo|[0-9]+[、.][\s]*待办)/.test(line))
      .join("\n")
      .trim();
  }, [entry.blocks, entry.body]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // 检查在 6 行限制下是否产生溢出
    if (el.scrollHeight > el.clientHeight + 1) {
      setCanExpand(true);
    }
  }, [preview]);

  const isMine = entry.authorType === "user";
  // 我写的日记：作者名/头像跟「当前账号」走，第二行换成可见范围；TA 的日记照旧显示 @手机号
  const phone = character?.wechatID || character?.id || "";
  const authorName = isMine ? (userIdentity?.name || "我") : entry.characterName;
  const avatar = isMine ? (userIdentity?.avatarUrl || "") : (character?.avatar || "");
  const subline = isMine ? visibilitySummary(entry) : `@${phone}`;

  return (
    <div className="diary-flat-card-inner">
      {/* 第一行最左侧是32*32px的角色圆形头像，右侧第一行角色名（黑），第二行小一号字ID（@手机号） */}
      <div className="diary-flat-card-author-row">
        <div className="diary-flat-card-avatar">
          {avatar ? <img src={avatar} alt={authorName} /> : isMine ? <UserRound size={17} /> : <Bot size={18} />}
        </div>
        <div className="diary-flat-card-author-info">
          <span className="diary-flat-card-author-name">{authorName}</span>
          <span className="diary-flat-card-author-id">{subline}</span>
        </div>
      </div>

      {/* 日记正文：去掉卡片条目标题，只显示正文，字体颜色为黑（#252525）。展开/收起按钮直接跟在文本后 */}
      <div
        ref={bodyRef}
        className={`diary-flat-card-body ${!isExpanded ? "is-clamped" : ""}`}
      >
        <span>{preview}</span>
        {canExpand && (
          <button
            type="button"
            className="diary-flat-card-expand-inline-btn"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
          >
            {isExpanded ? "收起" : "展开"}
          </button>
        )}
      </div>

      {/* 最后一行最左侧为小字“🕓 YYYY-MM-DD hh:mm”，字体颜色为灰色，其中“🕓”采用SVG图标，图标与角色头像左侧对齐 */}
      <div className="diary-flat-card-footer">
        <Clock3 size={13} className="diary-flat-clock-svg" aria-hidden="true" />
        <time className="diary-flat-card-time">{formatEntryDateTime(entry.createdAt)}</time>
      </div>
    </div>
  );
}

function DiaryEntryCard({
  entry,
  character,
  userIdentity,
  isDragSource,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
}: {
  entry: DiaryEntry;
  character?: Character;
  userIdentity?: Pick<UserIdentity, "name" | "avatarUrl"> | null;
  isDragSource: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`diary-flat-card ${isDragSource ? "is-drag-source" : ""}`}
      draggable={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={event => event.preventDefault()}
      onClick={onClick}
    >
      <DiaryEntryCardContent entry={entry} character={character} userIdentity={userIdentity} />
    </button>
  );
}

type DiaryNotice = {
  id: string;
  text: string;
  time: string;
  isMine: boolean;
  characterId: string;
};

/** 「通知」页签：把最近的日记动态摊成一条条通知（谁发布了/更新了日记） */
function buildDiaryNotices(entries: DiaryEntry[]): DiaryNotice[] {
  return [...entries]
    .sort((a, b) => {
      const timeA = new Date(a.updatedAt || a.createdAt).getTime();
      const timeB = new Date(b.updatedAt || b.createdAt).getTime();
      return (Number.isNaN(timeB) ? 0 : timeB) - (Number.isNaN(timeA) ? 0 : timeA);
    })
    .slice(0, 60)
    .map(entry => {
      const mine = entry.authorType === "user";
      const who = mine ? "你" : entry.characterName;
      const edited = Boolean(entry.updatedAt && entry.createdAt && entry.updatedAt !== entry.createdAt);
      return {
        id: entry.id,
        text: `${who}${edited ? "更新了" : "发布了"}一则日记${entry.title ? `：《${entry.title}》` : ""}`,
        time: entry.updatedAt || entry.createdAt,
        isMine: mine,
        characterId: entry.characterId,
      };
    });
}

function DiaryHubNoticeList({ entries, characters, userIdentity }: {
  entries: DiaryEntry[];
  characters: Character[];
  userIdentity: UserIdentity | null;
}) {
  const notices = useMemo(() => buildDiaryNotices(entries), [entries]);

  if (notices.length === 0) {
    return (
      <div className="diary-entry-empty">
        <Clock3 size={32} strokeWidth={1.5} />
        <h2>还没有动态</h2>
        <p>有人写了日记，这里会出现记录。</p>
      </div>
    );
  }

  return (
    <ul className="diary-hub-notice-list">
      {notices.map(notice => {
        const character = characters.find(item => item.id === notice.characterId);
        const avatar = notice.isMine ? (userIdentity?.avatarUrl || "") : (character?.avatar || "");
        return (
          <li key={notice.id} className="diary-hub-notice">
            <span className="diary-hub-notice-avatar" aria-hidden="true">
              {avatar ? <img src={avatar} alt="" /> : notice.isMine ? <UserRound size={15} /> : <Bot size={15} />}
            </span>
            <span className="diary-hub-notice-text">{notice.text}</span>
            <time className="diary-hub-notice-time">{formatRelativeTime(notice.time)}</time>
          </li>
        );
      })}
    </ul>
  );
}

export function DiaryEntryFontPanel({
  title = "日记字体",
  hasCustomFont,
  scale,
  onUpload,
  onScaleChange,
  onReset,
  onClose,
}: {
  title?: string;
  hasCustomFont: boolean;
  scale: number;
  onUpload: () => void;
  onScaleChange: (scale: number) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-font-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>{title}</h2>
            <p>{hasCustomFont ? "已使用自定义字体" : "当前使用默认手写字体"}</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <button type="button" className="diary-font-upload-action" onClick={onUpload}>
          <span className="diary-font-upload-mark" aria-hidden="true">Aa</span>
          <span>上传字体</span>
        </button>

        <label className="diary-font-size-control">
          <span>
            <strong>字号</strong>
            <em>{Math.round(scale * 100)}%</em>
          </span>
          <input
            type="range"
            min="0.85"
            max="1.25"
            step="any"
            value={scale}
            onChange={event => onScaleChange(Number(event.target.value))}
          />
        </label>

        <button type="button" className="diary-font-reset-btn" onClick={onReset}>
          恢复默认
        </button>
      </section>
    </div>
  );
}

/** TA的日记 → 某个角色的日记本 → 右上角：只管这一本的定时写日记和手记 API */
function DiaryBookSettingsPanel({ characterId, characterName, characters, settings, onChange, onClose }: {
  characterId: string;
  characterName: string;
  characters: Character[];
  settings: DiaryEntryTimerSettings;
  onChange: (settings: DiaryEntryTimerSettings) => void;
  onClose: () => void;
}) {
  const [apiPickerOpen, setApiPickerOpen] = useState(false);
  const [apiRevision, setApiRevision] = useState(0);
  // 和设置 → 绑定里这个角色的「日记」API 是同一份
  const apiLabel = useMemo(() => {
    void apiRevision;
    const ownId = loadCharacterAppApiId(characterId, "diary");
    const own = ownId ? loadApiConfigs().find(config => config.id === ownId) : undefined;
    return own ? own.name || own.provider : inheritedCharacterAppApiLabel(characterId, "diary");
  }, [characterId, apiRevision]);

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings" onClick={event => event.stopPropagation()}>
        <header>
          <h2>{characterName} 的日记</h2>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="diary-entry-setting-grid">
          <label className="diary-entry-toggle-row">
            <span>
              <Clock3 size={17} />
              定时写日记
            </span>
            <input
              type="checkbox"
              checked={isDiaryCharacterScheduled(settings, characterId)}
              onChange={event => onChange(setDiaryCharacterScheduled(
                settings,
                characterId,
                event.target.checked,
                characters.map(character => character.id),
              ))}
            />
          </label>
          <label className="diary-entry-number-field">
            <span>间隔小时</span>
            <input
              type="number"
              min={1}
              max={720}
              value={diaryCharacterIntervalHours(settings, characterId)}
              onChange={event => onChange({
                ...settings,
                intervalHoursByCharacter: {
                  ...settings.intervalHoursByCharacter,
                  [characterId]: clampDiaryIntervalHours(event.target.value),
                },
              })}
            />
          </label>
          <button type="button" className="diary-entry-toggle-row diary-entry-api-row" onClick={() => setApiPickerOpen(true)}>
            <span>
              <Globe size={17} />
              手记 API
            </span>
            <span className="diary-entry-api-value">
              <em>{apiLabel}</em>
              <ChevronRight size={16} />
            </span>
          </button>
        </div>
      </section>
      {apiPickerOpen ? (
        <div onClick={event => event.stopPropagation()}>
          <AppApiPickerDialog
            characterId={characterId}
            appId="diary"
            title="选择手记 API"
            onClose={() => {
              setApiPickerOpen(false);
              setApiRevision(value => value + 1);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function DiaryEntryTimerSettingsPanel({ characters, settings, generatingCharacterIds, onChange, onClose }: {
  characters: Character[];
  settings: DiaryEntryTimerSettings;
  generatingCharacterIds: string[];
  onChange: (settings: DiaryEntryTimerSettings) => void;
  onClose: () => void;
}) {
  const busy = generatingCharacterIds.length > 0;

  const toggleTimerCharacter = (characterId: string) => {
    onChange({
      ...settings,
      characterIds: settings.characterIds.includes(characterId)
        ? settings.characterIds.filter(id => id !== characterId)
        : [...settings.characterIds, characterId],
    });
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>定时写日记</h2>
            <p>默认一天一次；未选择角色时，会按全部角色处理。</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="diary-entry-setting-grid">
          <label className="diary-entry-toggle-row">
            <span>
              <Clock3 size={17} />
              定时写日记
            </span>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={event => onChange({ ...settings, enabled: event.target.checked })}
            />
          </label>
          <label className="diary-entry-number-field">
            <span>间隔小时</span>
            <input
              type="number"
              min={1}
              max={720}
              value={settings.intervalHours}
              onChange={event => onChange({ ...settings, intervalHours: Math.max(1, Math.min(720, Number(event.target.value) || 24)) })}
            />
          </label>
        </div>

        <section className="diary-entry-character-section">
          <div className="diary-entry-section-title">
            <strong>定时角色</strong>
            <span>{settings.characterIds.length ? `已选 ${settings.characterIds.length} 个` : "默认全部"}</span>
          </div>
          <CharacterAvatarGrid
            characters={characters}
            selectedIds={settings.characterIds}
            busyIds={generatingCharacterIds}
            disabled={busy}
            onToggle={toggleTimerCharacter}
          />
        </section>
      </section>
    </div>
  );
}

const DIARY_REPLY_MODE_OPTIONS: DiaryReplyMode[] = ["none", "immediate", "delay", "merge"];

function DiaryReplySettingsPanel({ characters, rules, onChange, onClose }: {
  characters: Character[];
  rules: DiaryReplyRules;
  onChange: (rules: DiaryReplyRules) => void;
  onClose: () => void;
}) {
  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>TA如何在聊天中回应</h2>
            <p>写完日记后，TA 会从聊天 App 发普通消息回应；可统一设置，也可以为每个角色单独指定。</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="diary-entry-setting-grid">
          <label
            className="diary-entry-toggle-row"
            style={rules.default.mode !== "delay" ? { gridColumn: "1 / -1" } : undefined}
          >
            <span>默认回应方式</span>
            <select
              value={rules.default.mode}
              onChange={event => onChange({ ...rules, default: { ...rules.default, mode: event.target.value as DiaryReplyMode } })}
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
                onChange={event => onChange({ ...rules, default: { ...rules.default, delayHours: Math.max(0.05, Math.min(720, Number(event.target.value) || 24)) } })}
              />
            </label>
          ) : null}
        </div>

        <section className="diary-entry-character-section">
          <div className="diary-entry-section-title">
            <strong>按角色单独设置</strong>
          </div>
          <div className="diary-reply-rule-list">
            {characters.map(character => {
              const own = rules.characters[character.id] ?? { mode: "inherit" as const, delayHours: rules.default.delayHours };
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
                      const nextCharacters = { ...rules.characters, [character.id]: { mode, delayHours: own.delayHours } };
                      onChange({ ...rules, characters: nextCharacters });
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
                        const delayHours = Math.max(0.05, Math.min(720, Number(event.target.value) || rules.default.delayHours));
                        onChange({ ...rules, characters: { ...rules.characters, [character.id]: { mode: own.mode, delayHours } } });
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
        <p className="diary-entry-note">「和下次互动合并」不会主动发起新对话，只在你们下次真的开口聊天时顺带带出这篇日记；默认设为「不回应」，避免未经确认产生 API 调用。</p>
      </section>
    </div>
  );
}

type DraftBlock = { localId: string } & DiaryEntryBlock;

function makeLocalId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toDraftBlocks(blocks: DiaryEntryBlock[]): DraftBlock[] {
  return blocks.map(block => ({ localId: makeLocalId(), ...block }));
}

function stripDraftBlocks(blocks: DraftBlock[]): DiaryEntryBlock[] {
  return blocks.map(({ localId: _localId, ...block }) => block as DiaryEntryBlock);
}

function makeEmptyBlock(type: DiaryEntryBlock["type"]): DraftBlock {
  const localId = makeLocalId();
  if (type === "quote") return { localId, type, text: "" };
  if (type === "correction") return { localId, type, text: "", replacement: "" };
  if (type === "todo") return { localId, type, title: "", items: [] };
  if (type === "bullet") return { localId, type, title: "", items: [] };
  if (type === "image") return { localId, type, caption: "", description: "" };
  return { localId, type: "paragraph", text: "" };
}

function draftBlockHasContent(block: DiaryEntryBlock): boolean {
  if (block.type === "paragraph" || block.type === "quote") return block.text.trim().length > 0;
  if (block.type === "correction") return block.text.trim().length > 0 || (block.replacement ?? "").trim().length > 0;
  if (block.type === "image") return block.description.trim().length > 0;
  if (block.type === "todo") return block.items.some(item => item.text.trim().length > 0);
  if (block.type === "bullet") return block.items.some(item => item.trim().length > 0);
  return false;
}

const DIARY_BLOCK_TYPE_LABELS: Record<DiaryEntryBlock["type"], string> = {
  paragraph: "段落",
  quote: "引用",
  correction: "涂改",
  todo: "待办",
  bullet: "要点",
  image: "配图",
};

function DiaryEntryComposeForm({ target, characters, defaultSignature, onSave, onClose }: {
  target: ComposeTarget;
  characters: Character[];
  /** 新写一篇时的默认署名：用户写的日记签自己的名字 */
  defaultSignature?: string;
  onSave: (input: {
    characterId: string;
    authorType?: DiaryEntryAuthorType;
    title: string;
    mood: string;
    weather: string;
    tags: string[];
    signature: string;
    blocks: DiaryEntryBlock[];
  }, editingId?: string) => void;
  onClose: () => void;
}) {
  const editingEntry = target.mode === "edit" ? target.entry : null;
  const characterId = target.mode === "edit" ? target.entry.characterId : target.characterId;
  const character = characters.find(item => item.id === characterId);
  // 新建时的作者类型由调用方指定（首页「日记」「朋友」两个页签共用这套表单）
  const authorType: DiaryEntryAuthorType = editingEntry ? editingEntry.authorType : target.authorType;
  // 用户写的日记不选"写给谁"，署名就是自己；角色日记仍沿用角色名
  const isUserAuthor = authorType === "user";
  const [title, setTitle] = useState(editingEntry?.title ?? "");
  const [mood, setMood] = useState(editingEntry?.mood ?? "");
  const [weather, setWeather] = useState(editingEntry?.weather ?? "");
  const [tagsText, setTagsText] = useState(editingEntry?.tags.join("、") ?? "");
  const [signature, setSignature] = useState(editingEntry?.signature ?? (isUserAuthor ? (defaultSignature ?? "我") : ""));
  // 编辑已有日记时直接从它原来的 blocks 起步——引用/涂改/待办/配图这些板块原样保留，
  // 不会因为编辑就被压平成纯段落。
  const [draftBlocks, setDraftBlocks] = useState<DraftBlock[]>(() =>
    editingEntry && editingEntry.blocks.length > 0 ? toDraftBlocks(editingEntry.blocks) : [makeEmptyBlock("paragraph")]
  );

  const canSave = draftBlocks.some(draftBlockHasContent);

  const updateBlock = useCallback((localId: string, patch: Partial<DiaryEntryBlock>) => {
    setDraftBlocks(blocks => blocks.map(block => (block.localId === localId ? { ...block, ...patch } as DraftBlock : block)));
  }, []);

  const removeBlock = useCallback((localId: string) => {
    setDraftBlocks(blocks => (blocks.length > 1 ? blocks.filter(block => block.localId !== localId) : blocks));
  }, []);

  const addBlock = useCallback((type: DiaryEntryBlock["type"]) => {
    setDraftBlocks(blocks => [...blocks, makeEmptyBlock(type)]);
  }, []);

  // 待办和要点两种清单共用：要点的一项就是一段文字，没有 done
  const updateTodoItem = useCallback((localId: string, index: number, patch: Partial<{ text: string; done: boolean }>) => {
    setDraftBlocks(blocks => blocks.map(block => {
      if (block.localId !== localId) return block;
      if (block.type === "todo") return { ...block, items: block.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) };
      if (block.type === "bullet") return { ...block, items: block.items.map((item, i) => (i === index ? patch.text ?? item : item)) };
      return block;
    }));
  }, []);

  const addTodoItem = useCallback((localId: string) => {
    setDraftBlocks(blocks => blocks.map(block => {
      if (block.localId !== localId) return block;
      if (block.type === "todo") return { ...block, items: [...block.items, { text: "", done: false }] };
      if (block.type === "bullet") return { ...block, items: [...block.items, ""] };
      return block;
    }));
  }, []);

  const removeTodoItem = useCallback((localId: string, index: number) => {
    setDraftBlocks(blocks => blocks.map(block => (
      block.localId === localId && (block.type === "todo" || block.type === "bullet")
        ? { ...block, items: (block.items as unknown[]).filter((_, i) => i !== index) } as DraftBlock
        : block
    )));
  }, []);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const tags = tagsText.split(/[,，、\s]+/).map(tag => tag.trim()).filter(Boolean);
    const blocks = stripDraftBlocks(draftBlocks.filter(draftBlockHasContent));
    onSave({ characterId, authorType, title: title.trim(), mood: mood.trim(), weather: weather.trim(), tags, signature: signature.trim(), blocks }, editingEntry?.id);
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <form className="diary-entry-settings diary-compose-form" onClick={event => event.stopPropagation()} onSubmit={handleSubmit}>
        <header>
          <div>
            <h2>{editingEntry ? "编辑日记" : isUserAuthor ? "写日记" : `写给 ${character?.name ?? "TA"} 的日记`}</h2>
            <p>{editingEntry?.authorType === "character" ? "改动会覆盖这篇日记的原文。" : "写完后会按你设置的回应方式，让TA看到这篇日记。"}</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <label className="diary-compose-field diary-compose-title-field">
          <input type="text" value={title} onChange={event => setTitle(event.target.value)} placeholder="标题（可留空）" />
        </label>
        <div className="diary-entry-setting-grid">
          <label className="diary-compose-field diary-compose-tint-field">
            <span>心情</span>
            <input type="text" value={mood} onChange={event => setMood(event.target.value)} placeholder="例如：平静" />
          </label>
          <label className="diary-compose-field diary-compose-tint-field">
            <span>天气</span>
            <input type="text" value={weather} onChange={event => setWeather(event.target.value)} placeholder="例如：晴" />
          </label>
        </div>
        <label className="diary-compose-field diary-compose-tint-field">
          <span>标签（用顿号或逗号分隔）</span>
          <input type="text" value={tagsText} onChange={event => setTagsText(event.target.value)} placeholder="例如：日常、碎碎念" />
        </label>

        <div className="diary-compose-blocks">
          {draftBlocks.map(block => (
            <DiaryBlockEditor
              key={block.localId}
              block={block}
              canRemove={draftBlocks.length > 1}
              onChange={patch => updateBlock(block.localId, patch)}
              onRemove={() => removeBlock(block.localId)}
              onAddTodoItem={() => addTodoItem(block.localId)}
              onUpdateTodoItem={(index, patch) => updateTodoItem(block.localId, index, patch)}
              onRemoveTodoItem={index => removeTodoItem(block.localId, index)}
            />
          ))}
        </div>

        <div className="diary-compose-add-block">
          {(["paragraph", "quote", "correction", "todo", "bullet", "image"] as const).map(type => (
            <button key={type} type="button" onClick={() => addBlock(type)}>
              + {DIARY_BLOCK_TYPE_LABELS[type]}
            </button>
          ))}
        </div>

        {!editingEntry || editingEntry.authorType === "user" ? (
          <label className="diary-compose-field diary-compose-tint-field">
            <span>署名</span>
            <input type="text" value={signature} onChange={event => setSignature(event.target.value)} placeholder={defaultSignature || "我"} />
          </label>
        ) : null}

        <button type="submit" className="diary-save-btn" disabled={!canSave}>
          {editingEntry ? "保存修改" : "保存日记"}
        </button>
      </form>
    </div>
  );
}

function DiaryBlockEditor({ block, canRemove, onChange, onRemove, onAddTodoItem, onUpdateTodoItem, onRemoveTodoItem }: {
  block: DraftBlock;
  canRemove: boolean;
  onChange: (patch: Partial<DiaryEntryBlock>) => void;
  onRemove: () => void;
  onAddTodoItem: () => void;
  onUpdateTodoItem: (index: number, patch: Partial<{ text: string; done: boolean }>) => void;
  onRemoveTodoItem: (index: number) => void;
}) {
  return (
    <div className="diary-compose-block">
      <div className="diary-compose-block-head">
        <span>{DIARY_BLOCK_TYPE_LABELS[block.type]}</span>
        {canRemove ? (
          <button type="button" onClick={onRemove} aria-label="删除这个板块">
            <X size={14} />
          </button>
        ) : null}
      </div>

      {block.type === "paragraph" || block.type === "quote" ? (
        <textarea
          className="diary-compose-body"
          value={block.text}
          onChange={event => onChange({ text: event.target.value })}
          placeholder={block.type === "quote" ? "摘一句当天听到或想到的话……" : "写下今天想对TA说的话……"}
          rows={block.type === "quote" ? 3 : 6}
        />
      ) : null}

      {block.type === "correction" ? (
        <div className="diary-compose-correction">
          <label>
            <span>原句</span>
            <input type="text" value={block.text} onChange={event => onChange({ text: event.target.value })} placeholder="原来写的" />
          </label>
          <label>
            <span>改成</span>
            <input type="text" value={block.replacement ?? ""} onChange={event => onChange({ replacement: event.target.value })} placeholder="改成这样" />
          </label>
        </div>
      ) : null}

      {block.type === "image" ? (
        <>
          <input
            type="text"
            value={block.caption ?? ""}
            onChange={event => onChange({ caption: event.target.value })}
            placeholder="配图标题（可选）"
          />
          <textarea
            className="diary-compose-body"
            value={block.description}
            onChange={event => onChange({ description: event.target.value })}
            placeholder="描述一下这张想象中的插图……"
            rows={3}
          />
        </>
      ) : null}

      {block.type === "todo" ? (
        <div className="diary-compose-todo">
          <input
            type="text"
            value={block.title ?? ""}
            onChange={event => onChange({ title: event.target.value })}
            placeholder="清单标题（可选）"
          />
          <div className="diary-compose-todo-items">
            {block.items.map((item, index) => (
              <div key={index} className="diary-compose-todo-item">
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={event => onUpdateTodoItem(index, { done: event.target.checked })}
                />
                <input
                  type="text"
                  value={item.text}
                  onChange={event => onUpdateTodoItem(index, { text: event.target.value })}
                  placeholder="待办事项"
                />
                <button type="button" onClick={() => onRemoveTodoItem(index)} aria-label="删除这一项">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="diary-compose-add-todo-item" onClick={onAddTodoItem}>+ 加一项</button>
        </div>
      ) : null}

      {block.type === "bullet" ? (
        <div className="diary-compose-todo">
          <input
            type="text"
            value={block.title ?? ""}
            onChange={event => onChange({ title: event.target.value })}
            placeholder="标题（可选）"
          />
          <div className="diary-compose-todo-items">
            {block.items.map((item, index) => (
              <div key={index} className="diary-compose-todo-item">
                <span className="diary-compose-bullet-mark" aria-hidden="true" />
                <input
                  type="text"
                  value={item}
                  onChange={event => onUpdateTodoItem(index, { text: event.target.value })}
                  placeholder="要点"
                />
                <button type="button" onClick={() => onRemoveTodoItem(index)} aria-label="删除这一项">
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="diary-compose-add-todo-item" onClick={onAddTodoItem}>+ 加一项</button>
        </div>
      ) : null}
    </div>
  );
}

function DiaryEntryWritePanel({ characters, generatingCharacterIds, onGenerateMany, onClose }: {
  characters: Character[];
  generatingCharacterIds: string[];
  onGenerateMany: (characterIds: string[], trigger?: DiaryEntryTrigger) => Promise<void> | void;
  onClose: () => void;
}) {
  const [selectedImmediateIds, setSelectedImmediateIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const busy = confirming || generatingCharacterIds.length > 0;

  const toggleImmediateCharacter = (characterId: string) => {
    setSelectedImmediateIds(prev => prev.includes(characterId)
      ? prev.filter(id => id !== characterId)
      : [...prev, characterId]);
  };

  const handleConfirm = async () => {
    if (busy || selectedImmediateIds.length === 0) return;
    setConfirming(true);
    try {
      await onGenerateMany(selectedImmediateIds, "manual");
      setSelectedImmediateIds([]);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings diary-entry-write-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>让TA写一篇</h2>
            <p>选择角色后确认，会并行生成日记。</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <CharacterAvatarGrid
          characters={characters}
          selectedIds={selectedImmediateIds}
          busyIds={generatingCharacterIds}
          disabled={busy}
          onToggle={toggleImmediateCharacter}
        />
        {selectedImmediateIds.length > 0 ? (
          <button
            type="button"
            className={`diary-entry-confirm-btn ${confirming ? "is-loading" : ""}`}
            disabled={busy}
            onClick={handleConfirm}
            aria-busy={confirming}
          >
            <span className="note-wall-primary-content">
              {confirming ? <span className="note-wall-primary-spinner" aria-hidden="true" /> : null}
              <span>{confirming ? <DiaryWritingStatus /> : `确认让 ${selectedImmediateIds.length} 个角色写日记`}</span>
            </span>
          </button>
        ) : null}
      </section>
    </div>
  );
}

function CharacterAvatarGrid({ characters, selectedIds, busyIds, disabled, onToggle }: {
  characters: Character[];
  selectedIds: string[];
  busyIds: string[];
  disabled: boolean;
  onToggle: (characterId: string) => void;
}) {
  if (characters.length === 0) return <p className="diary-entry-empty-line">暂无角色。</p>;

  return (
    <div className="diary-entry-character-grid">
      {characters.map(character => {
        const selected = selectedIds.includes(character.id);
        const busy = busyIds.includes(character.id);
        return (
          <button
            key={character.id}
            type="button"
            className={selected ? "is-selected" : ""}
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onToggle(character.id)}
          >
            <span>
              {character.avatar ? <img src={character.avatar} alt="" /> : <Bot size={18} />}
            </span>
            <strong>{character.name}</strong>
            {busy ? <em><DiaryWritingStatus /></em> : null}
          </button>
        );
      })}
    </div>
  );
}

function DiaryEntryDetail({ entry, userIdentity, onClose, onEdit, onDelete }: {
  entry: DiaryEntry;
  userIdentity?: Pick<UserIdentity, "name"> | null;
  onClose: () => void;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  const markers = getEntryMarkers(entry);
  // 用户写的日记署名是自己：优先用填写的署名，其次当前账号名
  const authorLine = entry.authorType === "user"
    ? (entry.signature || userIdentity?.name || "我")
    : entry.characterName;
  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <article className="diary-entry-detail-paper" onClick={(event) => event.stopPropagation()}>
        <span className="diary-entry-paper-clip" aria-hidden="true">
          <span />
        </span>
        <div className="diary-entry-detail-scroll">
          <header>
            <div className="diary-entry-detail-topline">
              <span>日记详情</span>
              <div className="diary-entry-detail-actions">
                {onDelete ? (
                  <button type="button" className="diary-detail-delete-btn" onClick={onDelete}>删除</button>
                ) : null}
                <button type="button" onClick={onEdit}>编辑</button>
                <button type="button" onClick={onClose}>关闭</button>
              </div>
            </div>
            <div className="diary-entry-detail-titleline">
              <h2>{entry.title}</h2>
              {markers.length > 0 ? (
                <span className="diary-entry-detail-markers">
                  {markers.map(marker => <span key={marker} className="diary-entry-marker">{marker}</span>)}
                </span>
              ) : null}
            </div>
          </header>
          <div className="diary-entry-blocks">
            {entry.blocks.map((block, index) => (
              <DiaryBlockView key={`${block.type}-${index}`} block={block} />
            ))}
          </div>
          <footer className="diary-entry-detail-signature">
            <span>{authorLine}</span>
            <time>{formatEntryTime(entry.createdAt)}</time>
          </footer>
        </div>
      </article>
    </div>
  );
}

function DiaryBlockView({ block }: { block: DiaryEntryBlock }) {
  if (block.type === "quote") {
    return <blockquote className="diary-entry-quote">{block.text}</blockquote>;
  }
  if (block.type === "correction") {
    return (
      <p className="diary-entry-correction">
        <del>{block.text}</del>
        {block.replacement ? <ins>{block.replacement}</ins> : null}
      </p>
    );
  }
  if (block.type === "todo") {
    return (
      <section className="diary-entry-todo">
        {block.title ? <h3>{block.title}</h3> : null}
        <ul>
          {block.items.map((item, index) => (
            <li key={`${item.text}-${index}`} data-done={item.done ? "true" : "false"}>
              <span />
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (block.type === "bullet") {
    return (
      <section className="diary-entry-todo diary-entry-bullets">
        {block.title ? <h3>{block.title}</h3> : null}
        <ul>
          {block.items.map((item, index) => (
            <li key={`${item}-${index}`}>
              <span />
              <p>{item}</p>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (block.type === "image") {
    return (
      <figure className="diary-entry-image-block">
        <div>{block.description}</div>
        {block.caption ? <figcaption>{block.caption}</figcaption> : null}
      </figure>
    );
  }
  return <p className="diary-entry-paragraph">{block.text}</p>;
}
