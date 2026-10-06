/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {CAP_NANO} from './policy';
import {verifyPriorRound,verifyLocalRound} from './secondRound';
/** Owner-authorized final third round; priorNano is the cumulative settled ledger. */
export const thirdRound=Object.freeze({round:3,previousManifest:
 'ee8f408ba6e34635216b3b8aefd977ad0c9af0d675a1060f2fba97b1cc181edd',
 priorOfficialUsd:1.955565140,priorNano:1955565146,
 priorInputHash:'5c1fa104f6ebae3cc94b75a90dcd4a93d851b84b26a9f08cc42046a170df0939',
 priorLedgerHash:'707bec20d7aef487721c71530efb6f367dec29ee8c0ab9516bbeeba89b280518',
 remainingNano:CAP_NANO-1955565146});
export function verifyPriorRounds(plan:{groups:unknown;moduleSkill:unknown}){
 verifyPriorRound(plan);
 verifyLocalRound(plan,'freeze-round2-02',thirdRound);
 return thirdRound;
}
