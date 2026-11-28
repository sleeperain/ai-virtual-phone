"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import {
  Bookmark,
  Bot,
  ChevronDown,
  ChevronLeft,
  Clock3,
  Heart,
  Lock,
  NotebookPen,
  Share,
  Trash2,
  UserRound,
  WandSparkles,
  X,
} from "lucide-react";


import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateDiaryEntryForCharacter } from "@/lib/diary-entry-engine";
import { useDiaryGenerating } from "@/lib/diary-generating-tracker";
import { DIARY_ENTRIES_UPDATED_EVENT } from "@/lib/diary-entry-timer-service";
import {
  createDiaryEntry,
  deleteDiaryEntry,
  loadDiaryEntries,
  loadDiaryUsername,
  saveDiaryUsername,
  updateDiaryEntry,
} from "@/lib/diary-entry-storage";
import type {
  DiaryEntry,
  DiaryEntryAuthorType,
  DiaryEntryBlock,
  DiaryEntryTrigger,
  DiaryEntryVisibility,
} from "@/lib/diary-entry-types";
import { cancelDiaryReply, scheduleDiaryReply } from "@/lib/diary-reply-service";
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { UserIdentity } from "@/components/settings/user-identity";
import { DiaryBrandHeader, type DiaryBrandView } from "./diary-brand-header";
import { CharacterAvatarGrid, DiaryWritingStatus } from "./diary-character-grid";
import { DiaryUserSettingsPage, type DiarySettingsTab } from "./diary-user-settings";
import { useDiaryFont } from "./use-diary-font";

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

