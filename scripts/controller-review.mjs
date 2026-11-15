/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Human-readable prose (especially "未通过") is not an approval. Only an explicit final receipt counts.
export function independentReviewPassed(comments, head) {
  if (!/^[a-f0-9]{40}$/.test(head) || !Array.isArray(comments)) return false;
  const relevant = comments.filter(comment => typeof comment.body === 'string'
    && comment.body.includes('独立审查') && comment.body.includes(head.slice(0, 9)));
  const body = relevant.at(-1)?.body ?? '';
  if (/未通过|不通过|需修改|拒绝|阻塞项\s*[:：]?\s*[1-9]/.test(body)) return false;
  const markers = body.split('\n').filter(line => line.startsWith('<!-- graylum-independent-review:v1 '));
  return markers.length === 1 && markers[0] === `<!-- graylum-independent-review:v1 commit=${head} verdict=pass -->`;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [head, file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error('Usage: controller-review.mjs <full commit> <comments.json>');
  if (!independentReviewPassed(JSON.parse(readFileSync(file, 'utf8')), head)) process.exitCode = 1;
}
