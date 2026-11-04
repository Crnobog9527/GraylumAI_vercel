/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The refusals migration (0504) as it replays on a finished database: without its content_erasure_confirm copy. That copy names the old
// run tables batch F drops (V2-12 F); the function is F's own text now, which already answers PT409.
import { read } from '../runtime-view-perf/local-db.mjs';

export const refusalsMigration = () => {
  const text = read('packages/db/migrations/0504_refusals_no_postgrest_retry.sql');
  const start = text.indexOf('CREATE OR REPLACE FUNCTION public.content_erasure_confirm(');
  const next = text.indexOf('CREATE OR REPLACE FUNCTION public.runtime_session_result_edit(');
  if (start < 0 || next < start) throw new Error('0504 no longer has the expected function order');
  return text.slice(0, start) + text.slice(next);
};
