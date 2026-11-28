"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Bookmark, Bot, ChevronLeft, Clock3, Heart, Share, Trash2 } from "lucide-react";

import { ReadingShareDialog } from "@/components/reading/reading-share-dialog";
import { ContentDialog } from "@/components/ui/modal";
import { downloadFile } from "@/lib/download-utils";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
  MOMENTS_UPDATED_EVENT,
  MOMENT_PROFILES_UPDATED_EVENT,
  deleteMoment,
  loadMomentAsset,
  loadMomentAvatar,
  loadMomentProfiles,
  loadMoments,
  momentUserOwner,
  type Moment,
  type MomentChatLine,
  type MomentProfileOwner,
  type MomentProfiles,
} from "@/lib/moment-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { DiaryBrandHeader, type DiaryBrandView } from "./diary-brand-header";
import { DiaryUserSettingsPage, type DiarySettingsTab } from "./diary-user-settings";
import { useDiaryFont } from "./use-diary-font";

type MomentsAppProps = {
  /** 顶部栏 iFloat 点了回桌面 */
  onClose: () => void;
  /** 顶部栏星星/铃铛在两个页面间切换 */
  onSwitch: (view: DiaryBrandView) => void;
  onNotice?: (message: string) => void;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function momentDate(moment: Moment): string {
  return formatDate(moment.messageAt) || formatDate(moment.createdAt);
}

/** 卡片/详情时间戳：和手记一致，用 YYYY-MM-DD HH:mm */
function momentTimestamp(moment: Moment): string {
  const date = new Date(moment.messageAt || moment.createdAt);
  if (Number.isNaN(date.getTime())) return momentDate(moment);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/** 剧情里那个「我」：和剧情 App 一样先找剧情身份，再找这个角色的、全局的 */
function storyIdentity(characterId: string) {
  return resolveUserIdentity(characterId, "story") ?? resolveUserIdentity(characterId) ?? resolveUserIdentity();
}

function momentTime(moment: Moment): number {
  const time = new Date(moment.messageAt || moment.createdAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** 纸条右上角那枚小标 */
function sourceLabel(moment: Moment): string {
  if (moment.source === "chat") return "聊天";
  return moment.source === "extra" ? "番外" : "正篇";
}

type PaperTone = "yellow" | "green" | "blue";

export function MomentsApp({ onClose, onSwitch, onNotice }: MomentsAppProps) {
  const [moments, setMoments] = useState<Moment[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [activeMoment, setActiveMoment] = useState<{ moment: Moment; tone: PaperTone } | null>(null);
  const [sharingMoment, setSharingMoment] = useState<Moment | null>(null);
  // 聊天那张纸点分享：就是收的时候存下的那张聊天截图
  const [chatShot, setChatShot] = useState<{ blob: Blob; url: string; name: string } | null>(null);
  useEffect(() => () => { if (chatShot) URL.revokeObjectURL(chatShot.url); }, [chatShot]);
  // 聊天那几张纸上的小图（表情、转账、拍一拍……）：Blob → objectURL
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [deleteCandidate, setDeleteCandidate] = useState<Moment | null>(null);
  /** 用户设置页（定时 / 隐私 / 字体 / 署名）：null = 没打开，否则是当前页签 */
  const [settingsTab, setSettingsTab] = useState<DiarySettingsTab | null>(null);
  const [profiles, setProfiles] = useState<MomentProfiles>(() => ({ user: { name: "" }, characters: {}, userByCharacter: {} }));
  // 自己设的署名头像（阅读图片库里的 blob → objectURL），没设的不在这里
  const [profileAvatars, setProfileAvatars] = useState<Record<MomentProfileOwner, string>>({});

  const notify = useCallback((message: string) => {
    onNotice?.(message);
  }, [onNotice]);

  // 系统字体：片刻纪事里所有的字；聊天里收的「我」/角色说的话另用自己的（没传就跟系统字体走）
  const font = useDiaryFont("moment", notify);
  const userFont = useDiaryFont("moment-user", notify);
  const charFont = useDiaryFont("moment-char", notify);
  /** 画分享图用的真实字体名：我 / 角色那份没传就是系统字体 */
  const speakerFonts = {
    user: userFont.hasCustomFont ? userFont.family : font.family,
    char: charFont.hasCustomFont ? charFont.family : font.family,
  };
  useEffect(() => {
    let cancelled = false;
    let current: string[] = [];
    const loadAvatars = async () => {
      const ids = loadCharacters().map(character => character.id);
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
      setProfileAvatars(next);
    };
    setProfiles(loadMomentProfiles());
    void loadAvatars();
    const onUpdated = (event: Event) => {
      if ((event as CustomEvent).detail === "avatar") void loadAvatars();
      else setProfiles(loadMomentProfiles());
    };
    window.addEventListener(MOMENT_PROFILES_UPDATED_EVENT, onUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(MOMENT_PROFILES_UPDATED_EVENT, onUpdated);
      current.forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    const refresh = () => setMoments(loadMoments());
    refresh();
    setCharacters(loadCharacters());
    window.addEventListener(MOMENTS_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(MOMENTS_UPDATED_EVENT, refresh);
  }, []);

  // 聊天纸条里的小图（表情、转账等）：直接把当前列表里所有需要的资源都读出来。
  // 注意别再依赖 activeBook——书架视图删掉后它恒为 null，会导致小图一张都不显示。
  useEffect(() => {
    const keys = moments.flatMap(moment => (moment.lines ?? []).flatMap(line => (line.kind === "snap" ? [line.asset] : [])));
    if (keys.length === 0) {
      setAssetUrls({});
      return;
    }
    let cancelled = false;
    const made: string[] = [];
    void Promise.all(keys.map(async key => [key, await loadMomentAsset(key)] as const)).then((entries) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const [key, blob] of entries) {
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        made.push(url);
        next[key] = url;
      }
      setAssetUrls(next);
    });
    return () => {
      cancelled = true;
      made.forEach(url => URL.revokeObjectURL(url));
    };
  }, [moments]);

  const openChatShot = useCallback(async (moment: Moment) => {
    const blob = moment.shotAsset ? await loadMomentAsset(moment.shotAsset) : null;
    if (!blob) {
      notify("这张没有存下聊天截图。");
      return;
    }
    setChatShot({ blob, url: URL.createObjectURL(blob), name: `片刻纪事-聊天-${moment.characterName || "未命名"}-${momentDate(moment)}.jpg` });
  }, [notify]);

  const saveChatShot = useCallback(async () => {
    if (!chatShot) return;
    try {
      await downloadFile(chatShot.blob, chatShot.name);
      setChatShot(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败");
    }
  }, [chatShot, notify]);

  const removeMoment = useCallback((moment: Moment) => {
    deleteMoment(moment.id);
    setActiveMoment(current => current?.moment.id === moment.id ? null : current);
    setDeleteCandidate(null);
    notify("已从片刻纪事里删掉这一段。");
  }, [notify]);

  /** 署名：片刻纪事里自己设的 ID / 头像优先，没设就用角色档案、聊天身份里的 */
  const charSignature = useCallback((characterId: string, fallbackName: string) => {
    const character = characters.find(item => item.id === characterId);
    return {
      name: profiles.characters[characterId]?.name || character?.name || fallbackName,
      avatar: profileAvatars[characterId] || character?.avatar || undefined,
    };
  }, [characters, profileAvatars, profiles]);
  /** 外面设的「我」，没设就用聊天身份；本子里没单独设时用它 */
  const userBase = useCallback((characterId: string) => {
    const identity = storyIdentity(characterId);
    return {
      name: profiles.user.name || identity?.name || "我",
      avatar: profileAvatars.user || identity?.avatarUrl || undefined,
    };
  }, [profileAvatars, profiles]);
  const userSignature = useCallback((characterId: string) => {
    const base = userBase(characterId);
    return {
      name: profiles.userByCharacter[characterId]?.name || base.name,
      avatar: profileAvatars[momentUserOwner(characterId)] || base.avatar,
    };
  }, [profileAvatars, profiles, userBase]);
  /** 分享图出处那行「《正篇》· 我 · 角色」：用署名设置里的名字，没设才退回身份名 / 角色卡名 */
  const realNames = useCallback((characterId: string, fallbackName: string) => {
    return `${userSignature(characterId).name} · ${charSignature(characterId, fallbackName).name}`;
  }, [charSignature, userSignature]);

  // 用户设置也是一整页：顶部栏品牌 + 「用户设置」标签行 + 四个等分页签
  if (settingsTab) {
    return (
      <DiaryUserSettingsPage
        view="moments"
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

  return (
    <section className="diary-app diary-entry-app" style={{ ...font.style, ...userFont.style, ...charFont.style }}>
      <DiaryBrandHeader
        view="moments"
        onClose={onClose}
        onSwitch={onSwitch}
        avatarLabel="账户菜单"
        // 头像下拉里的「设置」：所有设置都收在用户设置页的四个页签里了
        onOpenSettings={() => setSettingsTab("timer")}
      />

      {/* Bookmark 标签跟着内容一起滚：整块 main 就是滚动区，上沿从顶部栏下边线开始 */}
      <main className="diary-entry-main diary-moment-main">
        <div className="diary-moment-label-row">
          <span>Bookmark</span>
        </div>

        <div className="diary-hub-entries">
            {moments.length === 0 ? (
              <div className="diary-entry-empty">
                <Bookmark size={34} strokeWidth={1.5} />
                <h2>还没有收下的片刻</h2>
                <p>在剧情正篇、番外里长按一段，点「收藏」就会收到这里。</p>
              </div>
            ) : (
              [...moments]
                .sort((a, b) => momentTime(b) - momentTime(a))
                .map((moment) => {
                  const char = characters.find(c => c.id === moment.characterId);
                  const phone = char?.wechatID || char?.id || "";
                  const avatar = char?.avatar || "";
                  const contentText = moment.source === "chat"
                    ? (moment.lines ?? []).map(l => (l.kind === "text" ? `${l.speaker === "user" ? "我" : moment.characterName}: ${l.text}` : "[图片]")).join("\n")
                    : moment.paragraphs.join("\n");

                  return (
                    <article
                      key={moment.id}
                      className="diary-flat-card"
                      onClick={() => setActiveMoment({ moment, tone: "yellow" })}
                    >
                      <div className="diary-flat-card-inner">
                        <div className="diary-flat-card-author-row">
                          <div className="diary-flat-card-avatar">
                            {avatar ? <img src={avatar} alt={moment.characterName} /> : <Bot size={18} />}
                          </div>
                          <div className="diary-flat-card-author-info">
                            <span className="diary-flat-card-author-name">{moment.characterName}</span>
                            <span className="diary-flat-card-author-id">@{phone}</span>
                          </div>
                        </div>

                        {/* 列表里最多六行，全文进详情页看 */}
                        <div className="diary-flat-card-body is-clamped">
                          {contentText}
                        </div>

                        <div className="diary-flat-card-footer">
                          <Clock3 size={13} className="diary-flat-clock-svg" aria-hidden="true" />
                          <time className="diary-flat-card-time">{momentTimestamp(moment)}</time>
                        </div>
                      </div>
                    </article>
                  );
                })
            )}
        </div>
      </main>

      {activeMoment ? (
        <MomentDetailPage
          moment={activeMoment.moment}
          tone={activeMoment.tone}
          assetUrls={assetUrls}
          character={characters.find(item => item.id === activeMoment.moment.characterId)}
          fontStyle={{ ...font.style, ...userFont.style, ...charFont.style }}
          onBack={() => setActiveMoment(null)}
          onShare={() => {
            if (activeMoment.moment.source === "chat") void openChatShot(activeMoment.moment);
            else setSharingMoment(activeMoment.moment);
          }}
          onDelete={() => {
            const target = activeMoment.moment;
            setActiveMoment(null);
            setDeleteCandidate(target);
          }}
        />
      ) : null}

      {chatShot ? (
        <ContentDialog
          title="聊天截图"
          confirmLabel="保存图片"
          cancelLabel="关闭"
          onConfirm={() => void saveChatShot()}
          onCancel={() => setChatShot(null)}
        >
          <div className="chat-capture-preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={chatShot.url} alt="聊天截图" />
          </div>
        </ContentDialog>
      ) : null}

      {sharingMoment ? (
        <ReadingShareDialog
          title="分享片段"
          filePrefix="片刻纪事"
          quoteParagraphs={sharingMoment.paragraphs}
          quoteSegments={[{ paragraphs: sharingMoment.paragraphs, speaker: sharingMoment.speaker }]}
          // 出处一行写成「《正篇》· 我 · 角色」，用两人本来的名字
          bookTitle={sourceLabel(sharingMoment)}
          bookAuthor={realNames(sharingMoment.characterId, sharingMoment.characterName)}
          chapterTitle=""
          progressPercent={0}
          progressLabel={momentDate(sharingMoment)}
          annotations={[]}
          signatureChoices={{
            char: charSignature(sharingMoment.characterId, sharingMoment.characterName),
            user: userSignature(sharingMoment.characterId),
            initial: sharingMoment.speaker === "user" ? "user" : "char",
          }}
          fonts={{ body: font.family, userAnnotation: font.family, charAnnotation: font.family }}
          speakerFonts={speakerFonts}
          onClose={() => setSharingMoment(null)}
        />
      ) : null}

      {deleteCandidate ? (
        <div
          className="nw-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="moment-delete-title"
          onClick={() => setDeleteCandidate(null)}
        >
          <section className="nw-delete-confirm" onClick={event => event.stopPropagation()}>
            <div className="nw-delete-confirm-icon">
              <Trash2 size={24} strokeWidth={1.8} />
            </div>
            <h2 id="moment-delete-title">删除这一段</h2>
            <p>只从片刻纪事里删掉，剧情里的原文不受影响。</p>
            <div>
              <button type="button" className="nw-secondary-btn" onClick={() => setDeleteCandidate(null)}>取消</button>
              <button type="button" className="nw-danger-btn" onClick={() => removeMoment(deleteCandidate)}>
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

/** 聊天里非文字的那条：收的时候原样截下来的小图 */
function MomentChatSnap({ line, url, scale = 1 }: { line: Extract<MomentChatLine, { kind: "snap" }>; url?: string; scale?: number }) {
  const width = Math.round(line.width * scale);
  const height = Math.round(line.height * scale);
  // eslint-disable-next-line @next/next/no-img-element
  return url
    ? <img className="moment-chat-snap" data-speaker={line.speaker} src={url} alt="" style={{ width }} />
    : <span className="moment-chat-snap" data-speaker={line.speaker} style={{ width, height }} />;
}

/** 片刻纪事详情：复用手记详情页那套版式（独立整页 + 卡片 + 底部按钮行） */
function MomentDetailPage({ moment, tone, assetUrls, character, fontStyle, onBack, onDelete, onShare }: {
  moment: Moment;
  /** 外面那张纸条的颜色：聊天气泡跟着它配色 */
  tone: PaperTone;
  assetUrls: Record<string, string>;
  character?: Character;
  fontStyle?: CSSProperties;
  onBack: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // 「喜欢」「小纸条」只是点亮状态，不入库（跟日记详情一致）
  const [liked, setLiked] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const authorName = character?.name || moment.characterName;
  const avatar = character?.avatar || "";
  const phone = character?.wechatID || character?.id || "";

  return (
    <section className="diary-app diary-entry-app diary-detail-page is-overlay" style={fontStyle}>
      {/* 详情页用普通顶部栏，品牌栏只出现在列表页 */}
      <header className="diary-app-header diary-entry-header diary-detail-header">
        <button type="button" className="diary-icon-btn" onClick={onBack} aria-label="返回">
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>{`${authorName} • 片刻`}</h1>
        </div>
        <span className="diary-header-spacer" />
      </header>

      <div className="diary-detail-scroll">
        <article className="diary-flat-card diary-detail-card">
          <div className="diary-flat-card-inner">
            <div className="diary-flat-card-author-row">
              <div className="diary-flat-card-avatar">
                {avatar ? <img src={avatar} alt={authorName} /> : <Bot size={18} />}
              </div>
              <div className="diary-flat-card-author-info">
                <span className="diary-flat-card-author-name">{authorName}</span>
                {phone ? <span className="diary-flat-card-author-id">@{phone}</span> : null}
              </div>
            </div>

            {moment.source === "chat" ? (
              // 点开以后：小气泡，颜色跟外面那张纸条；非文字的照聊天里原样
              <div className="moment-chat-bubbles" data-tone={tone}>
                {(moment.lines ?? []).map((line, index) => line.kind === "text"
                  ? <p key={index} className="moment-chat-bubble" data-speaker={line.speaker}>{line.text}</p>
                  : <MomentChatSnap key={index} line={line} url={assetUrls[line.asset]} />)}
              </div>
            ) : (
              <div className="diary-entry-blocks diary-detail-blocks" data-speaker={moment.speaker}>
                {moment.paragraphs.map((paragraph, index) => (
                  <p key={index} className="diary-entry-paragraph">{paragraph}</p>
                ))}
              </div>
            )}

            <div className="diary-flat-card-footer">
              <Clock3 size={13} className="diary-flat-clock-svg" aria-hidden="true" />
              <time className="diary-flat-card-time">{momentTimestamp(moment)}</time>
            </div>

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
              {/* 片刻纪事的分享就落在「存为图片」上 */}
              <button type="button" className="diary-detail-action" onClick={onShare}>
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
                      {/* 片刻纪事只能删，没有编辑 */}
                      <button
                        type="button"
                        role="menuitem"
                        className="is-danger"
                        onClick={() => { setMenuOpen(false); onDelete(); }}
                      >
                        删除
                      </button>
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

