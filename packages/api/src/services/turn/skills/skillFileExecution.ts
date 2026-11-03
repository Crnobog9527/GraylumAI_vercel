/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export type ToolRpc = <T>(name: string, args: Record<string, unknown>) => Promise<T>;
