/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFromFiles, installPgCronStub } from './baseline/build-from-files.mjs';
import { POSTGRES_IMAGE } from './v3/images.mjs';

export async function localDatabase() {
  const root = resolve(import.meta.dirname, '../../..');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const options = { cwd: root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 };
  const ok = result => {
    if (result.error || result.status !== 0) throw new Error(result.stderr || String(result.error || result.status));
    return result.stdout.trim();
  };
  const endpoint = ok(spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], options));
  assert.ok(endpoint.startsWith('unix:///') && !endpoint.includes('\n'), 'Only a local Unix Docker socket is allowed');
  const name = `graylum-b1b-barrier-${randomUUID().slice(0, 8)}`;
  const docker = (args, input) => spawnSync('docker', ['--host', endpoint, ...args], { ...options, input });
  const args = ['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'dbb', '-v', 'ON_ERROR_STOP=1'];
  const sql = input => docker([...args, '-f', '/dev/stdin'], input);
  const q = input => ok(sql(input));
  const sessions = new Set();
  class Session {
    constructor(label) {
      this.label = label;
      this.child = spawn('docker', ['--host', endpoint, ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.output = '';
      this.error = '';
      this.sequence = 0;
      this.child.stdout.on('data', chunk => { this.output += chunk; });
      this.child.stderr.on('data', chunk => { this.error += chunk; });
      this.closed = new Promise(done => this.child.once('close', code => { this.code = code; done(code); }));
      this.child.stdin.write(`SET application_name='${label}'; SET statement_timeout='15s';\n`);
      sessions.add(this);
    }
    async exec(input) {
      const marker = `BARRIER_READY_${++this.sequence}`;
      this.output = '';
      this.child.stdin.write(`${input}; SELECT '${marker}';\n`);
      const until = Date.now() + 20000;
      while (!this.output.includes(marker)) {
        if (this.error.includes('ERROR:') || this.code !== undefined) throw new Error(`${this.label}: ${this.error}`);
        if (Date.now() > until) throw new Error(`${this.label}: session barrier timeout`);
        await new Promise(done => setTimeout(done, 20));
      }
      return this.output.split(marker)[0].trim();
    }
    async end() {
      if (this.code === undefined) this.child.stdin.end('ROLLBACK;\n\\q\n');
      assert.equal(await this.closed, 0, this.error);
      sessions.delete(this);
    }
  }
  const cleanup = async () => {
    for (const session of sessions) {
      session.child.stdin.destroy();
      session.child.kill();
    }
    ok(docker(['rm', '-f', '-v', name]));
  };
  try {
    ok(docker(['image', 'inspect', POSTGRES_IMAGE]));
    ok(docker(['run', '-d', '--pull=never', '--name', name, '-e', 'POSTGRES_DB=dbb',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE, '-c', 'max_prepared_transactions=10']));
    let ready = false;
    for (let attempt = 0; attempt < 300 && !ready; attempt += 1) {
      ready = docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'dbb']).status === 0;
      if (!ready) await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(ready, 'Local PostgreSQL readiness');
    installPgCronStub(root, name, (argv, input) => ok(docker(['exec', ...argv], input)));
    const outcome = result => ({ ok: result.status === 0 && !result.error, error: result.stderr });
    const built = buildFromFiles(root, {
      applyFile: path => outcome(sql(readFileSync(resolve(root, path), 'utf8'))),
      applyServerOnly: input => outcome(sql(input)),
    });
    assert.equal(built.failed, null, JSON.stringify(built.failed));
    return { q, sql, Session, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
