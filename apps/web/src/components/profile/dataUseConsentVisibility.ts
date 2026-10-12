/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Whether the personal center shows the data-use consent card (AGENT-CORE R10, D5).
 * Hidden at launch by Owner decision (2026-10-12): product improvement uses only de-identified aggregate
 * statistics, and specific conversations come from feedback users send themselves. The card, its API and
 * the consent table stay in place; set this to true to bring the card back.
 */
export const DATA_USE_CONSENT_VISIBLE = false;
