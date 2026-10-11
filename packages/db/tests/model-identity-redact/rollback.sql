-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- MODEL-IDENTITY-GUARD 0217 recovery (only with Owner approval): restore real model strings in
-- token_stats from the server-only alias map. The ai_models client revoke is kept on purpose.
BEGIN;
DROP TRIGGER IF EXISTS mm_token_stats_model_alias ON public.token_stats;
UPDATE public.token_stats t SET model_used=a.model FROM public.model_usage_aliases a WHERE t.model_used=a.alias;
UPDATE public.token_stats t SET metadata=jsonb_set(t.metadata,'{modelId}',to_jsonb(a.model))
 FROM public.model_usage_aliases a WHERE t.metadata->>'modelId'=a.alias;
UPDATE public.token_stats t SET metadata=jsonb_set(t.metadata,'{pricing,modelId}',to_jsonb(a.model))
 FROM public.model_usage_aliases a WHERE t.metadata#>>'{pricing,modelId}'=a.alias;
UPDATE public.token_stats t SET metadata=jsonb_set(t.metadata,'{pricing,providerModel}',to_jsonb(a.model))
 FROM public.model_usage_aliases a WHERE t.metadata#>>'{pricing,providerModel}'=a.alias;
COMMIT;
