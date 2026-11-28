import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import {
  INTERVIEW_MAGAZINE_DEFAULT_EDITOR_PROMPT,
  INTERVIEW_MAGAZINE_DEFAULT_MEMORY_PROMPT,
  type InterviewDraft,
  type InterviewIssue,
} from "./interview-magazine-types";

const INTERVIEW_ISSUES_KEY = "ai_phone_interview_magazine_issues_v1";
const INTERVIEW_DRAFTS_KEY = "ai_phone_interview_magazine_drafts_v1";
// 改造前这里存的是「AI 主持人提示词」。主持人改由用户担任后不再读取该键的值，
// 只保留登记以便旧数据随 KV 迁移流程走。
const INTERVIEW_LEGACY_HOST_PROMPT_KEY = "ai_phone_interview_magazine_host_prompt_v1";
const INTERVIEW_EDITOR_PROMPT_KEY = "ai_phone_interview_magazine_editor_prompt_v1";
const INTERVIEW_MEMORY_PROMPT_KEY = "ai_phone_interview_magazine_memory_prompt_v1";
registerKvMigration(INTERVIEW_ISSUES_KEY);
registerKvMigration(INTERVIEW_DRAFTS_KEY);
registerKvMigration(INTERVIEW_LEGACY_HOST_PROMPT_KEY);
registerKvMigration(INTERVIEW_EDITOR_PROMPT_KEY);
registerKvMigration(INTERVIEW_MEMORY_PROMPT_KEY);

function sortIssues(issues: InterviewIssue[]): InterviewIssue[] {
  return [...issues].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function sortDrafts(drafts: InterviewDraft[]): InterviewDraft[] {
  return [...drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadInterviewIssues(): InterviewIssue[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(INTERVIEW_ISSUES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return sortIssues(parsed.filter(isInterviewIssue));
  } catch {
    return [];
  }
}

export function saveInterviewIssue(issue: InterviewIssue): InterviewIssue[] {
  const issues = loadInterviewIssues();
  const next = sortIssues([
    issue,
    ...issues.filter((item) => item.id !== issue.id),
  ]);
  kvSet(INTERVIEW_ISSUES_KEY, JSON.stringify(next));
  return next;
}

export function deleteInterviewIssue(issueId: string): InterviewIssue[] {
  const next = loadInterviewIssues().filter((issue) => issue.id !== issueId);
  kvSet(INTERVIEW_ISSUES_KEY, JSON.stringify(next));
  return next;
}

export function loadInterviewDrafts(): InterviewDraft[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(INTERVIEW_DRAFTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return sortDrafts(parsed.filter(isInterviewDraft));
  } catch {
    return [];
  }
}

export function saveInterviewDraft(draft: InterviewDraft): InterviewDraft[] {
  const drafts = loadInterviewDrafts();
  const next = sortDrafts([
    draft,
    ...drafts.filter((item) => item.id !== draft.id),
  ]);
  kvSet(INTERVIEW_DRAFTS_KEY, JSON.stringify(next));
  return next;
}

export function deleteInterviewDraft(draftId: string): InterviewDraft[] {
  const next = loadInterviewDrafts().filter((draft) => draft.id !== draftId);
  kvSet(INTERVIEW_DRAFTS_KEY, JSON.stringify(next));
  return next;
}

export function getNextInterviewIssueNumber(): number {
  const issues = loadInterviewIssues();
  const max = issues.reduce((largest, issue) => Math.max(largest, issue.issueNumber || 0), 0);
  return max + 1;
}

export function loadInterviewEditorPrompt(): string {
  if (typeof window === "undefined") return INTERVIEW_MAGAZINE_DEFAULT_EDITOR_PROMPT;
  try {
    return kvGet(INTERVIEW_EDITOR_PROMPT_KEY)?.trim() || INTERVIEW_MAGAZINE_DEFAULT_EDITOR_PROMPT;
  } catch {
    return INTERVIEW_MAGAZINE_DEFAULT_EDITOR_PROMPT;
  }
}

export function saveInterviewEditorPrompt(prompt: string): string {
  const next = prompt.trim() || INTERVIEW_MAGAZINE_DEFAULT_EDITOR_PROMPT;
  kvSet(INTERVIEW_EDITOR_PROMPT_KEY, next);
  return next;
}

/** @deprecated 主持人已改由用户担任，保留别名仅为兼容旧引用。 */
export const loadInterviewHostPrompt = loadInterviewEditorPrompt;
/** @deprecated 同上。 */
export const saveInterviewHostPrompt = saveInterviewEditorPrompt;

export function loadInterviewMemoryPrompt(): string {
  if (typeof window === "undefined") return INTERVIEW_MAGAZINE_DEFAULT_MEMORY_PROMPT;
  try {
    const raw = kvGet(INTERVIEW_MEMORY_PROMPT_KEY);
    const trimmed = raw?.trim();
    return trimmed || INTERVIEW_MAGAZINE_DEFAULT_MEMORY_PROMPT;
  } catch {
    return INTERVIEW_MAGAZINE_DEFAULT_MEMORY_PROMPT;
  }
}

export function saveInterviewMemoryPrompt(prompt: string): string {
  const next = prompt.trim() || INTERVIEW_MAGAZINE_DEFAULT_MEMORY_PROMPT;
  kvSet(INTERVIEW_MEMORY_PROMPT_KEY, next);
  return next;
}

function isInterviewIssue(value: unknown): value is InterviewIssue {
  if (!value || typeof value !== "object") return false;
  const issue = value as Partial<InterviewIssue>;
  return (
    typeof issue.id === "string"
    && typeof issue.theme === "string"
    && typeof issue.characterId === "string"
    && typeof issue.characterName === "string"
    && typeof issue.createdAt === "string"
    && Array.isArray(issue.transcript)
    && Boolean(issue.article)
  );
}

function isInterviewDraft(value: unknown): value is InterviewDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<InterviewDraft>;
  return (
    typeof draft.id === "string"
    && typeof draft.theme === "string"
    && Array.isArray(draft.characterIds)
    && Array.isArray(draft.characterNames)
    && Array.isArray(draft.transcript)
    && typeof draft.characterRounds === "number"
    && (draft.status === "paused" || draft.status === "error" || draft.status === "awaiting_user" || draft.status === "done")
    && typeof draft.createdAt === "string"
    && typeof draft.updatedAt === "string"
  );
}
