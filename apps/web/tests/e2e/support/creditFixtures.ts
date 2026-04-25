/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { getE2ESql } from './e2eDb';

type CreditFixture = {
  id: string;
  credits: number;
};

export type UserCreditSnapshot = {
  userId: string;
  credits: number;
};

export type AiUsageLogSnapshot = {
  id: string;
  requestId: string | null;
  conversationId: string | null;
  modelId: string;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type ConversationSnapshot = {
  id: string;
  userId: string;
  title: string;
  isDeleted: boolean;
  createdAt: string;
};

export type MessageSnapshot = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type TokenStatSnapshot = {
  id: string;
  conversationId: string;
  userId: string;
  messageId: string | null;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  totalCredits: number;
  totalCostUsd: string;
  createdAt: string;
};

export type CreditTransactionSnapshot = {
  id: string;
  userId: string | null;
  amount: number;
  type: string;
  description: string | null;
  createdAt: string;
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

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue | undefined };

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
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
    const sql = getE2ESql();
    const rows = await sql<Array<{ id: string; credits: number }>>`
      select id, credits
      from profiles
      where email = ${email}
      limit 1
    `;

    if (!rows[0]) {
      throw new Error('Profile not found');
    }

    return {
      id: rows[0].id,
      credits: rows[0].credits ?? 0,
    };
  });
}

export async function getCreditsForUserEmail(email: string): Promise<UserCreditSnapshot> {
  const profile = await getCreditFixtureByEmail(email);
  return {
    userId: profile.id,
    credits: profile.credits,
  };
}

export async function setCreditsForUserEmail(email: string, targetCredits: number, reason: string) {
  const profile = await getCreditFixtureByEmail(email);
  const previousCredits = profile.credits;

  if (previousCredits === targetCredits) {
    return previousCredits;
  }

  const delta = targetCredits - previousCredits;
  await withSupabaseRetry(`Unable to update credits for ${email}`, async () => {
    const sql = getE2ESql();
    const transactionType = delta >= 0 ? 'addition' : 'deduction';
    await sql`
      update profiles
      set credits = ${targetCredits}
      where id = ${profile.id}
    `;
    await sql`
      insert into credit_transactions (user_id, amount, type, description)
      values (${profile.id}, ${delta}, ${transactionType}, ${`[E2E fixture] ${reason}`})
    `;
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
    const sql = getE2ESql();
    const rows = await sql<Array<{ value: unknown }>>`
      select value
      from system_settings
      where key = ${key}
      limit 1
    `;

    return rows[0]?.value;
  });
}

export async function getAiUsageLogByRequestId(requestId: string) {
  return withSupabaseRetry(`Unable to read ai_usage_log for request ${requestId}`, async () => {
    const sql = getE2ESql();
    const rows = await sql<Array<Record<string, any>>>`
      select id, request_id, conversation_id, model_id, status, metadata, created_at
      from ai_usage_logs
      where request_id = ${requestId}
      limit 1
    `;

    return rows[0] ?? null;
  });
}

export async function getAiUsageLogSnapshotByRequestId(requestId: string): Promise<AiUsageLogSnapshot | null> {
  const record = await getAiUsageLogByRequestId(requestId);
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    requestId: record.request_id ?? null,
    conversationId: record.conversation_id ?? null,
    modelId: record.model_id,
    status: record.status,
    metadata: record.metadata ?? null,
    createdAt: record.created_at,
  };
}

export async function setSystemSettingValue(key: string, value: unknown) {
  await withSupabaseRetry(`Unable to write system setting ${key}`, async () => {
    const sql = getE2ESql();
    await sql`
      insert into system_settings (key, value)
      values (${key}, ${sql.json(asJsonValue(value))})
      on conflict (key) do update set value = excluded.value
    `;
  });
}

export async function getConversationById(conversationId: string): Promise<ConversationSnapshot | null> {
  return withSupabaseRetry(`Unable to read conversation ${conversationId}`, async () => {
    const sql = getE2ESql();
    const rows = await sql<Array<Record<string, any>>>`
      select id, user_id, title, is_deleted, created_at
      from conversations
      where id = ${conversationId}
      limit 1
    `;

    const data = rows[0];
    if (!data) {
      return null;
    }

    return {
      id: data.id,
      userId: data.user_id,
      title: data.title,
      isDeleted: data.is_deleted === true || data.is_deleted === 'true',
      createdAt: data.created_at,
    };
  });
}

