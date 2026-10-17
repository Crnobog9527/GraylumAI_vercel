/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { frozenToolPolicy, TOOL_PROTOCOL, type ToolCallPolicy } from './toolBilling';

/**
 * RESEARCH-TOOLS RT-3b PR-3: a v2 runtime run may also freeze tool-route prices next to its models (0255 accepts
 * them at run creation and checks each claim against them). The TS run types describe models only, so every
 * reader of a stored run filters by protocol: models answer model calls, tools price research subcalls.
 */
const isTool = (policy: unknown) => (policy as { protocol?: unknown } | null)?.protocol === TOOL_PROTOCOL;
export const modelCallPolicies = <T extends { protocol: string }>(policies: readonly T[]): T[] =>
  policies.filter(policy => !isTool(policy));
/** The tool routes of a stored run, validated again; an invalid entry fails closed. */
export const toolCallPolicies = (policies: readonly unknown[]): ToolCallPolicy[] =>
  policies.filter(isTool).map(policy => frozenToolPolicy.parse(policy));
