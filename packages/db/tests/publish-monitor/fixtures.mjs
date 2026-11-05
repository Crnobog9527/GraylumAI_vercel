/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Shared PUBLISH-MONITOR local DB fixtures: a member with a business and one brand account on a platform.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { refusalsMigration } from '../refusal-codes/migration.mjs';
export const fixtureSql = `CREATE SCHEMA IF NOT EXISTS pm_test;
CREATE OR REPLACE FUNCTION pm_test.member(a uuid,plat text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE sk uuid:=gen_random_uuid();m uuid:=gen_random_uuid();rev uuid:=gen_random_uuid();p uuid:=gen_random_uuid();
 r uuid:=gen_random_uuid();v uuid:=gen_random_uuid();ac uuid:=gen_random_uuid();bus uuid:=gen_random_uuid();
BEGIN
 INSERT INTO skills(id,skill_key,content_kind) VALUES(sk,'pm-'||sk,'directory');
 INSERT INTO modules(id,title,skill_id,active) VALUES(m,'PM fixture',sk,true);
 INSERT INTO skill_revisions(id,skill_id,version,content,content_hash,published_by) VALUES(rev,sk,1,'fixture',repeat('a',64),a);
 INSERT INTO skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)
 VALUES(rev,sk,gen_random_uuid(),'{}',repeat('b',64),repeat('a',64),0,a);
 INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
 VALUES(p,a,m,sk,'source-'||p,'source title',1),(ac,a,m,sk,'account-'||ac,'account title',0);
 INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
 VALUES(r,p,rev,repeat('b',64),'{}',repeat('c',64),repeat('d',64),'published','{}');
 INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) VALUES(v,p,r,1,'{}',repeat('e',64),'[]');
 INSERT INTO opc_businesses(id,actor_id,name,current_source_version_id) VALUES(bus,a,'business',v);
 INSERT INTO opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id) VALUES(ac,a,plat,'pm-'||ac,v,bus);
 RETURN ac;
END $$;`;

// PR-3a refresh migration (file name; number assigned by the controller).
export const REFRESH_MIGRATION = '0272_publish_monitor_refresh.sql';

// Every later publish-monitor migration after `from`, in order, so a reapplication check replays the chain
// that really redefines its functions (MAINT-P1: the hand-written list had gone stale once CI ran this suite).
// Also the cross-domain migration that rewrote the publish-job refusals to PT409 (its name is not publish_monitor_*), and the turn
// steps history (0507), which redefines turn_close after the publish-monitor screenshot migration (0503) and so must replay after it.
// A migration that still names an object batch F drops (the old run tables and functions) cannot be replayed on the finished database
// (V2-12 F); the ones that only mention them in a comment still can.
const OLD_OBJECTS = /^(?!\s*--).*\b(runtime_executions|bill2_prepare|bill2_runs|bill2_calls|bill2_claim|bill2_close|bill2_receipts|runtime_tool_calls|runtime_session_history|runtime_admit\w*|runtime_cancel|report_fees|fusion_billing_groups|fusion_review_fees)\b/m;
const REFUSALS = /^\d{4}_refusals_no_postgrest_retry\.sql$/; // replays without its content_erasure_confirm copy (replaySql)
const namesDroppedPrepare = file => !REFUSALS.test(file) && OLD_OBJECTS.test(readFileSync(resolve(import.meta.dirname, '../../migrations', file), 'utf8'));
export const laterRedefinitions = from => readdirSync(resolve(import.meta.dirname, '../../migrations'))
  .filter(file => /^\d{4}_(?:publish_monitor.*|turn_steps_history|mentor_turn_steps_history|refusals_no_postgrest_retry)\.sql$/.test(file) && file.slice(0, 4) > from && !namesDroppedPrepare(file)).sort()
  .map(file => `packages/db/migrations/${file}`);

// The SQL to replay for one path laterRedefinitions returned.
export const replaySql = path => REFUSALS.test(path.split('/').pop()) ? refusalsMigration() : readFileSync(resolve(import.meta.dirname, '../../../..', path), 'utf8');
