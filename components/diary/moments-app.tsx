"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Bookmark, Bot, Clock3, Heart, Share, Trash2, X } from "lucide-react";

import { ReadingShareDialog } from "@/components/reading/reading-share-dialog";
import { ContentDialog } from "@/components/ui/modal";
import { downloadFile } from "@/lib/download-utils";
import type { DiaryFontKind } from "@/lib/diary-entry-types";
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
  saveMomentAvatar,
  saveMomentProfiles,
  type Moment,
  type MomentChatLine,
  type MomentProfileOwner,
  type MomentProfiles,
} from "@/lib/moment-storage";
import { READING_AVATAR_MAX_SIZE, compressReadingImage } from "@/lib/reading-image";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { DiaryBrandHeader, type DiaryBrandView } from "./diary-brand-header";
import { useDiaryFont } from "./use-diary-font";
import { useDragToTrash } from "./use-drag-to-trash";

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

/** 封面上的月.日；书只有手机半屏宽，带年份的话左边的段数会被挤成省略号 */
function formatMonthDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
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

/** 片刻纪事那三份字体 */
type MomentFontKind = Extract<DiaryFontKind, "moment" | "moment-user" | "moment-char">;

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
  const [fontPanelOpen, setFontPanelOpen] = useState(false);
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  const [profiles, setProfiles] = useState<MomentProfiles>(() => ({ user: { name: "" }, characters: {}, userByCharacter: {} }));
  // 自己设的署名头像（阅读图片库里的 blob → objectURL），没设的不在这里
  const [profileAvatars, setProfileAvatars] = useState<Record<MomentProfileOwner, string>>({});
  // 拖拽删除锁的是列表滚动容器（整块 main）
  const mainRef = useRef<HTMLElement | null>(null);
  const fontFileRef = useRef<HTMLInputElement | null>(null);
  /** 三份字体共用一个文件选择框，点了哪一份就传给哪一份 */
  const fontTargetRef = useRef<MomentFontKind>("moment");

  const notify = useCallback((message: string) => {
    onNotice?.(message);
  }, [onNotice]);

  // 系统字体：片刻纪事里所有的字；聊天里收的「我」/角色说的话另用自己的（没传就跟系统字体走）
  const font = useDiaryFont("moment", notify);
  const userFont = useDiaryFont("moment-user", notify);
  const charFont = useDiaryFont("moment-char", notify);
  const fontsByKind = { moment: font, "moment-user": userFont, "moment-char": charFont } as const;
  /** 画分享图用的真实字体名：我 / 角色那份没传就是系统字体 */
  const speakerFonts = {
    user: userFont.hasCustomFont ? userFont.family : font.family,
    char: charFont.hasCustomFont ? charFont.family : font.family,
  };
  const trash = useDragToTrash<Moment>({
    // 列表页一直可拖（原来这里要求先进某个本子，书架删掉后条件恒为假，拖拽会整个失效）
    enabled: true,
    scrollRef: mainRef,
    onDrop: setDeleteCandidate,
  });

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
  /** 分享图出处那行「《正篇》· 我 · 角色」：写两人本来的名字（身份里的名字、角色名），不用署名 ID */
  const realNames = useCallback((characterId: string, fallbackName: string) => {
    const character = characters.find(item => item.id === characterId);
    return `${storyIdentity(characterId)?.name?.trim() || "我"} · ${character?.name || fallbackName}`;
  }, [characters]);
  const userSignature = useCallback((characterId: string) => {
    const base = userBase(characterId);
    return {
      name: profiles.userByCharacter[characterId]?.name || base.name,
      avatar: profileAvatars[momentUserOwner(characterId)] || base.avatar,
    };
  }, [profileAvatars, profiles, userBase]);

  return (
    <section className={`diary-app diary-entry-app ${trash.drag ? "is-entry-dragging" : ""}`} style={{ ...font.style, ...userFont.style, ...charFont.style }}>
      <input
        ref={fontFileRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2,font/*,application/font-woff,application/font-woff2"
        className="hidden"
        onChange={event => void fontsByKind[fontTargetRef.current].upload(event)}
      />
      <DiaryBrandHeader
        view="moments"
        onClose={onClose}
        onSwitch={onSwitch}
        avatarLabel="署名设置"
        onAvatarClick={() => setProfilePanelOpen(true)}
      >
        <button
          type="button"
          className="note-wall-menu-btn diary-font-upload-btn"
          onClick={() => setFontPanelOpen(true)}
          aria-label="片刻纪事字体设置"
          title="片刻纪事字体设置"
        >
          <span className="diary-font-upload-mark" aria-hidden="true">Aa</span>
        </button>
      </DiaryBrandHeader>

      {/* Bookmark 标签跟着内容一起滚：整块 main 就是滚动区，上沿从顶部栏下边线开始 */}
      <main ref={mainRef} className="diary-entry-main diary-moment-main">
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

      {fontPanelOpen ? (
        <MomentFontPanel
          tiers={[
            { kind: "moment", title: "系统字体", hint: "其它所有的字", custom: font.hasCustomFont },
            { kind: "moment-user", title: "我的字体", hint: "剧情、聊天里我说的话", custom: userFont.hasCustomFont },
            { kind: "moment-char", title: "角色字体", hint: "聊天里角色说的话；分享图里可选", custom: charFont.hasCustomFont },
          ]}
          scale={font.scale}
          onUpload={(kind) => {
            fontTargetRef.current = kind;
            fontFileRef.current?.click();
          }}
          onReset={kind => fontsByKind[kind].reset()}
          onScaleChange={font.changeScale}
          onClose={() => setFontPanelOpen(false)}
        />
      ) : null}

      {activeMoment ? (
        <MomentDetailPage
          moment={activeMoment.moment}
          tone={activeMoment.tone}
          assetUrls={assetUrls}
          character={characters.find(item => item.id === activeMoment.moment.characterId)}
          fontStyle={{ ...font.style, ...userFont.style, ...charFont.style }}
          onClose={onClose}
          onSwitch={onSwitch}
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

      {profilePanelOpen ? (
        <MomentProfilePanel
          characters={characters}
          profiles={profiles}
          avatars={profileAvatars}
          onClose={() => setProfilePanelOpen(false)}
          notify={notify}
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

      <div
        ref={trash.trashRef}
        className={`diary-entry-trash-bin ${trash.drag ? "is-visible" : ""} ${trash.drag?.isOverTrash ? "is-over" : ""}`}
        aria-hidden={!trash.drag}
      >
        <Trash2 size={30} strokeWidth={1.8} />
      </div>

      {trash.drag ? (
        <div
          className="diary-entry-card moment-card diary-entry-drag-ghost"
          style={{
            left: trash.drag.x,
            top: trash.drag.y,
            width: trash.drag.width,
            minHeight: trash.drag.height,
          }}
        >
          <MomentCardContent moment={trash.drag.item} assetUrls={assetUrls} />
        </div>
      ) : null}
    </section>
  );
}

function MomentBookCover({ book, onOpen }: { book: MomentBook; onOpen: () => void }) {
  const latest = book.moments[0];
  return (
    <button
      type="button"
      className="diary-book"
      data-cover={hashText(book.characterId) % BOOK_COVER_COUNT}
      onClick={onOpen}
    >
      <span className="diary-book-spine" aria-hidden="true" />
      <span className="diary-book-frame" aria-hidden="true" />
      <span className="diary-book-label">
        <span className="diary-book-avatar">
          {book.avatar ? <img src={book.avatar} alt="" /> : <Bot size={20} />}
        </span>
        <strong>{book.characterName}</strong>
        <em>的片刻纪事</em>
      </span>
      <span className="diary-book-meta">
        <span>{book.moments.length} 段</span>
        <time>{formatMonthDay(latest.createdAt)}</time>
      </span>
    </button>
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

function MomentCardContent({ moment, assetUrls }: { moment: Moment; assetUrls: Record<string, string> }) {
  if (moment.source === "chat") {
    const lines = moment.lines ?? [];
    // 纸条外面：他靠左、我靠右，不加框，放前几条，多了渐隐
    return (
      <>
        <span className="diary-entry-card-kicker">CHAT</span>
        <span className="diary-entry-card-markers">
          <span className="diary-entry-marker">{sourceLabel(moment)}</span>
        </span>
        <span className={`moment-chat-lines${lines.length > 5 || moment.paragraphs.join("").length > 70 ? " is-clipped" : ""}`}>
          {lines.slice(0, 6).map((line, index) => line.kind === "text"
            ? <span key={index} className="moment-chat-line" data-speaker={line.speaker}>{line.text}</span>
            : <MomentChatSnap key={index} line={line} url={assetUrls[line.asset]} scale={0.6} />)}
        </span>
        <span className="diary-entry-card-meta">
          <span>{lines.length} 条</span>
          <time>{momentDate(moment)}</time>
        </span>
      </>
    );
  }
  return (
    <>
      <span className="diary-entry-card-kicker">{moment.source === "extra" ? "EXTRA" : "STORY"}</span>
      <span className="diary-entry-card-markers">
        <span className="diary-entry-marker">{sourceLabel(moment)}</span>
      </span>
      <span className="diary-entry-card-text" data-speaker={moment.speaker}>{clipText(moment.paragraphs.join(" "), 130)}</span>
      <span className="diary-entry-card-meta">
        <span>{moment.speakerName}</span>
        <time>{momentDate(moment)}</time>
      </span>
    </>
  );
}

/** 片刻纪事详情：复用手记详情页那套版式（独立整页 + 卡片 + 底部按钮行） */
function MomentDetailPage({ moment, tone, assetUrls, character, fontStyle, onClose, onSwitch, onBack, onDelete, onShare }: {
  moment: Moment;
  /** 外面那张纸条的颜色：聊天气泡跟着它配色 */
  tone: PaperTone;
  assetUrls: Record<string, string>;
  character?: Character;
  fontStyle?: CSSProperties;
  /** 顶部栏 iFloat 回桌面 */
  onClose: () => void;
  /** 顶部栏星星/铃铛切换页面 */
  onSwitch: (view: DiaryBrandView) => void;
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
      <DiaryBrandHeader
        view="moments"
        onClose={onClose}
        onSwitch={onSwitch}
        avatarLabel="返回列表"
        onAvatarClick={onBack}
      />

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

/** 片刻纪事的字体：系统 / 我 / 角色三份各自上传，字号共用一个 */
function MomentFontPanel({ tiers, scale, onUpload, onReset, onScaleChange, onClose }: {
  tiers: Array<{ kind: MomentFontKind; title: string; hint: string; custom: boolean }>;
  scale: number;
  onUpload: (kind: MomentFontKind) => void;
  onReset: (kind: MomentFontKind) => void;
  onScaleChange: (scale: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-font-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>片刻纪事字体</h2>
            <p>我的、角色的没上传就和系统字体一样</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="moment-font-tiers">
          {tiers.map(tier => (
            <div key={tier.kind} className="moment-font-tier">
              <span>
                <strong>{tier.title}</strong>
                <em>{tier.custom ? "已上传" : tier.kind === "moment" ? "默认手写体" : "跟系统字体"} · {tier.hint}</em>
              </span>
              <button type="button" onClick={() => onUpload(tier.kind)}>上传</button>
              {tier.custom ? <button type="button" onClick={() => onReset(tier.kind)}>恢复</button> : null}
            </div>
          ))}
        </div>

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
      </section>
    </div>
  );
}

/** 署名设置：最外面是自己 + 所有角色；点进某一本就只管这个角色（和日记的定时设置一样分两层） */
function MomentProfilePanel({ characters, bookCharacterName, bookUser, profiles, avatars, onClose, notify }: {
  characters: Character[];
  bookCharacterName?: string;
  /** 在某一本里：自己这一行改的是这一本单独的，空着就用 fallback（外面设的） */
  bookUser?: { characterId: string; fallback: { name: string; avatar?: string } };
  profiles: MomentProfiles;
  avatars: Record<MomentProfileOwner, string>;
  onClose: () => void;
  notify: (message: string) => void;
}) {
  const [draft, setDraft] = useState(profiles);
  const save = (next: MomentProfiles) => {
    setDraft(next);
    saveMomentProfiles(next);
  };
  const setCharacterName = (characterId: string, name: string) => {
    const characters = { ...draft.characters };
    if (name.trim()) characters[characterId] = { name };
    else delete characters[characterId];
    save({ ...draft, characters });
  };
  const setBookUserName = (characterId: string, name: string) => {
    const userByCharacter = { ...draft.userByCharacter };
    if (name.trim()) userByCharacter[characterId] = { name };
    else delete userByCharacter[characterId];
    save({ ...draft, userByCharacter });
  };
  const pickAvatar = async (owner: MomentProfileOwner, file: File | null) => {
    try {
      await saveMomentAvatar(owner, file ? await compressReadingImage(file, READING_AVATAR_MAX_SIZE) : null);
    } catch (error) {
      notify("头像保存失败：" + String(error));
    }
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>{bookCharacterName ? `${bookCharacterName} 的署名` : "署名"}</h2>
            <p>{bookUser ? "只用在这一本。我的不填就用外面设的。" : "分享摘抄时用的 ID 和头像。不填就用原来的名字和头像。"}</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="moment-profile-list">
          {bookUser ? (
            <MomentProfileRow
              label="我"
              placeholder={bookUser.fallback.name}
              name={draft.userByCharacter[bookUser.characterId]?.name ?? ""}
              avatar={avatars[momentUserOwner(bookUser.characterId)]}
              fallbackAvatar={bookUser.fallback.avatar}
              initial="我"
              onName={name => setBookUserName(bookUser.characterId, name)}
              onAvatar={file => void pickAvatar(momentUserOwner(bookUser.characterId), file)}
            />
          ) : (
            <MomentProfileRow
              label="我"
              placeholder="默认用你在这个角色那里的身份名"
              name={draft.user.name}
              avatar={avatars.user}
              initial="我"
              onName={name => save({ ...draft, user: { name } })}
              onAvatar={file => void pickAvatar("user", file)}
            />
          )}
          {characters.map(character => (
            <MomentProfileRow
              key={character.id}
              label={character.name}
              placeholder={character.name}
              name={draft.characters[character.id]?.name ?? ""}
              avatar={avatars[character.id]}
              fallbackAvatar={character.avatar || undefined}
              initial={Array.from(character.name)[0] || "?"}
              onName={name => setCharacterName(character.id, name)}
              onAvatar={file => void pickAvatar(character.id, file)}
            />
          ))}
        </div>
      </section>
    </div>
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
