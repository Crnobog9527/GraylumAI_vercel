/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Exact suffix deduplication only: never remove merely similar or partially overlapping prose. */
export function mentorText(assistant: string, message: string): string {
  const before = assistant.trim(), after = message.trim();
  return !before ? after : !after || before.endsWith(after) ? before : before + '\n\n' + after;
}

/** A possible repeated suffix is buffered until disambiguated, without replacing assistant prose. */
export function streamingMentorText(assistant: string, message: string): string {
  const after = message.trimStart();
  if (!assistant) return after;
  if (!after || assistant.includes(after.trimEnd())) return assistant;
  return assistant + '\n\n' + after;
}
