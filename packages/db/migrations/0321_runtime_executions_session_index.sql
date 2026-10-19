-- CRON-IDLE-COST: runtime_executions had no index on session_id. runtime_view (every page refresh of a
-- conversation), runtime_history_availability's execution list, opc_free_conversations (two lateral reads
-- per session) and other per-session reads filter by session_id and sequentially scanned every user's
-- executions. (session_id, created_at, id) also serves their ORDER BY created_at, id.
CREATE INDEX IF NOT EXISTS runtime_executions_session_created_idx
 ON public.runtime_executions(session_id, created_at, id);
