/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {hash,CAP_NANO} from './policy';
/** Owner-authorized one second round, not a reusable evaluation budget reset. */
export const secondRound = Object.freeze({round:2,previousManifest:
 'c8e37f1f2b915f72912dde3f2f46caeec364db3c733e95fdfc22fe5330effd07',
 priorOfficialUsd:1.00869884,priorNano:1008698844,
 priorInputHash:'fe106326a993a3452d576c0b2ecf731a4412610bbca6fc0becd87ef71aeb5e8f',
 priorLedgerHash:'a3c329f77ca4567b9353a6e4cd0ddf7e42fe377f6e61c0d41ce18d27f33c3d19',
 remainingNano:CAP_NANO-1008698844});
type Plan={groups:unknown;moduleSkill:unknown};
type Evidence={ledger:Buffer;manifest:Buffer;input:Buffer};
type Identity={priorInputHash:string;priorLedgerHash:string;priorNano:number;previousManifest:string};
/** Separate immutable evidence parsing from local file IO for fail-closed tests. */
export function verifyRoundEvidence(plan:Plan,evidence:Evidence,identity:Identity){
 if(hash(evidence.ledger)!==identity.priorLedgerHash)throw new Error('CDC_PRIOR_LEDGER_CHANGED');
 const state=JSON.parse(evidence.ledger.toString());
 if(state.pending||state.nano!==identity.priorNano||state.calls.mentor!==70||state.calls.organizer!==30)
  throw new Error('CDC_PRIOR_COST_UNKNOWN');
 const manifest=JSON.parse(evidence.manifest.toString());
 if(hash(JSON.stringify(manifest))!==identity.previousManifest)throw new Error('CDC_PRIOR_MANIFEST_CHANGED');
 if(hash(evidence.input)!==identity.priorInputHash)throw new Error('CDC_PRIOR_INPUT_CHANGED');
 const first=JSON.parse(evidence.input.toString());
 if(hash(JSON.stringify(plan.groups))!==hash(JSON.stringify(first.groups))||
  hash(JSON.stringify(plan.moduleSkill))!==hash(JSON.stringify(first.moduleSkill)))throw new Error('CDC_ROSTER_OR_SKILL_CHANGED');
}
export function verifyLocalRound(plan:Plan,directory:string,identity:Identity){
 const previous=join(homedir(),'.graylum/cdc-b2-eval',directory);
 verifyRoundEvidence(plan,{ledger:readFileSync(join(previous,'live/ledger.json')),
  manifest:readFileSync(join(previous,'manifest.json')),input:readFileSync(join(previous,'run-input.json'))},identity);
}
export function verifyPriorRound(plan:Plan){
 verifyLocalRound(plan,'freeze-07',secondRound);
 return secondRound;
}
