/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { stagingRpcFailure } from '../runtime/stagingErrors';

/*
 * CONTENT-CONVERSATION-DRIVEN C1-lite (Owner 2026-10-13, option A): the "本对话成果夹" of an ordinary free
 * conversation. The user confirms every save; the AI never writes here. Migration 0338 owns ownership, the
 * verbatim-excerpt check, versions and erasure; this layer only shapes input and output.
 */
const uuid = z.string().uuid();
export const SESSION_RESULT_TYPES = ['script', 'storyboard', 'editing', 'body', 'topic_list', 'copy'] as const;
const resultType = z.enum(SESSION_RESULT_TYPES);
const title = z.string().max(200).nullable().default(null);
const body = z.string().min(1).max(20000);

export const sessionResultsList = z.object({ sessionId: uuid }).strict();
export const sessionResultSave = z.object({
  sessionId: uuid, executionId: uuid, requestId: uuid, resultType, title,
  // null saves the whole reply; otherwise the text must appear in the reply verbatim (checked in SQL).
  excerpt: body.nullable().default(null),
}).strict();
export const sessionResultEdit = z.object({
  familyId: uuid, requestId: uuid, expectedVersion: z.number().int().min(1).max(50), title, body,
}).strict();
export const sessionResultFamily = z.object({ familyId: uuid }).strict();

export const sessionResult = z.object({
  id: uuid, familyId: uuid, version: z.number().int().positive(), versions: z.number().int().positive(),
  resultType, title: z.string(), body: z.string(), sourceExecutionId: uuid.nullable(), sourceAvailable: z.boolean(),
  createdAt: z.string(),
}).strict();
export type SessionResult = z.infer<typeof sessionResult>;

type Database = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{
  data: unknown; error: { code?: string; message?: string } | null;
}> };

// Bounded refusals the page maps to plain text; every other failure stays private.
const REFUSALS: Record<string, string> = {
  SESSION_RESULT_NOT_FOUND: 'OPC_RESULT_NOT_FOUND',
  CONTENT_ERASED: 'OPC_CONVERSATION_ERASED',
  SESSION_RESULT_SOURCE: 'OPC_RESULT_SOURCE',
  SESSION_RESULT_INVALID: 'OPC_RESULT_INVALID',
  SESSION_RESULT_REQUEST_CONFLICT: 'OPC_REQUEST_CONFLICT',
  SESSION_RESULT_VERSION_CONFLICT: 'OPC_VERSION_CONFLICT',
  SESSION_RESULT_LIMIT: 'OPC_RESULT_LIMIT',
};

async function call(database: Database, name: string, args: Record<string, unknown>) {
  const { data, error } = await database.rpc(name, args);
  if (error) {
    const refusal = error.message ? REFUSALS[error.message] : undefined;
    if (refusal) throw new Error(refusal);
    stagingRpcFailure(error);
  }
  return data;
}

/** The actor always comes from the verified session, never from the input. */
export function sessionResultsService(database: Database, actorId: string) {
  return {
    // null: not an ordinary free conversation of this actor (a positioning or topic one, someone else's, a missing
    // one; all read the same). The page then shows no folder and no save button, instead of a server error.
    list: async (input: z.infer<typeof sessionResultsList>) => {
      const sessionId = sessionResultsList.parse(input).sessionId;
      try {
        return z.array(sessionResult).parse(await call(database, 'runtime_session_results_list',
          { p_actor_id: actorId, p_session_id: sessionId }));
      } catch (cause) {
        if (cause instanceof Error && cause.message === 'OPC_RESULT_NOT_FOUND') return null;
        throw cause;
      }
    },
    save: async (input: z.input<typeof sessionResultSave>) => {
      const v = sessionResultSave.parse(input);
      return sessionResult.parse(await call(database, 'runtime_session_result_save', {
        p_actor_id: actorId, p_session_id: v.sessionId, p_execution_id: v.executionId, p_request_id: v.requestId,
        p_result_type: v.resultType, p_title: v.title, p_excerpt: v.excerpt,
      }));
    },
    edit: async (input: z.input<typeof sessionResultEdit>) => {
      const v = sessionResultEdit.parse(input);
      return sessionResult.parse(await call(database, 'runtime_session_result_edit', {
        p_actor_id: actorId, p_family_id: v.familyId, p_request_id: v.requestId,
        p_expected_version: v.expectedVersion, p_title: v.title, p_body: v.body,
      }));
    },
    remove: async (input: z.infer<typeof sessionResultFamily>) => z.object({ familyId: uuid, deleted: z.number().int() })
      .strict().parse(await call(database, 'runtime_session_result_delete',
        { p_actor_id: actorId, p_family_id: sessionResultFamily.parse(input).familyId })),
    versions: async (input: z.infer<typeof sessionResultFamily>) => z.array(sessionResult).parse(await call(database,
      'runtime_session_result_versions', { p_actor_id: actorId, p_family_id: sessionResultFamily.parse(input).familyId })),
  };
}
