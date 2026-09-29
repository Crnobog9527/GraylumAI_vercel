/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownCell } from '../research0/markdownCell.mjs';
import { formatMarkdown } from '../research0/markdown.mjs';
import { formatMonidCatalog } from '../research0/monidCatalog.mjs';

const malicious = '\\| extra\r\n<script>alert(1)</script> [link](javascript:alert(1))';

test('comparison output keeps untrusted labels as text in one table cell', () => {
  const report = { mode: 'reanalyze', generatedAt: 'synthetic', vendors: [
    { label: malicious, queries: [] },
  ] };
  const row = formatMarkdown(report, []).split('\n')[4];
  assert.equal(row.split('|').length, 11);
  assert.ok(!row.includes('<script>'));
  assert.ok(!row.includes('[link]'));
  assert.ok(!row.includes('\r'));
});

test('catalogue output keeps backslashes, pipes, CRLF and markup inside a cell', () => {
  const report = { steps: [], balances: [], spentUsd: 0, tools: [
    { from: 'synthetic', provider: malicious, tags: ['plain'] },
  ] };
  const markdown = formatMonidCatalog(report);
  const row = markdown.split('\n').at(-1);
  assert.equal(markdown.split('\n').length, 5);
  assert.equal(row.split('|').length, 9);
  assert.ok(!row.includes('<script>'));
  assert.ok(!row.includes('[link]'));
});

test('plain values keep their visible contents and metacharacters become literal text', () => {
  assert.equal(markdownCell('中文 plain 1/3 $0.05'), '中文 plain 1/3 $0.05');
  assert.equal(markdownCell(null), '');
  assert.equal(markdownCell('a\\|b'), 'a&#92;&#124;b');
  assert.equal(markdownCell('&lt;'), '&#38;lt;');
});
