/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { swallow } from '../../../lib/swallow';
import type { RuntimeTool } from '../agent/runner';
import type { ImageOutcome } from '../../connectors/shotviva/images';
import type { PartnerTemplate } from '../../connectors/shotviva/contract';

/*
 * INTEGRATION-SHOTVIVA PR B: image generation in a free chat through the user's linked Shotviva account (Owner 2026-11-05:
 * Shotviva is a connector, charges its own credits, no internal settlement; templates, no model choice). Both tools are free
 * tools here: no turn_calls row, no Graylum credits. The definitions are the same on every turn of the session (2.9 rule 2);
 * a free member or an account without a Shotviva link gets them trimmed with a reason, never silently dropped (2.7).
 */
export const GENERATE_IMAGE_TOOL = 'generate_image';
export const LIST_IMAGE_TEMPLATES_TOOL = 'list_image_templates';
export const IMAGE_TOOL_NAMES = [LIST_IMAGE_TEMPLATES_TOOL, GENERATE_IMAGE_TOOL] as const;
/** One image and one template list per reply. */
export const GENERATE_IMAGE_CALLS = 1;
export const LIST_IMAGE_TEMPLATES_CALLS = 1;
/** Request bytes kept for both results (a short template list and a short JSON answer). */
export const IMAGE_RESULT_RESERVE_BYTES = 6_000;
/** The template list shown to the model: id, name, category, cost and the text fields, nothing else. */
const MAX_TEMPLATES = 40;

export const generateImageParameters = z.object({
  template_id: z.string().min(1).max(64).describe('A template id from list_image_templates; "freeform" for a picture described in words.'),
  prompt: z.string().min(1).max(2000).optional().describe('For "freeform": what the picture shows, in the user\'s words.'),
  copy: z.record(z.string().min(1).max(40), z.string().max(500)).optional()
    .describe('For a template: its text fields by key, as list_image_templates lists them.'),
  aspect_ratio: z.string().max(8).optional().describe('One of the template\'s aspect ratios; omit for its default.'),
}).strict();
const listParameters = z.object({}).strict();

const GENERATE_DESCRIPTION = 'Make one image with the user\'s connected Shotviva account (Shotviva charges its own credits; '
  + 'Graylum charges nothing). Use "freeform" with a prompt, or a template id with its text fields from list_image_templates. '
  + 'The user sees the image as a card under your reply: do not repeat a link, the prompt or the description. Never ask to swap a '
  + 'face or to make someone look like a real person: that is refused.';
const LIST_DESCRIPTION = 'List the Shotviva image templates the user can use (id, name, category, credits, text fields). '
  + 'Read-only, free.';

export const IMAGE_TOOLS_INSTRUCTIONS = '\n\nImages: when the user asks for a picture, call generate_image once ("freeform" '
  + 'with a prompt, or a template from list_image_templates). Keep the reply short: never write out the prompt, the '
  + 'description or the template fields, before or after the call (the user wrote them; the card shows the image). If the '
  + 'image is not made, say in one sentence why and what the user can do next; the card under your reply has the button.';

export function imageToolBytes(): number {
  return Buffer.byteLength(JSON.stringify([
    { type: 'function', function: { name: LIST_IMAGE_TEMPLATES_TOOL, description: LIST_DESCRIPTION, strict: true,
      parameters: z.toJSONSchema(listParameters) } },
    { type: 'function', function: { name: GENERATE_IMAGE_TOOL, description: GENERATE_DESCRIPTION, strict: true,
      parameters: z.toJSONSchema(generateImageParameters) } },
  ]));
}

export type ImageToolCalls = {
  sessionId: string;
  listTemplates: () => Promise<{ ok: true; templates: PartnerTemplate[] } | { ok: false; code: string }>;
  generate: (input: { idempotencyKey: string; templateId: string; copy: Record<string, string>; aspectRatio?: string })
    => Promise<ImageOutcome>;
};

/** Owner 2026-11-13: a reply about an image does not repeat the user's prompt; a failed one is one sentence and the next step. */
const ONE_SENTENCE = 'In one sentence, tell the user why and what they can do next (the card under your reply has the button); '
  + 'do not repeat the prompt or the description.';
export const IMAGE_SHOWN_NOTE = 'The image is shown to the user as a card. Do not repeat the prompt or describe the image.';
export const IMAGE_FAILED_NOTE = `Not made. Do not call again in this reply. ${ONE_SENTENCE}`;
const IMAGE_UNAVAILABLE = (reason: string) => JSON.stringify({ status: 'failed', code: reason,
  note: `Image generation cannot be used in this reply. ${ONE_SENTENCE}` });

