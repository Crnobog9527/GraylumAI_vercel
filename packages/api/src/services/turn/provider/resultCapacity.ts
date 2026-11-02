/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export const RESULT_BYTE_LIMIT = 262144;
export const SUMMARY_RESERVE = 65536;
export const META_RESERVE = 8192;

function numberText(value: number): string {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [mantissa, exponent] = text.split('e');
  const sign = mantissa.startsWith('-') ? '-' : '';
  const unsigned = mantissa.replace('-', '');
  const point = (unsigned.indexOf('.') < 0 ? unsigned.length : unsigned.indexOf('.')) + Number(exponent);
  const digits = unsigned.replace('.', '');
  return sign + (point <= 0 ? '0.' + '0'.repeat(-point) + digits
    : point >= digits.length ? digits + '0'.repeat(point - digits.length)
      : digits.slice(0, point) + '.' + digits.slice(point));
}

/** Match jsonb::text spacing and numeric expansion; key order does not affect byte size. */
export function jsonbBytes(value: unknown): number {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  function encode(item: unknown): string {
    if (Array.isArray(item)) return '[' + item.map(encode).join(', ') + ']';
    if (item && typeof item === 'object') {
      return '{' + Object.entries(item).map(([key, val]) => JSON.stringify(key) + ': ' + encode(val)).join(', ') + '}';
    }
    return typeof item === 'number' ? numberText(item) : JSON.stringify(item);
  }
  return Buffer.byteLength(encode(normalized), 'utf8');
}

type NativeResult = { body: string; completeness?: 'complete' | 'stopped' | 'length_limit'; [key: string]: unknown };
type Envelope = Record<string, unknown> & { message: string; card?: Record<string, unknown> | null };
type FitOptions = {
  attachedOrganizer?: boolean;
  preserveCardMessage?: boolean;
  /** Normal completion schema parser: strips unknown T2 fields and validates rebuilt envelopes. */
  validateEnvelope?: (value: unknown) => Envelope;
};

function envelopeFrom(body: string): Envelope | null {
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).message === 'string') return value as Envelope;
  } catch { /* T1 may be plain text. */ }
  return null;
}

/** Longest code-point prefix satisfying a serialized size constraint. */
function fitPrefix(text: string, minimum: number, accepts: (value: string) => boolean): string {
  const points = Array.from(text);
  let low = minimum;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (accepts(points.slice(0, mid).join('').trimEnd())) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join('').trimEnd();
}

/** Only call for new frozen native-output executions; receipts remain untouched. */
export function fitNativeResult<T extends NativeResult>(input: T, options: FitOptions = {}): T & NativeResult {
  const limit = RESULT_BYTE_LIMIT - (options.attachedOrganizer ? SUMMARY_RESERVE + META_RESERVE : 0);
  let envelope = envelopeFrom(input.body);
  if (envelope && options.validateEnvelope) envelope = options.validateEnvelope(envelope);
  let result: NativeResult = { ...input, completeness: input.completeness ?? 'complete',
    body: envelope ? JSON.stringify(envelope) : input.body };
  if (jsonbBytes(result) <= limit) return result as T & NativeResult;
  result = { ...result, completeness: 'length_limit' };
  const original = envelope?.message ?? input.body;
  const card = envelope?.card && typeof envelope.card === 'object' ? { ...envelope.card } : null;
  const build = (message: string): string => envelope
    ? JSON.stringify({ ...envelope, message, ...(card ? { card: options.preserveCardMessage ? card : { ...card, message } } : {}) }) : message;
  const accepts = (message: string) => jsonbBytes({ ...result, body: build(message) }) <= limit;
  const minimum = card || options.validateEnvelope ? 1 : 0;
  let message = fitPrefix(original, minimum, accepts);
  result.body = build(message);
  if (jsonbBytes(result) > limit && card && typeof card.recommendationReason === 'string') {
    const reason = card.recommendationReason;
    card.recommendationReason = fitPrefix(reason, 1, value => {
      card.recommendationReason = value;
      return accepts(message);
    });
    result.body = build(message);
  }
  if (jsonbBytes(result) > limit && envelope && !card) {
    // Oversized private T2 fields: preserve public prose, mark it unusable for structured consumers.
    envelope = { message: original };
    result = { ...result, envelopeCompact: true };
    message = fitPrefix(original, 0, accepts);
    result.body = build(message);
  }
  if (jsonbBytes(result) > limit) throw new Error('RUNTIME_RESULT_METADATA_CAPACITY');
  if (options.validateEnvelope && !result.envelopeCompact && envelope) {
    options.validateEnvelope(JSON.parse(result.body));
  }
  return result as T & NativeResult;
}

/** Never changes the checkpointed body; oversize summaries stay available in their receipt. */
export function attachNativeSummary<T extends NativeResult>(primary: T, summary: string) {
  const withSummary = { ...primary, summary, organized: true };
  if (primary.completeness !== 'length_limit' && !primary.envelopeCompact
    && jsonbBytes({ summary }) <= SUMMARY_RESERVE && jsonbBytes(withSummary) <= RESULT_BYTE_LIMIT) return withSummary;
  const omitted = { ...primary, summary: '', organized: false, summaryOmitted: true };
  if (jsonbBytes(omitted) > RESULT_BYTE_LIMIT) throw new Error('RUNTIME_RESULT_METADATA_CAPACITY');
  return omitted;
}

/** The caller projects the saved message/card into Session first. Never persists an oversized item. */
export function fitNativeSessionItem<T>(item: T): T | null {
  return jsonbBytes(item) <= RESULT_BYTE_LIMIT ? item : null;
}
