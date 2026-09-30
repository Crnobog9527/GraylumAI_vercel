/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { actorFixture } from './erasure-b1b-barrier-fixtures.mjs';

export async function parentLocks({ q, Session }) {
  const retry = { retry: true, reason: 'transactions_pending' };
  const fresh = () => {
    const actor = actorFixture(q);
    const conversation = q(`INSERT INTO conversations(user_id,title) VALUES('${actor}','private') RETURNING id`);
    q(`SET ROLE service_role; SELECT account_erasure_confirm('${actor}',gen_random_uuid())`);
    return { actor, conversation };
  };
  const inputs = [
    { label: 'real legacy finalizer', table: 'messages', count: '2', call: (conversation, actor) => `SET LOCAL ROLE service_role;
      SELECT atomic_finalize_ai_success('${actor}',
        '${conversation}','private question','private answer','fixture',0,0)` },
    { label: 'context snapshot INSERT', table: 'conversation_context_snapshots', count: '1',
      call: conversation => `INSERT INTO conversation_context_snapshots(conversation_id,snapshot_type,content)
        VALUES('${conversation}','rolling_summary','private summary')` },
  ];
  for (const input of inputs) {
    // Writer first: actual child INSERT takes SHARE on its parent and stays in a live transaction.
    let ids = fresh();
    let writer = new Session('barrier-parent-first-writer');
    try {
      await writer.exec(`BEGIN; ${input.call(ids.conversation, ids.actor)}`);
      const result = JSON.parse(q(`SET ROLE service_role; SELECT account_erasure_scrub_runtime('${ids.actor}')`));
      assert.deepEqual(result, retry);
      assert.equal(q(`SELECT erased_at IS NULL FROM conversations WHERE id='${ids.conversation}'`), 't');
      await writer.exec('COMMIT');
      await writer.end();
      q(`SET ROLE service_role; SELECT account_erasure_scrub_runtime('${ids.actor}')`);
      assert.equal(q(`SELECT count(*) FROM ${input.table}
        WHERE conversation_id='${ids.conversation}' AND erased_at IS NOT NULL AND content IS NULL`), input.count);
    } finally { if (writer.code === undefined) await writer.end(); }
    console.log(`PASS ${input.label} first: live parent SHARE blocks scrub; committed children erased on retry`);

    // Scrubber first: start the late no-active INSERT only after scrub returns while retaining
    // its FOR UPDATE locks. Observe the real transaction lock wait before releasing the scrubber.
    ids = fresh();
    const controller = new Session('barrier-parent-first-scrubber');
    writer = new Session('barrier-parent-late-writer');
    try {
      const result = JSON.parse(await controller.exec(`BEGIN; SET LOCAL ROLE service_role;
        SELECT account_erasure_scrub_runtime('${ids.actor}')`));
      assert.equal(result.conversations, 1);
      const pending = writer.exec(`BEGIN; ${input.call(ids.conversation, ids.actor)}; COMMIT`);
      pending.catch(() => {});
      let waiting = false;
      const until = Date.now() + 10000;
      while (Date.now() < until && !waiting) {
        waiting = q(`SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='${writer.label}'
          AND wait_event_type='Lock' AND wait_event IN ('transactionid','tuple'))`) === 't';
        if (!waiting) await new Promise(done => setTimeout(done, 20));
      }
      assert.ok(waiting, 'Child INSERT must wait on the scrubber parent row lock');
      await controller.exec('COMMIT');
      await assert.rejects(pending, /ERASURE_PARENT_CLEARED/);
      await writer.closed;
      assert.equal(q(`SELECT count(*) FROM ${input.table} WHERE conversation_id='${ids.conversation}'`), '0');
    } finally {
      await controller.end();
      if (writer.code === undefined) writer.child.stdin.end('ROLLBACK;\n\\q\n');
    }
    console.log(`PASS scrub first: ${input.label} waits then refuses cleared parent without new content`);
  }
}
