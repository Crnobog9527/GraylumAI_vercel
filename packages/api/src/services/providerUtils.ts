/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

/**
 * Provider Runtime Utilities
 *
 * Shared helpers for routing model requests through Anthropic or
 * OpenAI-compatible providers. Both admin connection tests and the
 * production chat runtime use these branches.
 */

export function normalizeOpenAICompatibleEndpoint(endpoint?: string | null) {
  const trimmed = endpoint?.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  if (trimmed.endsWith('/v1/')) return `${trimmed}chat/completions`;
  if (trimmed.endsWith('/')) return `${trimmed}chat/completions`;
  return trimmed;
}

export function looksLikeOpenRouterKey(apiKey?: string | null) {
  return Boolean(apiKey?.startsWith('sk-or-'));
}

export function usesOpenAICompatibleApi(params: {
  endpoint?: string | null;
  apiKey?: string | null;
}) {
  const endpoint = params.endpoint?.toLowerCase() ?? '';
  return endpoint.includes('openrouter.ai') ||
    endpoint.includes('/chat/completions') ||
    looksLikeOpenRouterKey(params.apiKey);
}

export function getOpenAICompatibleHeaders(apiKey: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    'X-Title': 'GraylumAI',
  };
}

export async function getProviderErrorMessage(response: Response) {
  const errorText = await response.text();

  try {
    const errorData = JSON.parse(errorText);
    return (
      errorData?.error?.message ||
      errorData?.message ||
      errorText ||
      `HTTP ${response.status}`
    );
  } catch {
    return errorText || `HTTP ${response.status}`;
  }
}
