-- Retire Anthropic official API as a runtime default.
-- Claude models are routed through OpenRouter's OpenAI-compatible API.

ALTER TABLE ai_models
  ALTER COLUMN provider SET DEFAULT 'openai';

UPDATE ai_models
SET
  provider = 'openai',
  token_counting_supported = 'true',
  token_counting_method = 'provider_usage',
  tokenizer_family = 'openai',
  updated_at = NOW()
WHERE provider = 'anthropic'
  AND (
    model_id ILIKE 'anthropic/%'
    OR api_endpoint ILIKE '%openrouter.ai%'
    OR api_endpoint ILIKE '%/chat/completions%'
  );
