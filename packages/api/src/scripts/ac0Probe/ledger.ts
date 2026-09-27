/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {nanoToUsd, usdToNano, type LedgerStore, type LedgerTotals} from './budget.ts';

/** Usage spent outside this script (for example browser measurement), entered by hand. */
export type ExternalEntry = {calls: number; nanoUsd: number; usd: number; note?: string; recordedAt: string};
type LedgerFile = LedgerTotals & {external: ExternalEntry[]};

const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

function invalid(path: string): never {
  throw new Error(`PROBE_LEDGER_INVALID: ${path} cannot be read as a ledger; fix it by hand. It is never treated as empty.`);
}

/** A missing ledger is a first run. Anything else that cannot be read refuses. */
function readLedgerFile(path: string): LedgerFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {calls: 0, nanoUsd: 0, external: []};
    return invalid(path);
  }
  let parsed: Partial<LedgerFile>;
  try {
    parsed = JSON.parse(text) as Partial<LedgerFile>;
  } catch {
    return invalid(path);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid(path);
  const external = parsed.external ?? [];
  if (!count(parsed.calls) || !count(parsed.nanoUsd) || !Array.isArray(external) ||
    external.some(entry => !entry || !count(entry.calls) || !count(entry.nanoUsd))) {
    return invalid(path);
  }
  return {calls: parsed.calls!, nanoUsd: parsed.nanoUsd!, external};
}

/** Written to a temporary file and renamed, so a crash never leaves half a ledger. */
function writeLedgerFile(path: string, file: LedgerFile): void {
  mkdirSync(dirname(path), {recursive: true});
  const temporary = `${path}.${process.pid}.tmp`;
  const body = {...file, usd: nanoToUsd(file.nanoUsd), updatedAt: new Date().toISOString()};
  writeFileSync(temporary, JSON.stringify(body, null, 2) + '\n');
  renameSync(temporary, path);
}

/** Cumulative totals across live runs, stored outside the repository. Each call
 * is written as a reservation before it is sent, so a crash cannot hide spend.
 * Use only while holding acquireLedgerLock(). */
export function fileLedger(path: string): LedgerStore {
  return {
    read() {
      const file = readLedgerFile(path);
      return {calls: file.calls, nanoUsd: file.nanoUsd};
    },
    write(totals) {
      writeLedgerFile(path, {...readLedgerFile(path), calls: totals.calls, nanoUsd: totals.nanoUsd});
    },
  };
}

/** One live run or one manual entry at a time. A lock left by an abnormal exit
 * stays until a person confirms no run is active and deletes it. */
export function acquireLedgerLock(ledgerPath: string): () => void {
  const lock = ledgerPath + '.lock';
  mkdirSync(dirname(lock), {recursive: true});
  let descriptor: number;
  try {
    descriptor = openSync(lock, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`PROBE_LEDGER_LOCKED: ${lock} exists. Another live run may be active or ended abnormally; ` +
      'confirm no run is active, then delete the lock by hand.');
  }
  try {
    writeFileSync(descriptor, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}) + '\n');
  } finally {
    closeSync(descriptor);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(lock, {force: true});
  };
}

/** Adds usage spent outside this script to the same Owner budget. Sends nothing. */
export function recordExternalUsage(path: string, entry: {calls: number; usd: number; note?: string}): LedgerFile {
  const file = readLedgerFile(path);
  const nanoUsd = usdToNano(entry.usd);
  const record: ExternalEntry = {
    calls: entry.calls, nanoUsd, usd: nanoToUsd(nanoUsd), ...(entry.note ? {note: entry.note} : {}), recordedAt: new Date().toISOString(),
  };
  const next = {calls: file.calls + entry.calls, nanoUsd: file.nanoUsd + nanoUsd, external: [...file.external, record]};
  writeLedgerFile(path, next);
  return next;
}
