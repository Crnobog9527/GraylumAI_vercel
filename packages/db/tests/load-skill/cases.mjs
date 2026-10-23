/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CONTENT-CONVERSATION-DRIVEN load_skill (0340): the free-chat model loads a Skill from the catalog frozen at admission.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {runtimeFixture} from '../content-erasure/cases.mjs';

const entry = (name, n) => ({name, description: name + ' 的简介', moduleId: randomUUID(), skillId: randomUUID(),
  packageId: randomUUID(), revisionId: randomUUID(), packageHash: String(n).repeat(64).slice(0, 64), resultBytes: 400});
const resultOf = (c, instructions = '先问清主题，再写口播稿。') => ({name: c.name, moduleId: c.moduleId, packageId: c.packageId,
  revisionId: c.revisionId, packageHash: c.packageHash, instructions});

/** A running free-chat execution whose admission froze `catalog` and `maxSkillLoads`. */
async function freeChat(db, catalog, extra = {}) {
  const f = await runtimeFixture(db);
  await db.query(`UPDATE runtime_executions SET state='running',payload=$2 WHERE id=$1`, [f.execution,
    {input: '帮我写一条口播稿', role: 'ordinary', tools: ['load_skill'], skillCatalog: catalog, maxSkillLoads: 2, maxToolCalls: 4,
     ...extra}]);
  return f;
}
const tool = (db, f, call, name, action, result = null) => rpc(db, 'runtime_tool', f.actor, f.execution, call, 'load_skill',
  {query: name}, action, result);

export async function runCases({db, report}) {
  const failures = [];
  const check = async (name, run) => {try {await run();report.checks.push(name);} catch (error) {failures.push(name+': '+(error.stack??error));}};
  const a = entry('script-writer', 1), b = entry('caption-writer', 2), c = entry('title-writer', 3);

  await check('LOAD claim and complete a catalog Skill; the journal answers a replay', async () => {
    const f = await freeChat(db, [a, b]);
    assert.deepEqual(await tool(db, f, 'c1', a.name, 'claim'), {execute: true, result: null});
    const done = await tool(db, f, 'c1', a.name, 'complete', resultOf(a));
    assert.deepEqual(done.result, resultOf(a));
    assert.deepEqual(await tool(db, f, 'c1', a.name, 'claim'), {execute: false, result: resultOf(a)}, 'replay');
  });

  await check('LOAD refuses a name outside the frozen catalog, other arguments, and executions without a catalog', async () => {
    const f = await freeChat(db, [a]);
    await assert.rejects(tool(db, f, 'x', 'not-listed', 'claim'), /RUNTIME_TOOL_DENIED/);
    await assert.rejects(rpc(db, 'runtime_tool', f.actor, f.execution, 'y', 'load_skill', {name: a.name}, 'claim', null),
      /RUNTIME_TOOL_DENIED/, 'only the "query" key');
    const old = await freeChat(db, [a], {skillCatalog: undefined});
    await assert.rejects(tool(db, old, 'z', a.name, 'claim'), /RUNTIME_TOOL_DENIED/);
    const skill = await freeChat(db, [a], {role: 'skill'});
    await assert.rejects(tool(db, skill, 'z', a.name, 'claim'), /RUNTIME_TOOL_DENIED/, 'only ordinary free chat');
    const untooled = await freeChat(db, [a], {tools: ['read_source']});
    await assert.rejects(tool(db, untooled, 'z', a.name, 'claim'), /RUNTIME_TOOL_DENIED/, 'tool not frozen for this turn');
  });

  await check('LOAD at most maxSkillLoads (Owner: 2) per execution; replays of loaded calls still answer', async () => {
    const f = await freeChat(db, [a, b, c]);
    await tool(db, f, 'c1', a.name, 'claim');await tool(db, f, 'c1', a.name, 'complete', resultOf(a));
    await tool(db, f, 'c2', b.name, 'claim');await tool(db, f, 'c2', b.name, 'complete', resultOf(b));
    await assert.rejects(tool(db, f, 'c3', c.name, 'claim'), /RUNTIME_TOOL_DENIED/, 'third load');
    assert.equal((await tool(db, f, 'c2', b.name, 'claim')).execute, false, 'replay of the second load');
  });

  await check('LOAD a completed result must name exactly the frozen package', async () => {
    const f = await freeChat(db, [a, b]);
    await tool(db, f, 'c1', a.name, 'claim');
    await assert.rejects(tool(db, f, 'c1', a.name, 'complete', {...resultOf(a), revisionId: randomUUID()}), /RUNTIME_SKILL_LOAD_CONFLICT/);
    await assert.rejects(tool(db, f, 'c1', a.name, 'complete', resultOf(b)), /RUNTIME_SKILL_LOAD_CONFLICT/, 'another entry');
    await assert.rejects(tool(db, f, 'c1', a.name, 'complete', resultOf(a, '')), /RUNTIME_SKILL_LOAD_CONFLICT/, 'empty');
    await assert.rejects(tool(db, f, 'c1', a.name, 'complete', {...resultOf(a), extra: 1}), /RUNTIME_SKILL_LOAD_CONFLICT/);
    assert.deepEqual((await tool(db, f, 'c1', a.name, 'complete', resultOf(a))).result, resultOf(a));
  });

  await check('LOAD helpers are closed to every client role', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(db.query("SELECT runtime_load_skill_entry(NULL::runtime_executions,'{}')"), /permission denied/, role);
      } finally {await db.query('ROLLBACK');}
    }
  });

  if (failures.length) throw new Error(failures.join('\n\n'));
}
