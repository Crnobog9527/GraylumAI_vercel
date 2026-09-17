/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Server-side compatibility boundary; the implementation is pure and web-safe.
export {
  confirmQuestionValues,
  displayedQuestion,
  emptyAnswer,
  nextInformationQuestion,
  questionIsConfirmed,
  reachedQuestions,
} from "../../shared/opcQuestions";
export type { InformationQuestion, QuestionAnswer } from "../../shared/opcQuestions";