/** The Shotviva idempotency key of one call: the session, the model's call id and the request. A resumed turn replays the
 * same call id and arguments, so it is the same job and charged once; a provider that repeats a call id in a later turn
 * with another request still gets a new image. Printable ASCII, at most 200 characters (contract). */
export function imageIdempotencyKey(sessionId: string, callId: string, request: unknown): string {
  const call = callId.replace(/[^\x21-\x7e]/g, '').slice(0, 100);
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 24);
  return `graylum:${sessionId}:${call}:${digest}`;
}

/** What the model reads back: the outcome without the image address (the card shows the image). */
export function imageToolResult(outcome: ImageOutcome): string {
  if (outcome.status === 'succeeded') {
    return JSON.stringify({ status: 'succeeded', jobId: outcome.jobId, creditsCharged: outcome.creditsCharged,
      creditsRemaining: outcome.creditsRemaining, note: IMAGE_SHOWN_NOTE });
  }
  if (outcome.status === 'running') {
    return JSON.stringify({ status: 'running', ...(outcome.jobId ? { jobId: outcome.jobId } : {}),
      note: 'Still generating. In one sentence, tell the user it will appear in their Shotviva works; do not call again '
        + 'and do not repeat the prompt.' });
  }
  return JSON.stringify({ status: 'failed', code: outcome.code, ...(outcome.jobId ? { jobId: outcome.jobId } : {}),
    refunded: outcome.refunded, note: IMAGE_FAILED_NOTE });
}

/** The two RuntimeTools. `usable`: the plan left them available this reply; each has its own per-reply cap. */
export function imageTools(input: { usable: (name: string) => boolean; calls: ImageToolCalls | undefined; onCall: () => void }):
  RuntimeTool[] {
  let lists = 0, generations = 0;
  const list: RuntimeTool = { name: LIST_IMAGE_TEMPLATES_TOOL, description: LIST_DESCRIPTION, parameters: listParameters,
    enabled: () => lists < LIST_IMAGE_TEMPLATES_CALLS,
    async execute() {
      if (!input.usable(LIST_IMAGE_TEMPLATES_TOOL) || !input.calls || lists >= LIST_IMAGE_TEMPLATES_CALLS) return IMAGE_UNAVAILABLE('unavailable');
      lists++; input.onCall();
      const listed = await swallow('turn_image_templates_failed', input.calls.listTemplates(), { ok: false as const, code: 'unavailable' });
      if (!listed.ok) return JSON.stringify({ status: 'failed', code: listed.code,
        note: `The template list could not be read. ${ONE_SENTENCE}` });
      return JSON.stringify({ status: 'ok', items: listed.templates.slice(0, MAX_TEMPLATES).map(template => ({
        id: template.id, name: template.name, category: template.category, credits: template.credits_cost,
        fields: template.fields.copy.map(field => ({ key: field.key, label: field.label, required: field.required,
          maxLength: field.max_length })), aspectRatios: template.fields.aspect_ratios })) });
    } };
  const generate: RuntimeTool = { name: GENERATE_IMAGE_TOOL, description: GENERATE_DESCRIPTION, parameters: generateImageParameters,
    enabled: () => generations < GENERATE_IMAGE_CALLS,
    async execute(arguments_, callId) {
      if (!input.usable(GENERATE_IMAGE_TOOL) || !input.calls || generations >= GENERATE_IMAGE_CALLS) return IMAGE_UNAVAILABLE('unavailable');
      const args = generateImageParameters.parse(arguments_);
      const copy = args.template_id === 'freeform' ? { prompt: args.prompt ?? '' } : args.copy ?? {};
      if (args.template_id === 'freeform' && !args.prompt) return JSON.stringify({ status: 'failed', code: 'invalid_input',
        note: 'A "freeform" image needs a prompt.' });
      // Counted before the call: a failed generation still used its model continuation.
      generations++; input.onCall();
      const request = { template: args.template_id, copy, aspect: args.aspect_ratio ?? null };
      const failed: ImageOutcome = { status: 'failed', code: 'unavailable', topUpUrl: null, jobId: null, refunded: false };
      const outcome = await swallow('turn_image_generate_failed', input.calls.generate({
        idempotencyKey: imageIdempotencyKey(input.calls.sessionId, callId, request), templateId: args.template_id, copy,
        ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio } : {}) }), failed);
      return imageToolResult(outcome);
    } };
  return [list, generate];
}
