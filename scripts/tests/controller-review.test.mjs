/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { independentReviewPassed } from '../controller-review.mjs';
const head = '1234567890abcdef1234567890abcdef12345678';
const pass = `独立审查通过\n<!-- graylum-independent-review:v1 commit=${head} verdict=pass -->`;
const check = (...bodies) => independentReviewPassed(bodies.map(body => ({ body })), head);

test('accepts one explicit full-commit passing independent receipt', () => {
  assert.equal(check(pass), true);
  assert.equal(independentReviewPassed([[{ body: pass }]], head), true);
  assert.equal(independentReviewPassed([[{ body: pass }], [{ body: `独立审查 ${head} 未通过` }]], head), false);
  assert.equal(independentReviewPassed([null], head), false);
  assert.equal(check(pass, '一般说明，不是审查'), true);
});
for (const body of [
  `独立审查 ${head.slice(0, 9)} 未通过：发现权限回归`,
  `独立审查 ${head} 不通过`, `独立审查 ${head} 需修改`, `独立审查 ${head} 通过`,
  pass.replace(head, head.slice(0, 9)), pass.replace(head, 'a'.repeat(40)),
  pass.replace('verdict=pass', 'verdict=fail'), `${pass}\n${pass}`, `${pass}\n未通过：权限回归`,
]) test(`rejects ambiguous, negative or stale receipt: ${body.slice(0, 60)}`, () => assert.equal(check(body), false));
test('a later rejection overrides an earlier pass for the same commit', () => {
  assert.equal(check(pass, `独立审查 ${head} 未通过：发现权限回归`), false);
  assert.equal(check(pass, pass.replace('verdict=pass', 'verdict=fail')), false);
  assert.equal(check(pass, `独立审查 ${head} 尚在进行`), false);
});