export async function getConversationMessages(conversationId: string): Promise<MessageSnapshot[]> {
  return withSupabaseRetry(`Unable to read messages for conversation ${conversationId}`, async () => {
    const sql = getE2ESql();
    const data = await sql<Array<Record<string, any>>>`
      select id, conversation_id, role, content, created_at
      from messages
      where conversation_id = ${conversationId}
        and is_deleted = 'false'
      order by created_at asc
    `;

    return data.map((row: any) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  });
}

export async function getConversationTokenStats(conversationId: string): Promise<TokenStatSnapshot[]> {
  return withSupabaseRetry(`Unable to read token stats for conversation ${conversationId}`, async () => {
    const sql = getE2ESql();
    const data = await sql<Array<Record<string, any>>>`
      select id, conversation_id, user_id, message_id, model_used, input_tokens, output_tokens, total_credits, total_cost_usd, created_at
      from token_stats
      where conversation_id = ${conversationId}
      order by created_at asc
    `;

    return data.map((row: any) => ({
      id: row.id,
      conversationId: row.conversation_id,
      userId: row.user_id,
      messageId: row.message_id ?? null,
      modelUsed: row.model_used,
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      totalCredits: row.total_credits ?? 0,
      totalCostUsd: row.total_cost_usd,
      createdAt: row.created_at,
    }));
  });
}

export async function getRecentCreditTransactionsForUserEmail(
  email: string,
  options?: {
    createdAfter?: string;
    limit?: number;
  }
): Promise<CreditTransactionSnapshot[]> {
  const profile = await getCreditFixtureByEmail(email);

  return withSupabaseRetry(`Unable to read credit transactions for ${email}`, async () => {
    const sql = getE2ESql();
    const limit = options?.limit ?? 10;
    const data = options?.createdAfter
      ? await sql<Array<Record<string, any>>>`
          select id, user_id, amount, type, description, created_at
          from credit_transactions
          where user_id = ${profile.id}
            and created_at >= ${options.createdAfter}
          order by created_at desc
          limit ${limit}
        `
      : await sql<Array<Record<string, any>>>`
          select id, user_id, amount, type, description, created_at
          from credit_transactions
          where user_id = ${profile.id}
          order by created_at desc
          limit ${limit}
        `;

    return data.map((row: any) => ({
      id: row.id,
      userId: row.user_id ?? null,
      amount: row.amount ?? 0,
      type: row.type,
      description: row.description ?? null,
      createdAt: row.created_at,
    }));
  });
}

export async function createConversationFixtureForUserEmail(email: string, input: ConversationFixtureInput) {
  const profile = await getCreditFixtureByEmail(email);
  return withSupabaseRetry(`Unable to create conversation fixture for ${email}`, async () => {
    const sql = getE2ESql();
    const [conversation] = await sql<Array<{ id: string; title: string }>>`
      insert into conversations (user_id, title, is_deleted)
      values (${profile.id}, ${input.title}, 'false')
      returning id, title
    `;

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
      for (const message of messages as Array<{ conversation_id: string; role: string; content: string; is_deleted: string }>) {
        await sql`
          insert into messages (conversation_id, role, content, is_deleted)
          values (${message.conversation_id}, ${message.role}, ${message.content}, ${message.is_deleted})
        `;
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
      const sql = getE2ESql();
      const deletedAt = new Date().toISOString();

      await sql`
        update messages
        set is_deleted = 'true', deleted_at = ${deletedAt}
        where conversation_id = ${conversationId}
          and is_deleted = 'false'
      `;
      await sql`
        update conversations
        set is_deleted = 'true', deleted_at = ${deletedAt}
        where id = ${conversationId}
          and is_deleted = 'false'
      `;
    });
  } catch (error) {
    console.warn(
      `Best-effort cleanup skipped for conversation ${conversationId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function createTokenStatsFixture(input: TokenStatsFixtureInput) {
  await withSupabaseRetry(`Unable to create token stats fixture for conversation ${input.conversationId}`, async () => {
    const sql = getE2ESql();
    await sql`
      insert into token_stats (
        conversation_id, user_id, model_used, input_tokens, output_tokens,
        web_search_count, total_cost_usd, total_credits, metadata
      )
      values (
        ${input.conversationId},
        ${input.userId},
        ${input.modelUsed ?? 'anthropic/claude-sonnet-4.6'},
        ${input.inputTokens},
        ${input.outputTokens},
        ${input.webSearchCount ?? 0},
        ${input.totalCostUsd ?? '0.010000'},
        ${input.totalCredits},
        ${sql.json({ source: 'e2e_fixture' })}
      )
    `;
  });
}
