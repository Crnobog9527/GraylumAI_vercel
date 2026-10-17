/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** CONTENT-CONVERSATION-DRIVEN A2: fixed messages for a derived-content turn that cannot read its source (#621 4.3). */
export const CONTENT_SOURCE_MESSAGES = {
  RUNTIME_CONTENT_SOURCE_MISSING: '这个选题还没有可用的来源稿件：生成分镜需要先定稿口播稿，生成剪辑建议需要先保存分镜。',
  RUNTIME_CONTENT_SOURCE_STALE: '当前分镜基于旧版口播稿，请先更新分镜，再生成剪辑建议。',
  RUNTIME_CONTENT_SOURCE_TOO_LARGE: '来源稿件太长，无法基于全文生成，请先精简或分段。',
} as const;
