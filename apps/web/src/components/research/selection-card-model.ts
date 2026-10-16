/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Selection cards (RESEARCH_TOOLS_PLAN.md §1.6). Shapes mirror the host card functions of RT-3b
// (`research_card_create` / `research_card_confirm`): the host owns options and limits, the page only builds a
// submission the host checks again. A keyword card takes picks, edits and additions; a candidate card takes
// option ids only.
import type {
  ResearchCandidateOption, ResearchSelectionCard,
} from "../../../../../packages/api/src/shared/researchTurn";

/** Same bounds as the host: keywords are 1–40 characters without control characters. */
export const KEYWORD_MAX_CHARS = 40;

/** The card the stream sends (`research_card`); `selectable` is false for head references. */
export type SelectionCard = ResearchSelectionCard;
export type KeywordCard = Extract<SelectionCard, { kind: "keywords" }>;
export type CandidateCard = Extract<SelectionCard, { kind: "candidates" }>;
export type KeywordOption = KeywordCard["options"][number];
export type CandidateOption = ResearchCandidateOption;

export type ConfirmedCandidate = Omit<CandidateOption, "label" | "selectable">;
export type CardConfirmation =
  | { cardId: string; confirmationId: string; kind: "keywords"; items: string[] }
  | { cardId: string; confirmationId: string; kind: "candidates"; items: ConfirmedCandidate[] };

export interface KeywordSubmission { selected: string[]; edits?: Record<string, string>; additions?: string[] }
export interface CandidateSubmission { selected: string[] }

const chars = (value: string) => [...value].length;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why one keyword cannot be sent, or null when it can. */
export function keywordProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "关键词不能为空";
  if (chars(trimmed) > KEYWORD_MAX_CHARS) return `每个关键词最多 ${KEYWORD_MAX_CHARS} 个字`;
  if (CONTROL.test(trimmed)) return "关键词里有不能识别的字符";
  return null;
}

export interface KeywordDraft {
  /** Option ids the user keeps, in any order. */
  selected: string[];
  /** Current text per option id (starts as the host's text). */
  texts: Record<string, string>;
  additions: string[];
}

export const initialKeywordDraft = (card: KeywordCard): KeywordDraft => ({
  selected: card.options.map(option => option.id),
  texts: Object.fromEntries(card.options.map(option => [option.id, option.text])),
  additions: [],
});

/** The final keywords in the host's order: kept options (edited) first, then additions. */
export function keywordItems(card: KeywordCard, draft: KeywordDraft): string[] {
  const kept = card.options.filter(option => draft.selected.includes(option.id))
    .map(option => (draft.texts[option.id] ?? option.text).trim());
  return [...kept, ...draft.additions.map(item => item.trim())];
}

/** The submission for the host, or the first problem the user has to fix. Edits are sent only when changed. */
export function buildKeywordSubmission(card: KeywordCard, draft: KeywordDraft):
  { ok: true; submission: KeywordSubmission } | { ok: false; problem: string } {
  const items = keywordItems(card, draft);
  if (items.length < card.minSelect) return { ok: false, problem: `至少保留 ${card.minSelect} 个关键词` };
  if (items.length > card.maxSelect) return { ok: false, problem: `最多 ${card.maxSelect} 个关键词` };
  for (const item of items) {
    const problem = keywordProblem(item);
    if (problem) return { ok: false, problem };
  }
  if (new Set(items.map(item => item.toLowerCase())).size !== items.length) return { ok: false, problem: "关键词有重复" };
  const selected = card.options.filter(option => draft.selected.includes(option.id)).map(option => option.id);
  const edits: Record<string, string> = {};
  for (const option of card.options) {
    const current = (draft.texts[option.id] ?? option.text).trim();
    if (selected.includes(option.id) && current !== option.text) edits[option.id] = current;
  }
  const additions = draft.additions.map(item => item.trim());
  return {
    ok: true,
    submission: {
      selected,
      ...(Object.keys(edits).length > 0 ? { edits } : {}),
      ...(additions.length > 0 ? { additions } : {}),
    },
  };
}

/** Candidate cards: only selectable option ids, within the host's limits. */
export function buildCandidateSubmission(card: CandidateCard, selected: string[]):
  { ok: true; submission: CandidateSubmission } | { ok: false; problem: string } {
  const allowed = card.options.filter(option => option.selectable && selected.includes(option.id)).map(option => option.id);
  if (allowed.length < card.minSelect) return { ok: false, problem: `至少选 ${card.minSelect} 个` };
  if (allowed.length > card.maxSelect) return { ok: false, problem: `最多选 ${card.maxSelect} 个` };
  return { ok: true, submission: { selected: allowed } };
}

/** Stable error codes from the card functions → what the user reads. Anything else is generic. */
export function cardErrorText(code: string | undefined): string {
  switch (code) {
    case "RESEARCH_CARD_ALREADY_CONFIRMED": return "这张卡已经确认过了，不能再改。";
    case "RESEARCH_CARD_INVALID": return "提交的内容不符合要求，请检查后再确认。";
    case "RESEARCH_SCOPE_DENIED": return "这张卡不属于当前对话。";
    default: return "确认没有成功，请稍后再试。";
  }
}
