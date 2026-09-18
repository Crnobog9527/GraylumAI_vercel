/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Server-side compatibility boundary; the implementation is pure and web-safe.
export {
  confirmQuestionValues,
  displayedQuestion,
  emptyAnswer,
  isOpeningInput,
  isRecordedNonAnswer,
  nextInformationQuestion,
  openingEntryKey,
  openingRequestId,
  questionIsConfirmed,
  questionLabel,
  questionPosition,
  questionTask,
  reachedQuestions,
  taskIsOpening,
  taskQuestionId,
  OPENING_INPUT,
} from "../../shared/opcQuestions";
export type { InformationQuestion, QuestionAnswer } from "../../shared/opcQuestions";
export { elicitFieldSpecs, fieldElicitation, isAgentProposal } from "../../shared/opcMethodPolicy";
export type { Elicitation } from "../../shared/opcMethodPolicy";
