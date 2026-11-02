/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export const PURPOSE_OUTPUT_CAP = 32768;
// Full response: two serialized copies of up to PURPOSE_OUTPUT_CAP output units (reasoning
// may also appear in reasoning_details), plus an 8 KiB envelope.
export const OPENROUTER_RESPONSE_BYTE_LIMIT = 2 * PURPOSE_OUTPUT_CAP * 8 + 8192;
// Independent per-frame / lookup / error-evidence bound, not a response budget.
export const OPENROUTER_FRAME_BYTE_LIMIT = 65536;
// Durable evidence includes original wire bytes and the SQL replay projection.
// Matches migration 0186; the result/session limit remains 262144.
export const OPENROUTER_RECEIPT_BYTE_LIMIT = 4_194_304;
