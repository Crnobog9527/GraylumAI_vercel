/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { resolveOpenAICompatibleEndpoint, isOpenRouterEndpoint } from "./providerUtils";
type TokenCountingMetadata = {
  token_counting_supported: 'true' | 'false';
  token_counting_method: string;
  tokenizer_family: string | null;
};

const VERIFIED_OPENAI_TOKENIZER_PREFIXES = [
  'gpt-4.1',
  'gpt-4o',
  'gpt-4.5',
  'gpt-5',
  'o1',
  'o3',
  'text-embedding-3',
];

export function inferTokenCountingMetadata(params: {
  provider: string | null;
  modelId: string;
  apiEndpoint?: string | null;
}): TokenCountingMetadata {
  const provider = params.provider ?? 'custom';
  const modelId = params.modelId.toLowerCase();
  const endpoint = (resolveOpenAICompatibleEndpoint(params.provider, params.apiEndpoint) ?? '').toLowerCase();
  const openAICompatibleProvider = provider === 'openai' ||
    isOpenRouterEndpoint(endpoint) ||
    endpoint.includes('chat/completions');

  // Actual OpenRouter routing takes precedence over a legacy provider label.
  if (isOpenRouterEndpoint(endpoint) || (openAICompatibleProvider && (modelId.includes('claude') || modelId.startsWith('anthropic/')))) {
    return {token_counting_supported:'true',token_counting_method:'provider_usage',tokenizer_family:'openai'};
  }

  if (provider === 'anthropic') {
    return {
      token_counting_supported: 'true',
      token_counting_method: 'anthropic_count_tokens',
      tokenizer_family: 'anthropic',
    };
  }

  if (provider === 'google') {
    return {
      token_counting_supported: 'true',
      token_counting_method: 'gemini_count_tokens',
      tokenizer_family: 'gemini',
    };
  }

  const openAITokenizerVerified = VERIFIED_OPENAI_TOKENIZER_PREFIXES.some((prefix) => modelId.startsWith(prefix));

  if (openAICompatibleProvider && openAITokenizerVerified) {
    return {
      token_counting_supported: 'true',
      token_counting_method: 'verified_openai_tokenizer',
      tokenizer_family: 'openai',
    };
  }

  return {
    token_counting_supported: 'false',
    token_counting_method: 'unsupported',
    tokenizer_family: openAICompatibleProvider ? 'openai' : null,
  };
}

// Metadata is derived, not an administrator override. Correct stale automatic
// flags on reads as well as saves, without rewriting credentials or configuration.
export function withTokenCountingMetadata<T extends {provider?:string|null;model_id:string;api_endpoint?:string|null}>(row:T) {
 const inferred=inferTokenCountingMetadata({provider:row.provider??null,modelId:row.model_id,apiEndpoint:row.api_endpoint});
 const trusted=isOpenRouterEndpoint(resolveOpenAICompatibleEndpoint(row.provider,row.api_endpoint)??'');
 return trusted ? {...row,...inferred} : {...inferred,...row};
}
