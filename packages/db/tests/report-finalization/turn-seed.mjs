/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-12 B6: a finished report as report_document reads it (report_turn_source): a closed kind=report turn whose request id is
// the document's handle, its frozen reportGeneration policy and the assistant message that holds the text. The old suites built an old
// execution here. Only the rows report_turn_source reads are written; turn_open/turn_close have their own cases (turn-core).
// completeness: 'complete' (completed and delivered), 'length_limit' (completed, not delivered), 'stopped', or anything else (failed).
export async function insertReportTurn(db, {actor, session, request, spec, body, completeness = 'complete'}) {
 const close = completeness === 'complete' || completeness === 'length_limit' ? 'completed' : completeness === 'stopped' ? 'stopped' : 'failed';
 const turn = (await db.query(`INSERT INTO turns(actor_id,session_id,request_id,kind,state,close_kind,policy,delivered,stopped_by_user,closed_at)
  VALUES($1,$2,$3,'report','closed',$4,$5,$6,$7,now()) RETURNING id`,
  [actor, session, request, close, JSON.stringify({reportGeneration: spec}), completeness === 'complete', close === 'stopped'])).rows[0].id;
 await db.query(`INSERT INTO session_messages(session_id,seq,role,turn_id,content,content_hash)
  VALUES($1,(SELECT coalesce(max(seq),0)+1 FROM session_messages WHERE session_id=$1),'assistant',$2,$3,encode(sha256(convert_to($3,'utf8')),'hex'))`,
  [session, turn, body]);
 return {turnId: turn};
}
