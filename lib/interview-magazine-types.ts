export const INTERVIEW_MAGAZINE_APP_ID = "interview_magazine" as const;
export const INTERVIEW_MAGAZINE_TITLE = "PRESENCE";
export const INTERVIEW_MAGAZINE_TITLE_CN = "在场";
// 主持人由用户本人担任，App 内不再有 AI 主持人，也不再生成开场白与追问。
// 这条提示词只服务于「结稿成刊」：把主持人（{{user}}）与嘉宾的实录整理成杂志专栏。
export const INTERVIEW_MAGAZINE_DEFAULT_EDITOR_PROMPT = [
  "你是杂志《在场 PRESENCE》的编辑，负责把主持人{{user}}与嘉宾{{interviewGuests}}的对谈整理成一篇杂志专栏。",
  "本期主题：{{interviewTheme}}。",
  "你只做编辑工作：不改写事实、不替任何人补答、不虚构实录里没有出现的观点、场景或情绪。",
  "行文保持杂志采访的质地：具体、克制、有细节，允许引用实录中的原话。",
].join("\n");
export const INTERVIEW_MAGAZINE_DEFAULT_MEMORY_PROMPT = [
  "请为这期访谈生成一条会写入短期记忆的摘要。",
  "摘要用于后续角色上下文，不是刊物文案；请用第三人称、事实性描述。",
  "必须保留本期主题、访谈对象、主持人的关键提问、关键观点，以及关系或态度上的变化。",
  "凡是指代主持人或用户本人时，一律写成 {{user}}，不要写具体姓名。",
  "不要使用任何系统、配置或模型相关术语。",
  "80-180 个中文字，不要标题、列表、JSON 或格式标记。",
].join("\n");

export type InterviewTarget = "character" | "user";

export type InterviewMessage = {
  id: string;
  // 主持人由用户担任，新实录里主持人的发言一律记作 user；
  // host 仅用于兼容改造前存下的草稿与往期，新代码不再产生。
  role: "host" | "character" | "user";
  content: string;
  kind?: "intro" | "question" | "answer" | "outro";
  target?: InterviewTarget;
  targetCharacterId?: string;
  targetCharacterName?: string;
  speakerCharacterId?: string;
  speakerName?: string;
  createdAt: string;
};

export type InterviewCharacterSnapshot = {
  id: string;
  name: string;
  avatar: string | null;
  persona: string;
  personality?: string;
  tags: string[];
};

export type InterviewUserSnapshot = {
  name: string;
  gender?: string;
  age?: string;
  occupation?: string;
  bio?: string;
  customSettings?: string;
};

export type InterviewWorldBookSnapshot = {
  id: string;
  name: string;
  entries: {
    key: string;
    comment: string;
    content: string;
  }[];
};

export type InterviewGuestSnapshot = {
  characterId: string;
  characterName: string;
  characterSnapshot: InterviewCharacterSnapshot;
  worldBookSnapshot: InterviewWorldBookSnapshot[];
};

export type InterviewQaItem = {
  q: string;
  a: string;
};

export type InterviewArticle = {
  title: string;
  subtitle: string;
  body: string[];
  pullQuote: string;
  qa: InterviewQaItem[];
  memorySummary?: string;
};

export type InterviewIssue = {
  id: string;
  issueNumber: number;
  theme: string;
  characterIds?: string[];
  characterNames?: string[];
  characterId: string;
  characterName: string;
  userName: string;
  userIdentityId?: string;
  guestSnapshots?: InterviewGuestSnapshot[];
  characterSnapshot: InterviewCharacterSnapshot;
  userSnapshot: InterviewUserSnapshot | null;
  worldBookSnapshot: InterviewWorldBookSnapshot[];
  transcript: InterviewMessage[];
  article: InterviewArticle;
  createdAt: string;
  updatedAt: string;
};

export type InterviewDraftStatus = "paused" | "error" | "awaiting_user" | "done";

export type InterviewDraft = {
  id: string;
  theme: string;
  characterIds: string[];
  characterNames: string[];
  userIdentityId?: string;
  userName?: string;
  transcript: InterviewMessage[];
  characterRounds: number;
  status: InterviewDraftStatus;
  resumeAction?: unknown;
  userInput?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
