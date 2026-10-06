/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {hash,CAP_NANO} from './policy';
/** Owner-authorized one second round, not a reusable evaluation budget reset. */
export const secondRound = Object.freeze({round:2,previousManifest:
 'c8e37f1f2b915f72912dde3f2f46caeec364db3c733e95fdfc22fe5330effd07',
 priorOfficialUsd:1.00869884,priorNano:1008698844,
 priorLedgerHash:'a3c329f77ca4567b9353a6e4cd0ddf7e42fe377f6e61c0d41ce18d27f33c3d19',
 remainingNano:CAP_NANO-1008698844});
export function verifyPriorRound(plan:{groups:unknown;moduleSkill:unknown}) {
 const previous=join(homedir(),'.graylum/cdc-b2-eval/freeze-07');
 const ledger=readFileSync(join(previous,'live/ledger.json'));
 if(hash(ledger)!==secondRound.priorLedgerHash)throw new Error('CDC_PRIOR_LEDGER_CHANGED');
 const state=JSON.parse(ledger.toString());
 if(state.pending||state.nano!==secondRound.priorNano||state.calls.mentor!==70||state.calls.organizer!==30)
  throw new Error('CDC_PRIOR_COST_UNKNOWN');
 const manifest=JSON.parse(readFileSync(join(previous,'manifest.json'),'utf8'));
 if(hash(JSON.stringify(manifest))!==secondRound.previousManifest)throw new Error('CDC_PRIOR_MANIFEST_CHANGED');
 const first=JSON.parse(readFileSync(join(previous,'run-input.json'),'utf8'));
 if(hash(JSON.stringify(plan.groups))!==hash(JSON.stringify(first.groups))||
  hash(JSON.stringify(plan.moduleSkill))!==hash(JSON.stringify(first.moduleSkill)))throw new Error('CDC_ROSTER_OR_SKILL_CHANGED');
 return secondRound;
}
