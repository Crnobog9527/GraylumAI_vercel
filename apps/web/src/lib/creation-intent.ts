/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/*
 * CONTENT-CONVERSATION-DRIVEN: a cheap code gate in front of the model's Skill matching in free chat.
 * Owner 2026-10-23: "自由对话自动选 Skill 按方案 C：先用代码判断消息像不像创作需求，像的时候才调用模型匹配。"
 *
 * This decides only WHETHER the paid matching call is made, never WHICH Skill runs: the model still chooses among the
 * published Skills' public descriptions (or none). A message that does not look like a creation request is answered as
 * ordinary chat (no matching fee, no extra wait); a missed one costs nothing but the user can always load a Skill by
 * hand from the Skill menu. The pattern is deliberately broad, since a false "yes" costs one small matching call
 * while a false "no" only loses the automatic pick.
 */
const MAX_SCANNED = 4000;
// Chinese: creation verbs and the things people ask Skills for.
const ZH = new RegExp([
  '写|撰|改写|润色|扩写|续写|起草|编写|创作|重写|重新写|缩短|精简',
  '[换再]?来一[版条篇个段]|换一[版条篇个段]|出一[版条篇个段]',
  '生成.{0,6}(?:文|稿|案|本|题|标题|脚本)',
  '口播|文案|脚本|分镜|剪辑|标题|选题|话题|稿子?|文章|图文|帖子|贴文|推文|笔记|简介|话术|开场白|结尾|钩子|爆款',
].join('|'));
// English: whole-word forms only, so "postal" or "scripture" never match.
const EN = new RegExp('\\b(?:' + [
  'write|writes|writing|draft|drafting|rewrite|rewriting|polish|compose',
  'script|scripts|voice-?over|storyboard|shot list|caption|captions|headline|headlines|hook|hooks',
  'blog post|article|essay|copywriting|ad copy|reel|reels|tiktok script',
  'video ideas?|content ideas?|topic ideas?',
].join('|') + ')\\b', 'i');

/** True when the message looks like a request to write, plan or polish content. Pure; no model, no network. */
export function looksLikeCreationRequest(text: string | null | undefined): boolean {
  if (!text) return false;
  const head = text.length > MAX_SCANNED ? text.slice(0, MAX_SCANNED) : text;
  return ZH.test(head) || EN.test(head);
}
