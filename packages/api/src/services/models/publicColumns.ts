/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Routing and cost estimation work with user-scoped clients. Credentials are
 * loaded separately by the server transport through its service-role client. */
export const ROUTING_MODEL_COLUMNS = `id,name,model_id,provider,max_tokens,input_limit,
  enable_web_search,input_token_cost,output_token_cost,api_endpoint,is_active,
  token_counting_supported,token_counting_method,tokenizer_family,config`;
