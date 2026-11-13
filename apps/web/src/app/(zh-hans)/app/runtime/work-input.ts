/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** How a work item's protocol messages read, on either path. */
// Presentation only: preserve the immutable Runtime request/result for replay.
export function displayReply(input: string | null, body: string | null) {
  if (!body) return '正在核实结果，请保留原任务。';
  const fenced = body.match(/```json\s*([\s\S]*?)\s*```/);
  const json = (fenced?.[1] ?? body).trim();
  if (json.startsWith('[')) {
    try {
      const topics = JSON.parse(json);
      if (
        Array.isArray(topics) &&
        topics.length > 0 &&
        topics.every(
          topic =>
            topic &&
            typeof topic.title === 'string' &&
            typeof topic.brief === 'string' &&
            typeof topic.platform === 'string' &&
            typeof topic.account === 'string'
        )
      )
        return [
          fenced ? body.slice(0, fenced.index).trim() : '',
          ...topics.map((topic, index) => `${index + 1}. ${topic.title}\n${topic.platform} · ${topic.account}\n${topic.brief}`)
        ]
          .filter(Boolean)
          .join('\n\n');
    } catch {
      /* A non-topic reply stays verbatim. */
    }
  }
  if (!input?.startsWith('[OPC_VIDEO_PACKAGE_V1]')) return body;
  try {
    const value = JSON.parse(body);
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['storyboard', 'editing'].includes(key))) {
      const parts = [];
      if (typeof value.storyboard === 'string') parts.push('分镜脚本\n' + value.storyboard);
      if (typeof value.editing === 'string') parts.push('剪辑建议\n' + value.editing);
      if (parts.length) return parts.join('\n\n');
    }
  } catch {
    /* Incomplete output stays recoverable; protocol text is not conversation. */
  }
  return '生成结果尚未整理完成，请保留原任务并恢复核对。';
}
/** What the transcript shows for a stored input: protocol markers become the user's plain request. */
export function shownRuntimeInput(input: string) {
  if (!input.startsWith('[OPC_VIDEO_PACKAGE_V1]')) return input.replace(/^\[OPC_SCRIPT_V1\]\s*/, '');
  return input.includes('只生成分镜脚本')
    ? '请基于已定稿口播稿生成分镜脚本。'
    : input.includes('只生成剪辑建议')
      ? '请基于已保存的分镜生成剪辑建议。'
      : '请先完成分镜脚本，再基于分镜生成剪辑建议。';
}
