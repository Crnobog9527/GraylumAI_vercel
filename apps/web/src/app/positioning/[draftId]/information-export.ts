/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

const field = z.object({ id: z.string().min(1), title: z.string() });
const value = z.object({ value: z.string(), status: z.string(), nature: z.string().optional() });
const readSchema = z.object({
  draftId: z.string().min(1), projectId: z.string().min(1),
  roundId: z.string().min(1), sessionId: z.string().min(1),
  snapshot: z.object({
    state: z.string(),
    workflow: z.object({ steps: z.array(field) }),
    steps: z.record(z.string(), z.object({
      version: z.number().int().nonnegative(), reviewVersion: z.number().int().nonnegative(),
      valid: z.boolean(),
    })),
  }),
  information: z.record(z.string(), z.object({
    schema: z.array(field), values: z.record(z.string(), value).nullable().optional(),
  })).nullable(),
});

export const EXPORT_CHANGED = '资料或登录状态已变化，请刷新页面后再导出。';
export const EXPORT_FAILED = '暂时无法读取已确认资料，请稍后重试。';
export const EXPORT_EMPTY = '还没有已确认的资料。确认后即可免费导出。';

/** Only the existing read response is accepted; editor buffers and reports never enter this projection. */
function projection(raw: unknown, draftId: string) {
  const read = readSchema.parse(raw);
  if (read.draftId !== draftId) throw new Error(EXPORT_CHANGED);
  const ids = read.snapshot.workflow.steps.map(step => step.id);
  if (new Set(ids).size !== ids.length) throw new Error(EXPORT_CHANGED);
  const steps = read.snapshot.workflow.steps.map(step => {
    const state = read.snapshot.steps[step.id];
    const info = read.information?.[step.id];
    if (!state || !info || new Set(info.schema.map(f => f.id)).size !== info.schema.length)
      throw new Error(EXPORT_CHANGED);
    return { ...step, state, schema: info.schema, values: info.values ?? {} };
  });
  return { draftId: read.draftId, projectId: read.projectId, roundId: read.roundId,
    sessionId: read.sessionId, state: read.snapshot.state, steps };
}

export function informationExportIdentity(raw: unknown, draftId: string): string {
  const p = projection(raw, draftId);
  // Include values too: a cache update without its matching version must fail closed.
  return JSON.stringify(p);
}

// Encode user-controlled text as literal Markdown, including HTML and multiline headings.
function literal(text: string) {
  return Array.from(text.replace(/\r\n?/g, '\n')).map(char => {
    const code = char.codePointAt(0)!;
    return (code >= 33 && code <= 126 && /[^a-zA-Z0-9]/.test(char)) ? `&#${code};` : char;
  }).join('');
}

export function confirmedInformationMarkdown(raw: unknown, draftId: string, expected: string): string | null {
  if (informationExportIdentity(raw, draftId) !== expected) throw new Error(EXPORT_CHANGED);
  const p = projection(raw, draftId);
  const sections: string[] = [];
  const natures: Record<string, string> = { fact: '事实', hypothesis: '假设', decision: '决定', unknown: '未标注' };
  for (const step of p.steps) {
    const fields = step.schema.flatMap(field => {
      const answer = step.values[field.id];
      if (answer?.status !== 'confirmed' || !answer.value.trim()) return [];
      const title = literal(field.title).replace(/\n/g, ' ');
      return [`### ${title}\n\n性质：${natures[answer.nature ?? 'unknown'] ?? '未标注'}\n\n` +
        answer.value.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${literal(line)}`).join('\n')];
    });
    if (fields.length) sections.push(`## ${literal(step.title).replace(/\n/g, ' ')}\n\n${fields.join('\n\n')}`);
  }
  return sections.length ? '# 已确认的前置信息\n\n仅包含已保存并确认的资料；假设与决定不代表已验证的事实。\n\n' +
    sections.join('\n\n') + '\n' : null;
}

export function downloadInformation(markdown: string) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '已确认的前置信息.md';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
