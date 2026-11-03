/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { paygCallQuote } from './admission/paygPolicy';
import { TurnStop, type ModelCall } from './call';
import { openRouterCallBound } from './provider/openRouterPolicy';
import { measureImage } from './provider/imageInput';
import type { ChatQuote } from './quote';

/**
 * One call bounded on its exact request body, as fusionCall does for the jury (the same rules, for a quote made with a RequestBound):
 * the prompt is at most the body's bytes plus the profile's template and margin tokens (a token is at least one byte), the output at
 * most `outputTokens`, so U is the price of that prompt and that output and not of the whole context window. The OpenRouter adapter
 * measures the same body again and refuses any other quote (BILL2_PROVIDER_QUOTE_CONFLICT), and a body above the frozen
 * `bound.promptBytes` was already refused by assertRuntimeRequestCapacity. So the real cost cannot exceed this call's U, and U cannot
 * exceed the quote's frozen upperUsd that the turn held (checked here: a larger one stops the call before anything is written).
 */
export function bodyBoundCall(quote: ChatQuote, body: string, outputTokens: number): ModelCall {
  const parsed = JSON.parse(body) as { messages?: unknown[]; response_format?: unknown; tools?: unknown[] };
  const bytes = Buffer.byteLength(body);
  const messages = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
  const schemaBytes = parsed.response_format === undefined ? 0 : Buffer.byteLength(JSON.stringify(parsed.response_format));
  const { maxBytes, maxMessages, maxSchemaBytes, imageInput, ...identity } = quote.profile;
  // PUBLISH-MONITOR B2: a screenshot quote carries one JPEG, measured here against the route's allowance (any other image, or one on
  // a quote without the allowance, is refused before anything is written); its data URL is outside the text cap, its tokens inside U.
  let image;
  try { image = measureImage(parsed, imageInput) ?? undefined; } catch { throw new TurnStop('TURN_CALL_DENIED'); }
  if (imageInput && !image) throw new TurnStop('TURN_CALL_DENIED');
  const textBytes = bytes - (image?.dataUrlBytes ?? 0);
  if (textBytes > maxBytes || messages < 1 || messages > maxMessages || schemaBytes > maxSchemaBytes || parsed.tools?.length)
    throw new TurnStop('TURN_INPUT_TOO_LARGE');
  const payg = paygCallQuote.parse({ ...identity, bytes,
    promptTokensUpper: textBytes + (image?.tokensUpper ?? 0) + identity.templateTokens + identity.marginTokens,
    messages, tools: 0, schemaBytes, ...(image ? { image } : {}) });
  const output = Math.min(quote.outputLimit, outputTokens);
  const upperUsd = openRouterCallBound(quote.providerLimits, output, payg.promptTokensUpper, image?.tokensUpper ?? 0).upperUsd;
  // Never above what the turn froze: the request was measured against the same bytes, so this only holds if the frozen bound was made on them.
  if (Number(upperUsd) > Number(quote.upperUsd)) throw new TurnStop('TURN_INPUT_TOO_LARGE');
  return { ...quote, upperUsd, identity: { ...quote.identity, outputLimit: output, upperUsd, payg } as ModelCall['identity'] };
}
