/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

type CreditFixture = {
  id: string;
  credits: number;
};

type ConversationFixtureInput = {
  title: string;
  userMessage?: string;
  assistantMessage?: string;
};

type TokenStatsFixtureInput = {
  conversationId: string;
  userId: string;
  modelUsed?: string;
  inputTokens: number;
  outputTokens: number;
  totalCredits: number;
  totalCostUsd?: string;
  webSearchCount?: number;
};

let serviceClient: ReturnType<typeof createClient> | null = null;

function getServiceClient() {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
  dotenv.config({ path: path.resolve(process.cwd(), 'apps/web/.env.local') });

  if (serviceClient) {
    return serviceClient;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for E2E credit fixtures.');
  }

  serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return serviceClient;
}

async function withSupabaseRetry<T>(label: string, operation: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const isRetryable = message.includes('fetch failed') || message.includes('ERR_INTERNET_DISCONNECTED');
      if (!isRetryable || attempt === attempts) {
        break;
      }

      await sleep(300 * attempt);
    }
  }

  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function getCreditFixtureByEmail(email: string): Promise<CreditFixture> {
  return withSupabaseRetry(`Unable to load profile credits for ${email}`, async () => {
    const supabase = getServiceClient() as any;
    const { data, error } = await supabase
      .from('profiles')
      .select('id, credits')
      .eq('email', email)
      .single();

    if (error || !data) {
      throw new Error(error?.message ?? 'Unknown error');
    }

    return {
      id: data.id,
      credits: data.credits ?? 0,
    };
  });
}

export async function setCreditsForUserEmail(email: string, targetCredits: number, reason: string) {
  const profile = await getCreditFixtureByEmail(email);
  const previousCredits = profile.credits;

  if (previousCredits === targetCredits) {
    return previousCredits;
  }

  const delta = targetCredits - previousCredits;
  await withSupabaseRetry(`Unable to update credits for ${email}`, async () => {
    const supabase = getServiceClient() as any;
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ credits: targetCredits })
      .eq('id', profile.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    const transactionType = delta >= 0 ? 'addition' : 'deduction';
    const { error: transactionError } = await supabase.from('credit_transactions').insert({
      user_id: profile.id,
      amount: delta,
      type: transactionType,
      description: `[E2E fixture] ${reason}`,
    });

    if (transactionError) {
      throw new Error(transactionError.message);
    }
  });

  return previousCredits;
}

export async function ensureCreditsAtLeastForUserEmail(email: string, minimumCredits: number, reason: string) {
  const profile = await getCreditFixtureByEmail(email);
  if (profile.credits >= minimumCredits) {
    return profile.credits;
  }

  await setCreditsForUserEmail(email, minimumCredits, reason);
  return minimumCredits;
}

export async function getSystemSettingValue(key: string) {
  return withSupabaseRetry(`Unable to read system setting ${key}`, async () => {
    const supabase = getServiceClient() as any;
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    return data?.value;
  });
}

export async function getAiUsageLogByRequestId(requestId: string) {
  return withSupabaseRetry(`Unable to read ai_usage_log for request ${requestId}`, async () => {
    const supabase = getServiceClient() as any;
    const { data, error } = await supabase
      .from('ai_usage_logs')
      .select('id, request_id, conversation_id, model_id, status, metadata, created_at')
      .eq('request_id', requestId)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    return data ?? null;
  });
}

export async function setSystemSettingValue(key: string, value: unknown) {
  await withSupabaseRetry(`Unable to write system setting ${key}`, async () => {
    const supabase = getServiceClient() as any;
    const { error } = await supabase
      .from('system_settings')
      .upsert({ key, value }, { onConflict: 'key' });

    if (error) {
      throw new Error(error.message);
    }
  });
}

export async function createConversationFixtureForUserEmail(email: string, input: ConversationFixtureInput) {
  const profile = await getCreditFixtureByEmail(email);
  return withSupabaseRetry(`Unable to create conversation fixture for ${email}`, async () => {
    const supabase = getServiceClient() as any;
    const { data: conversation, error: conversationError } = await supabase
      .from('conversations')
      .insert({
        user_id: profile.id,
        title: input.title,
        is_deleted: 'false',
      })
      .select('id, title')
      .single();

    if (conversationError || !conversation) {
      throw new Error(conversationError?.message ?? 'Unknown error');
    }

    const messages = [
      input.userMessage
        ? {
            conversation_id: conversation.id,
            role: 'user',
            content: input.userMessage,
            is_deleted: 'false',
          }
        : null,
      input.assistantMessage
        ? {
            conversation_id: conversation.id,
            role: 'assistant',
            content: input.assistantMessage,
            is_deleted: 'false',
          }
        : null,
    ].filter(Boolean);

    if (messages.length > 0) {
      const { error: messageError } = await supabase
        .from('messages')
        .insert(messages);

      if (messageError) {
        throw new Error(`Unable to create fixture messages: ${messageError.message}`);
      }
    }

    return {
      id: conversation.id as string,
      title: conversation.title as string,
      userId: profile.id,
    };
  });
}

export async function softDeleteConversationFixture(conversationId: string) {
  try {
    await withSupabaseRetry(`Unable to soft-delete fixture conversation ${conversationId}`, async () => {
      const supabase = getServiceClient() as any;
      const deletedAt = new Date().toISOString();

      const { error: messageError } = await supabase
        .from('messages')
        .update({ is_deleted: 'true', deleted_at: deletedAt })
        .eq('conversation_id', conversationId)
        .eq('is_deleted', 'false');

      if (messageError) {
        throw new Error(`messages: ${messageError.message}`);
      }

      const { error: conversationError } = await supabase
        .from('conversations')
        .update({ is_deleted: 'true', deleted_at: deletedAt })
        .eq('id', conversationId)
        .eq('is_deleted', 'false');

      if (conversationError) {
        throw new Error(`conversation: ${conversationError.message}`);
      }
    });
  } catch (error) {
    console.warn(
      `Best-effort cleanup skipped for conversation ${conversationId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function createTokenStatsFixture(input: TokenStatsFixtureInput) {
  await withSupabaseRetry(`Unable to create token stats fixture for conversation ${input.conversationId}`, async () => {
    const supabase = getServiceClient() as any;
    const { error } = await supabase
      .from('token_stats')
      .insert({
        conversation_id: input.conversationId,
        user_id: input.userId,
        model_used: input.modelUsed ?? 'claude-sonnet-4-20250514',
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        web_search_count: input.webSearchCount ?? 0,
        total_cost_usd: input.totalCostUsd ?? '0.010000',
        total_credits: input.totalCredits,
        metadata: {
          source: 'e2e_fixture',
        },
      });

    if (error) {
      throw new Error(error.message);
    }
  });
}
