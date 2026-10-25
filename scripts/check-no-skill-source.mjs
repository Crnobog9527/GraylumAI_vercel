#!/usr/bin/env node

// Skill source text lives only in the private repository graylum-skills (docs/skills/workflow-manifest.md). The public
// repository must contain no Skill package files; the baseline is 0. Test fixtures and tool folders are exempt.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SKILL_FILE = /(^|\/)(SKILL\.md|EVALS\.md|workflow\.yaml|references\/[^/]+\.md|assets\/[^/]+\.md)$/;
const EXEMPT = ['packages/api/src/services/__tests__/fixtures/', '.agents/', '.claude/'];

export function findSkillSourceFiles(files) {
  return files.filter(file => SKILL_FILE.test(file) && !EXEMPT.some(prefix => file.startsWith(prefix)));
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const found = findSkillSourceFiles(stdout.split('\0').filter(Boolean));
  for (const file of found) console.error(`Skill source file in the public repository: ${file}`);
  if (found.length) {
    console.error('Skill source belongs only in the private repository graylum-skills.');
    process.exitCode = 1;
    return;
  }
  console.log('No Skill source files in the public repository.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
