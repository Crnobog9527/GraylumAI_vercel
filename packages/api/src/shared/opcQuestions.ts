/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export type InformationQuestion = { id: string; title: string; required: boolean };
export type QuestionAnswer = {
  value: string;
  status: "unknown" | "unclear" | "provisional" | "confirmed" | "deferred";
  nature: "fact" | "decision" | "hypothesis" | "unknown";
};
export const emptyAnswer: QuestionAnswer = { value: "", status: "unknown", nature: "unknown" };

/** Text (including a mentor suggestion) is not a user's confirmation. */
export function questionIsConfirmed(answer: QuestionAnswer | undefined) {
  return Boolean(answer?.value.trim() && ["confirmed", "deferred"].includes(answer.status));
}
export function nextInformationQuestion(
  schema: readonly InformationQuestion[],
  values: Record<string, QuestionAnswer> | null | undefined = {},
) {
  const answers = values ?? {};
  return schema.find(field => !questionIsConfirmed(answers[field.id]));
}
/** Only previously reached questions and the current question are navigable. */
export function reachedQuestions(
  schema: readonly InformationQuestion[],
  values: Record<string, QuestionAnswer> | null | undefined = {},
) {
  const answers = values ?? {};
  const next = schema.findIndex(field => !questionIsConfirmed(answers[field.id]));
  return next < 0 ? schema : schema.slice(0, next + 1);
}
export function displayedQuestion(
  schema: readonly InformationQuestion[],
  values: Record<string, QuestionAnswer> | null | undefined = {},
  selectedId?: string,
) {
  return reachedQuestions(schema, values).find(field => field.id === selectedId)
    ?? nextInformationQuestion(schema, values) ?? schema.at(-1);
}
export function confirmQuestionValues(
  schema: readonly InformationQuestion[],
  current: Record<string, QuestionAnswer>,
  questionId: string,
  defer = false,
) {
  const field = reachedQuestions(schema, current).find(item => item.id === questionId);
  if (!field) throw new Error("OPC_QUESTION_NOT_REACHED");
  const values = Object.fromEntries(schema.map(item => [item.id, { ...(current[item.id] ?? emptyAnswer) }]));
  const answer = values[questionId];
  const value = answer.value.trim();
  if (!value && (!defer || field.required)) throw new Error("OPC_QUESTION_ANSWER_REQUIRED");
  values[questionId] = {
    ...answer,
    value: value || "用户明确选择暂不提供此选填信息。",
    status: defer ? "deferred" : "confirmed",
  };
  return { values, finishStep: schema.every(item => questionIsConfirmed(values[item.id])) };
}
