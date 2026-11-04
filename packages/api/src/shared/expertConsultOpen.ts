/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * EXPERT-CONSULT switch, shared by the browser (cards and booking page) and the server (the request mutation).
 * Owner 2026-11-04 (option A): the booking entry opens after launch. While false no card is shown, the booking page says
 * "即将开放", and the server refuses a request before it reads or writes anything, so no contact details are collected
 * with nobody to follow them up. Opening it later is changing this one value.
 */
export const EXPERT_CONSULT_ENTRY_OPEN = false;