/** 时间戳行最右侧的权限状态：公开的不显示，只显示「私密」和「仅部分人可见」 */
function visibilityBadge(entry: DiaryEntry): string | null {
  const visibility = entry.visibility ?? "private";
  if (visibility === "public") return null;
  return DIARY_VISIBILITY_LABELS[visibility];
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
  /** 顶部栏 iFloat 点了回桌面 */
  onClose: () => void;
  /** 顶部栏星星/铃铛在两个页面间切换 */
  onSwitch: (view: DiaryBrandView) => void;
  onNotice?: (message: string) => void;
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

function blockPlainText(block: DiaryEntryBlock): string {
  if (block.type === "paragraph" || block.type === "quote") return block.text;
  if (block.type === "correction") return block.replacement || block.text;
  if (block.type === "image") return block.caption || block.description;
  if (block.type === "todo") return block.items.map(item => item.text).join(" / ");
  if (block.type === "bullet") return block.items.join(" / ");
  return "";
}

export function DiaryEntriesApp({ kind, onClose, onSwitch, onNotice }: DiaryEntriesAppProps) {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [writePanelOpen, setWritePanelOpen] = useState(false);
  const [composeTarget, setComposeTarget] = useState<ComposeTarget | null>(null);
  const [activeEntry, setActiveEntry] = useState<DiaryEntry | null>(null);
  const [deleteCandidateEntry, setDeleteCandidateEntry] = useState<DiaryEntry | null>(null);
  /** 用户设置页（定时 / 隐私 / 字体 / 署名）：null = 没打开，否则是当前页签 */
  const [settingsTab, setSettingsTab] = useState<DiarySettingsTab | null>(null);
  const [localGeneratingIds, setGeneratingCharacterIds] = useState<string[]>([]);
  // Merge in the module-level tracker so background generation (timer, or a
  // batch started before leaving the app) is visible again after re-entry.
  const trackedGeneratingIds = useDiaryGenerating();
  const generatingCharacterIds = useMemo(
    () => Array.from(new Set([...localGeneratingIds, ...trackedGeneratingIds])),
    [localGeneratingIds, trackedGeneratingIds],
  );
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

  // 定时 / 回应 / 字体 / 署名这些设置都搬进用户设置页了，这里只跟着刷新列表
  useEffect(() => {
    const handleEntriesUpdated = () => {
      refreshEntries();
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
    username: string;
    title: string;
    mood: string;
    weather: string;
    tags: string[];
    signature: string;
    blocks: DiaryEntryBlock[];
  }, editingId?: string) => {
    // 表单传来的 authorType 优先（首页两个页签共用一套表单），兜底才用 kind
    const authorType = input.authorType ?? kind;
    // 填过的 ID 记住，下次新写一篇自动带出来
    if (authorType === "user") saveDiaryUsername(input.username);
    // body 是给"近期日记"这类只读纯文本上下文用的摊平版本；用 blockPlainText 而不是只拼
    // paragraph/quote，这样 correction/todo/image 这些板块的内容也不会在摊平时丢掉。
    const body = input.blocks.map(blockPlainText).filter(Boolean).join("\n\n");
    if (!editingId) {
      const character = resolveTargets([input.characterId])[0];
      const created = createDiaryEntry({
        characterId: input.characterId,
        characterName: character?.name ?? "角色",
        authorType,
        username: input.username,
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
      username: input.username,
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
      username: loadDiaryUsername(),
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

  /** 「日记」页签：我写的；「朋友」页签：TA 写的 */
  const mySortedEntries = useMemo(
    () => sortEntriesByTime(entries.filter(entry => entry.authorType === "user")),
    [entries],
  );
  const friendSortedEntries = useMemo(
    () => sortEntriesByTime(entries.filter(entry => entry.authorType === "character")),
    [entries],
  );

  // 用户设置也是一整页：顶部栏品牌 + 「用户设置」标签行 + 四个等分页签
  if (settingsTab) {
    return (
      <DiaryUserSettingsPage
        view="entries"
        tab={settingsTab}
        onTabChange={setSettingsTab}
        characters={characters}
        onClose={onClose}
        onSwitch={onSwitch}
        onExit={() => setSettingsTab(null)}
        onNotice={notify}
      />
    );
  }

  // 日记详情是一整页（不再是弹窗）：进入后整页替换列表
  if (activeEntry) {
    return (
      <>
        <DiaryEntryDetailPage
          entry={activeEntry}
          character={characters.find(character => character.id === activeEntry.characterId)}
          userIdentity={userIdentity}
          fontStyle={font.style}
          onBack={() => setActiveEntry(null)}
          onEdit={() => setComposeTarget({ mode: "edit", entry: activeEntry })}
          onDelete={() => {
            const entryToDelete = activeEntry;
            setActiveEntry(null);
            setDeleteCandidateEntry(entryToDelete);
          }}
        />
        {composeTarget ? (
          <DiaryEntryComposeForm
            target={composeTarget}
            characters={characters}
            defaultSignature={userIdentity?.name || "我"}
            onSave={saveComposeEntry}
            onClose={() => setComposeTarget(null)}
          />
        ) : null}
      </>
    );
  }

  return (
    <section className="diary-app diary-entry-app" style={font.style}>
      {generatingCharacterIds.length > 0 && (
        <div className="diary-generating-toast" role="status">
          <span className="diary-generating-toast-spinner" aria-hidden="true" />
          正在生成日记{generatingCharacterIds.length > 1 ? `（${generatingCharacterIds.length} 篇）` : ""}…
        </div>
      )}
      <DiaryBrandHeader
        view="entries"
        onClose={onClose}
        onSwitch={onSwitch}
        avatarLabel="账户菜单"
        // 头像下拉里的「设置」：所有设置都收在用户设置页的四个页签里了
        onOpenSettings={() => setSettingsTab("timer")}
      />

      <main className="diary-entry-main diary-hub-main">
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

        {/* 只有这一块滚动：起点就是三个页签的下边线；条目仍收回一张圆角白卡里 */}
        <div className="diary-hub-scroll">
          <div className="diary-hub-entries">
            {tab === "notices" ? (
              <DiaryHubNoticeList entries={entries} characters={characters} userIdentity={userIdentity} />
            ) : null}

            {tab !== "notices" && (tab === "mine" ? mySortedEntries : friendSortedEntries).length === 0 ? (
              <div className="diary-entry-empty">
                <NotebookPen size={34} strokeWidth={1.5} />
                <h2>{tab === "mine" ? "还没有日记" : "还没有TA的日记"}</h2>
                {/* 提示文案里的关键词本身就是按钮，不再单独放一个按钮 */}
                {tab === "mine" ? (
                  <p>
                    在上面写一句，或者{" "}
                    <button type="button" className="diary-hub-empty-link" onClick={openUserCompose}>
                      写下第一篇
                    </button>
                    。
                  </p>
                ) : (
                  <p>
                    <button type="button" className="diary-hub-empty-link" onClick={() => setWritePanelOpen(true)}>
                      让角色先写一篇
                    </button>
                    ，纸面会从这里开始铺开。
                  </p>
                )}
              </div>
            ) : null}

            {tab !== "notices"
              ? (tab === "mine" ? mySortedEntries : friendSortedEntries).map(entry => (
                <DiaryEntryCard
                  key={entry.id}
                  entry={entry}
                  character={characters.find(c => c.id === entry.characterId)}
                  userIdentity={userIdentity}
                  onClick={(event) => {
                    event.stopPropagation();
                    setActiveEntry(entry);
                  }}
                />
              ))
              : null}
          </div>
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

  // 列表卡片只显示段落和引用；待办/要点/涂改/配图这些要进详情页才看得到
  const preview = useMemo(() => {
    return entry.blocks
      .filter(block => block.type === "paragraph" || block.type === "quote")
      .map(blockPlainText)
      .filter(Boolean)
      .join("\n")
      .trim();
  }, [entry.blocks]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // 检查在 6 行限制下是否产生溢出
    if (el.scrollHeight > el.clientHeight + 1) {
      setCanExpand(true);
    }
  }, [preview]);

  const isMine = entry.authorType === "user";
  // 我写的日记：作者名/头像跟「当前账号」走，第二行是表单里填的 ID；TA 的日记照旧显示 @手机号
  const phone = character?.wechatID || character?.id || "";
  const authorName = isMine ? (userIdentity?.name || "我") : entry.characterName;
  const avatar = isMine ? (userIdentity?.avatarUrl || "") : (character?.avatar || "");
  const username = (entry.username ?? "").trim();
  const subline = isMine ? (username ? `@${username}` : "") : `@${phone}`;
  const permission = isMine ? visibilityBadge(entry) : null;

  return (
    <div className="diary-flat-card-inner">
      {/* 第一行最左侧是32*32px的角色圆形头像，右侧第一行角色名（黑），第二行小一号字ID（@手机号） */}
      <div className="diary-flat-card-author-row">
        <div className="diary-flat-card-avatar">
          {avatar ? <img src={avatar} alt={authorName} /> : isMine ? <UserRound size={17} /> : <Bot size={18} />}
        </div>
        <div className="diary-flat-card-author-info">
          <span className="diary-flat-card-author-name">{authorName}</span>
          {subline ? <span className="diary-flat-card-author-id">{subline}</span> : null}
        </div>
      </div>

      {/* 日记正文：只铺段落和引用，其余板块进详情页看。展开/收起按钮直接跟在文本后 */}
      {preview ? (
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
      ) : null}

      {/* 最后一行最左侧为小字“🕓 YYYY-MM-DD hh:mm”，最右侧放权限状态（公开不显示） */}
      <div className="diary-flat-card-footer">
        <Clock3 size={13} className="diary-flat-clock-svg" aria-hidden="true" />
        <time className="diary-flat-card-time">{formatEntryDateTime(entry.createdAt)}</time>
        {permission ? (
          <span className="diary-entry-permission">
            <Lock size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{permission}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function DiaryEntryCard({ entry, character, userIdentity, onClick }: {
  entry: DiaryEntry;
  character?: Character;
  userIdentity?: Pick<UserIdentity, "name" | "avatarUrl"> | null;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className="diary-flat-card"
      draggable={false}
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

/**
 * 「通知」页签：把日记动态摊成一条条通知。
 * 一篇日记先有一条「发布了」，之后每改一次各多一条「更新了」——
 * 发布那条不会被改写成更新，改几次就留几条。
 */
function buildDiaryNotices(entries: DiaryEntry[]): DiaryNotice[] {
  const notices: DiaryNotice[] = [];
  for (const entry of entries) {
    const mine = entry.authorType === "user";
    const who = mine ? "你" : entry.characterName;
    // 没有标题就不带书名号，只留「谁发布了一则日记」
    const titlePart = entry.title ? `：《${entry.title}》` : "";
    notices.push({
      id: `${entry.id}-publish`,
      text: `${who}发布了一则日记${titlePart}`,
      time: entry.createdAt,
      isMine: mine,
      characterId: entry.characterId,
    });
    // 每次改动各一条；没有 updatedHistory 的老条目只能知道自己被改过，按一条算
    const history = entry.updatedHistory && entry.updatedHistory.length > 0
      ? entry.updatedHistory
      : (entry.updatedAt && entry.createdAt && entry.updatedAt !== entry.createdAt ? [entry.updatedAt] : []);
    history.forEach((at, index) => {
      notices.push({
        id: `${entry.id}-update-${index}`,
        text: `${who}更新了一则日记${titlePart}`,
        time: at,
        isMine: mine,
        characterId: entry.characterId,
      });
    });
  }
  return notices
    .sort((a, b) => {
      const timeA = new Date(a.time).getTime();
      const timeB = new Date(b.time).getTime();
      return (Number.isNaN(timeB) ? 0 : timeB) - (Number.isNaN(timeA) ? 0 : timeA);
    })
    .slice(0, 60);
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

/* 字体、定时、回应、署名四个弹窗都已并入用户设置页（diary-user-settings.tsx），
   原来那几段整段删掉了，别再往回加。 */


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
    username: string;
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
  // 作者名下方那行灰色 ID：编辑已有日记带它自己的，新写一篇带上次填过的（记住状态）
  const [username, setUsername] = useState(() => editingEntry?.username ?? loadDiaryUsername());
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
    onSave({
      characterId,
      authorType,
      username: username.trim().replace(/^@+/, ""),
      title: title.trim(),
      mood: mood.trim(),
      weather: weather.trim(),
      tags,
      signature: signature.trim(),
      blocks,
    }, editingEntry?.id);
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

        {isUserAuthor ? (
          <label className="diary-compose-field diary-compose-tint-field">
            <span>username（写在名字下方的 ID，不带 @）</span>
            <input
              type="text"
              value={username}
              onChange={event => setUsername(event.target.value)}
              placeholder="例如：list"
              maxLength={40}
            />
          </label>
        ) : null}

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

/** 日记详情：独立整页，顶部栏沿用「TA的手记」那套，下面是完整内容的日记卡片 */
function DiaryEntryDetailPage({ entry, character, userIdentity, fontStyle, onBack, onEdit, onDelete }: {
  entry: DiaryEntry;
  character?: Character;
  userIdentity?: Pick<UserIdentity, "name" | "avatarUrl"> | null;
  fontStyle?: CSSProperties;
  onBack: () => void;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // 「喜欢」「小纸条」只是点亮状态，不入库（跟参考代码一致）
  const [liked, setLiked] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const isMine = entry.authorType === "user";
  const authorName = isMine ? (userIdentity?.name || "我") : entry.characterName;
  const avatar = isMine ? (userIdentity?.avatarUrl || "") : (character?.avatar || "");
  const phone = character?.wechatID || character?.id || "";
  const username = (entry.username ?? "").trim();
  const subline = isMine ? (username ? `@${username}` : "") : `@${phone}`;
  // 权限状态放在时间戳行最右侧；公开的不显示
  const permission = isMine ? visibilityBadge(entry) : null;

  return (
    <section className="diary-app diary-entry-app diary-detail-page" style={fontStyle}>
      {/* 详情页用普通顶部栏（返回箭头 + 居中标题），品牌栏只出现在两个列表页 */}
      <header className="diary-app-header diary-entry-header diary-detail-header">
        <button type="button" className="diary-icon-btn" onClick={onBack} aria-label="返回">
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>{`${authorName} • 日记`}</h1>
        </div>
        <span className="diary-header-spacer" />
      </header>

      <div className="diary-detail-scroll">
        <article className="diary-flat-card diary-detail-card">
          <div className="diary-flat-card-inner">
            {/* 第一行：头像 + 作者名 + 副行（可见范围 / @手机号），与主页卡片一致 */}
            <div className="diary-flat-card-author-row">
              <div className="diary-flat-card-avatar">
                {avatar ? <img src={avatar} alt={authorName} /> : isMine ? <UserRound size={17} /> : <Bot size={18} />}
              </div>
              <div className="diary-flat-card-author-info">
                <span className="diary-flat-card-author-name">{authorName}</span>
                {subline ? <span className="diary-flat-card-author-id">{subline}</span> : null}
              </div>
            </div>

            {entry.title ? <h2 className="diary-detail-title">{entry.title}</h2> : null}

            {/* 详情页不显示心情/天气/标签这些记号 */}

            {/* 完整内容：详情页把所有板块都铺开，不再只显示段落和引用 */}
            <div className="diary-entry-blocks diary-detail-blocks">
              {entry.blocks.map((block, index) => (
                <DiaryBlockView key={`${block.type}-${index}`} block={block} />
              ))}
            </div>

            <div className="diary-flat-card-footer">
              <Clock3 size={13} className="diary-flat-clock-svg" aria-hidden="true" />
              <time className="diary-flat-card-time">{formatEntryDateTime(entry.createdAt)}</time>
              {permission ? (
                <span className="diary-entry-permission">
                  <Lock size={14} strokeWidth={1.8} aria-hidden="true" />
                  <span>{permission}</span>
                </span>
              ) : null}
            </div>

            {/* 时间戳下方一行伪按钮装饰：按文字宽度比例分格，格间分割线用相邻元素左侧 1px 阴影画 */}
            <div className="diary-detail-actions">
              <button
                type="button"
                className={`diary-detail-action ${liked ? "is-liked" : ""}`}
                onClick={() => setLiked(value => !value)}
                aria-pressed={liked}
              >
                <Heart size={21} strokeWidth={1.6} aria-hidden="true" />
                <span>喜欢</span>
              </button>
              <button
                type="button"
                className={`diary-detail-action ${bookmarked ? "is-bookmarked" : ""}`}
                onClick={() => setBookmarked(value => !value)}
                aria-pressed={bookmarked}
              >
                <Bookmark size={21} strokeWidth={1.6} aria-hidden="true" />
                <span>小纸条</span>
              </button>
              <button type="button" className="diary-detail-action">
                <Share size={21} strokeWidth={1.6} aria-hidden="true" />
                <span>存为图片</span>
              </button>
              <div className="diary-detail-more">
                <button
                  type="button"
                  className="diary-detail-action"
                  onClick={() => setMenuOpen(open => !open)}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label="更多操作"
                >
                  {/* 标准的三点省略号：三个等距实心圆，比 lucide 那版更居中、更规整 */}
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.9" />
                    <circle cx="12" cy="12" r="1.9" />
                    <circle cx="19" cy="12" r="1.9" />
                  </svg>
                </button>
                {menuOpen ? (
                  <>
                    <div className="diary-detail-more-backdrop" onClick={() => setMenuOpen(false)} />
                    <div className="diary-detail-more-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setMenuOpen(false); onEdit(); }}
                      >
                        编辑
                      </button>
                      {onDelete ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="is-danger"
                          onClick={() => { setMenuOpen(false); onDelete(); }}
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

function DiaryBlockView({ block }: { block: DiaryEntryBlock }) {
  // 涂改默认只显示「（有更改）」，点开才露出原句（不加删除线）
  const [correctionOpen, setCorrectionOpen] = useState(false);
  if (block.type === "quote") {
    return <blockquote className="diary-entry-quote">{block.text}</blockquote>;
  }
  if (block.type === "correction") {
    // 默认显示改写后的句子；点「（有更改）」换成改写前的原句，再点「（恢复）」换回来。
    // 没有改写后的内容时退回原句，按钮就不显示了。
    const revised = (block.replacement ?? "").trim();
    const shown = correctionOpen || !revised ? block.text : revised;
    const canToggle = Boolean(revised) && revised !== block.text;
    return (
      <p className="diary-entry-correction">
        <span className="diary-entry-correction-text">{shown}</span>
        {canToggle ? (
          <button
            type="button"
            className="diary-entry-correction-toggle"
            onClick={() => setCorrectionOpen(open => !open)}
            aria-expanded={correctionOpen}
          >
            {correctionOpen ? "（恢复）" : "（有更改）"}
          </button>
        ) : null}
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
