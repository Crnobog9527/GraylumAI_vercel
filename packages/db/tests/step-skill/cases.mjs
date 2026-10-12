/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// R8b (0229): database rules for step Skills that the API integration suite cannot reach directly.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {seed,finalize} from '../report-finalization/cases.mjs';

export async function runCases({db,report}) {
 // Owner 2026-10-13 decision 1: a step Skill's finalized report is a result, not a positioning.
 const positioning=await seed(db);
 assert.equal((await finalize(db,positioning,undefined,0,randomUUID())).next?.kind,'first_week_topics','positioning unchanged');
 const step=await seed(db);
 await db.query("UPDATE artifact_projects SET work_kind='step_skill' WHERE id=$1",[step.project]);
 const final=await finalize(db,step);
 assert.equal(final.finalized,true);assert.equal(final.next,null);
 assert.equal(await rpc(db,'opc_source_allowed',step.actor,final.versionId),false,'never a positioning source');
 report.checks.push('a step Skill report finalizes into a result with no first-week topics and is never a positioning source');
 await db.query('SET ROLE authenticated');
 await assert.rejects(db.query('SELECT opc_step_flow_modules()'),/permission denied/);
 await db.query('RESET ROLE');
 report.checks.push('the step-flow module list is service-role only');
}
