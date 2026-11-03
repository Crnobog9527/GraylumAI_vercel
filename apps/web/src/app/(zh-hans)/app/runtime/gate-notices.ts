/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { RUNTIME_INPUT_TOO_LONG_MESSAGE } from '../../../../../../../packages/api/src/shared/runtimeInputMessages';
import { RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE } from '../../../../../../../packages/api/src/shared/runtimeAdmissionMessages';

/** POSITIONING-GATE step 2 interim text; the guide card (start positioning / import) is step 3. */
export const POSITIONING_REQUIRED_NOTICE =
  '为自己的账号做社媒运营之前，需要先完成账号定位：请到“对话”里开始定位，或导入你已有的定位。本次没有扣积分。';

/**
 * A cancelled round with no saved body is finished: there is nothing left to verify or show.
 * A paused round without a saved body shows only its pause notice. A round still in progress shows its streamed
 * text (or nothing yet) with its own "正在回复…" notice, never a "verifying" placeholder (CHAT-NATIVE-OUTPUT).
 */
export function showsReply(execution: { state: string; body: string | null; primaryBody: string | null }) {
  return execution.state === 'completed' || Boolean(execution.body ?? execution.primaryBody);
}

/**
 * A structured tRPC refusal the server definitely did not process further: an HTTP 4xx other than
 * 401 (sign in again), 408 (outcome unknown) and 429 (rate limit; the same request is resent later).
 * Decided by status, never by wording. Any other failure leaves the outcome open.
 */
export function definiteRefusal(cause: unknown): { path: string } | null {
  if (!(cause instanceof Error) || !('data' in cause) || !cause.data || typeof cause.data !== 'object') return null;
  const data = cause.data as { httpStatus?: unknown; path?: unknown };
  const status = Number(data.httpStatus);
  if (!Number.isInteger(status) || status < 400 || status > 499 || [401, 408, 429].includes(status)) return null;
  return { path: String(data.path ?? '') };
}

/** A definite admission refusal: nothing was admitted, so no model call and no charge. */
export const DEFINITE_REFUSAL_NOTICE = '这次请求没有被受理：没有发起模型调用，也没有扣积分。';

/**
 * Fixed text for a definite refusal of one of `paths`, or null when the outcome is open.
 * Only shared fixed texts are shown; any other refusal gets the neutral definite notice.
 */
export function definiteRefusalNotice(cause: unknown, paths: readonly string[]): string | null {
  const refused = definiteRefusal(cause);
  if (!refused || !paths.includes(refused.path)) return null;
  const message = (cause as Error).message;
  if (message === RUNTIME_PAYG_PROFILE_REQUIRED_MESSAGE || message === RUNTIME_INPUT_TOO_LONG_MESSAGE) return message;
  return DEFINITE_REFUSAL_NOTICE;
}
