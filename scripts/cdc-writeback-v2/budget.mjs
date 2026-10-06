/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { assert, settlementNano } from '../cdc-b2-eval/reasoningSource.mjs';

export const root = join(userInfo().homedir, '.graylum/cdc-writeback-v2-20261006');
export const capNano = 5_000_000_000;
const integer = value => Number.isSafeInteger(value) && value >= 0;

// One private journal for all four stages. A pending call or a recorded stop is terminal:
// restarting the process must never turn an uncertain request into a fresh dispatch.
export function budgetState(events) {
  const state = { settledNano: 0, pending: null, stopped: false, calls: new Set() };
  for (const event of events) {
    assert(!state.stopped, 'JOURNAL_AFTER_STOP');
    if (event.type === 'reserve') {
      assert(!state.pending && !state.calls.has(event.id), 'CALL_ALREADY_RESERVED');
      assert(typeof event.id === 'string' && event.id.length > 0, 'CALL_ID');
      assert(['baseline', 'fields', 'prompt', 'suggestions'].includes(event.stage), 'STAGE');
      assert(/^[a-f0-9]{64}$/.test(event.requestHash), 'REQUEST_HASH');
      assert(integer(event.nano) && event.nano > 0 && state.settledNano + event.nano <= capNano, 'BUDGET_STOP');
      state.calls.add(event.id);
      state.pending = event;
    } else if (event.type === 'settle') {
      assert(state.pending?.id === event.id && integer(event.nano), 'SETTLEMENT_ID');
      assert(event.nano <= state.pending.nano, 'RESERVE_EXCEEDED_STOP');
      state.settledNano += event.nano;
      state.pending = null;
    } else {
      assert(event.type === 'stop' && typeof event.code === 'string', 'JOURNAL_EVENT');
      state.stopped = true;
    }
  }
  return state;
}

export function openBudget(directory = root) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'budget.lock');
  // An abrupt exit leaves this lock intact: investigate, do not auto-unlock or resend.
  const lockFd = openSync(lock, 'wx', 0o600);
  let journalFd;
  try {
    const path = join(directory, 'budget.jsonl');
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    assert(raw === '' || raw.endsWith('\n'), 'JOURNAL_TRUNCATED');
    const events = raw === '' ? [] : raw.trimEnd().split('\n').map(JSON.parse);
    let state = budgetState(events);
    assert(!state.pending && !state.stopped, 'BUDGET_PREVIOUS_STOP');
    journalFd = openSync(path, 'a', 0o600);
    let closed = false;
    let writeFailed = false;
    function append(event) {
      assert(!closed, 'BUDGET_CLOSED');
      assert(!writeFailed, 'JOURNAL_WRITE_FAILED');
      const next = budgetState([...events, event]);
      // Persist before returning permission to send. A failed write never permits dispatch.
      const data = Buffer.from(JSON.stringify({ ...event, at: new Date().toISOString() }) + '\n');
      try {
        let offset = 0;
        while (offset < data.length) {
          const written = writeSync(journalFd, data, offset, data.length - offset);
          assert(written > 0, 'JOURNAL_WRITE_FAILED');
          offset += written;
        }
        fsyncSync(journalFd);
      } catch (error) {
        writeFailed = true;
        throw error;
      }
      events.push(event);
      state = next;
    }
    return {
      reserve({ id, stage, requestHash, nano }) { append({ type: 'reserve', id, stage, requestHash, nano }); },
      settle(id, cost) {
        assert(state.pending?.id === id, 'SETTLEMENT_ID');
        append({ type: 'settle', id, nano: settlementNano(cost, state.pending.nano) });
      },
      stop(code) { append({ type: 'stop', code }); },
      snapshot() {
        return { settledNano: state.settledNano, pendingNano: state.pending?.nano ?? 0,
          dispatched: state.calls.size, stopped: state.stopped, capNano };
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(journalFd);
        closeSync(lockFd);
        unlinkSync(lock);
      },
    };
  } catch (error) {
    if (journalFd !== undefined) closeSync(journalFd);
    closeSync(lockFd);
    unlinkSync(lock);
    throw error;
  }
}
