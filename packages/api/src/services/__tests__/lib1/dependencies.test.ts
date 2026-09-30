import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const { zipFixture } = require('./zip-fixture.cjs') as {
  zipFixture: (entries: Array<{
    name?: string; body?: string | Buffer; deflate?: boolean; declaredSize?: number;
    flags?: number; symlink?: boolean; badCrc?: boolean;
  }>) => Buffer;
};
const probe = fileURLToPath(new URL('./probe.cjs', import.meta.url));
const moduleRoots = ['yauzl', 'sax', 'pend'].flatMap(name => {
  const location = name === 'pend' ? createRequire(require.resolve('yauzl')) : require;
  const root = dirname(realpathSync(location.resolve(`${name}/package.json`)));
  // Permission checks also see the unresolved package alias. Derive it from
  // Node's resolver search paths rather than assuming a pnpm directory layout.
  const alias = location.resolve.paths(name)?.map(base => resolve(base, name))
    .find(candidate => existsSync(candidate) && realpathSync(candidate) === root);
  return alias ? [root, alias] : [root];
});

async function run(input: Buffer, mode = 'parse') {
  const cwd = mkdtempSync(resolve(tmpdir(), 'lib1-'));
  const child = spawn(process.execPath, [
    '--permission', `--allow-fs-read=${dirname(probe)}`,
    ...moduleRoots.map(root => `--allow-fs-read=${root}`),
    '--max-old-space-size=128', '--disallow-code-generation-from-strings',
    probe, mode, resolve(cwd, 'not-readable'),
  ], { cwd, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let diagnostic = '';
  let timedOut = false;
  let outputExceeded = false;
  let deadline = setTimeout(kill, 15_000);
  function kill() { timedOut = true; child.kill('SIGKILL'); }
  child.stdout.on('data', data => {
    output += data.toString();
    if (mode === 'hang' && output.includes('READY') && !timedOut) {
      clearTimeout(deadline);
      deadline = setTimeout(kill, 100);
    }
    if (Buffer.byteLength(output) > 64_000) { outputExceeded = true; child.kill('SIGKILL'); }
  });
  child.stderr.on('data', data => {
    diagnostic += data.toString();
    if (Buffer.byteLength(diagnostic) > 64_000) { outputExceeded = true; child.kill('SIGKILL'); }
  });
  // A child may reject input before the parent finishes writing it.
  child.stdin.on('error', error => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') diagnostic += error.message;
  });
  child.stdin.end(input);
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept({ code, signal }));
    });
    expect(readdirSync(cwd)).toEqual([]);
    expect(outputExceeded).toBe(false);
    return { ...exit, output, diagnostic, timedOut, pid: child.pid };
  } finally {
    clearTimeout(deadline);
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function rejects(input: Buffer, message: RegExp) {
  const result = await run(input);
  expect(result.timedOut).toBe(false);
  expect(result.code, result.diagnostic).toBe(1);
  expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: expect.stringMatching(message) });
}

describe('LIB-1 dependency qualification (test-only, no upload or OOXML implementation)', () => {
  it('loads the exact selected versions under Node 24', () => {
    expect(process.versions.node.split('.')[0]).toBe('24');
    expect(require('yauzl/package.json').version).toBe('3.4.0');
    expect(require('sax/package.json').version).toBe('1.6.1');
  });
  it('streams a benign namespaced XML member, including UTF-8 text and CRC', async () => {
    const result = await run(zipFixture([{ body: '<w:document xmlns:w="urn:test"><w:t>中文</w:t></w:document>', deflate: true }]));
    expect(result.code, result.diagnostic).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, entries: 1, text: 6 });
  });
  it.each(['../escape', '/absolute', 'C:/drive', 'word\\escape'])('rejects ZIP-slip path %s', async name => {
    await rejects(zipFixture([{ name, body: 'x' }]), /invalid|absolute/i);
  });
  it('rejects dot-component path aliases in the probe', async () => {
    await rejects(zipFixture([{ name: 'word/./document.xml', body: '<x/>' }]), /^PATH_ALIAS$/);
  });
  it('rejects high-ratio ZIP bombs before decompression', async () => {
    await rejects(zipFixture([{ body: 'x'.repeat(1_000_000), deflate: true }]), /RATIO/);
  });
  it('rejects an understated deflated size from the actual stream', async () => {
    await rejects(
      zipFixture([{ body: 'x'.repeat(100_000), deflate: true, declaredSize: 100 }]),
      /^too many bytes in the stream\. expected 100\. got at least \d+$/,
    );
  });
  it.each([
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///not-a-real-file">]><x>&e;</x>',
    '<!DOCTYPE x SYSTEM "https://example.invalid/xxe"><x/>',
    '<!DOCTYPE x [<!ENTITY a "123"><!ENTITY b "&a;&a;&a;">]><x>&b;</x>',
  ])('rejects DTD and external/internal entity declarations', async body => {
    await rejects(zipFixture([{ body }]), /DTD_FORBIDDEN/);
  });
  it('rejects invalid ZIP, truncated ZIP, malformed XML and bad CRC', async () => {
    await rejects(Buffer.from('not a ZIP'), /central directory|signature/i);
    const valid = zipFixture([{ body: '<x/>' }]);
    await rejects(valid.subarray(0, valid.length - 5), /central directory|signature/i);
    await rejects(zipFixture([{ body: '<x>' }]), /Unclosed|Unexpected/i);
    await rejects(zipFixture([{ body: '<x/>', badCrc: true }]), /CRC_MISMATCH/);
  });
  it('rejects input above 10,000,000 bytes', async () => {
    await rejects(Buffer.alloc(10_000_001), /INPUT_LIMIT/);
  });
  it('rejects actual text output over 10,000,000 UTF-8 bytes', async () => {
    const text = randomBytes(7_500_003).toString('base64');
    const input = zipFixture([{ body: `<x>${text}</x>`, deflate: true }]);
    expect(input.length).toBeLessThan(10_000_000);
    await rejects(input, /TEXT_SIZE/);
  });
  it('rejects declared entry size above 20,000,000 bytes', async () => {
    await rejects(zipFixture([{ deflate: true, declaredSize: 20_000_001 }]), /ENTRY_SIZE/);
  });
  it('rejects too many entries, duplicate names, symlinks and encryption', async () => {
    await rejects(zipFixture(Array.from({ length: 2_001 }, (_, i) => ({ name: String(i) }))), /ENTRY_COUNT/);
    await rejects(zipFixture([{ body: '<x/>' }, { body: '<x/>' }]), /DUPLICATE/);
    await rejects(zipFixture([{ symlink: true }]), /SYMLINK/);
    await rejects(zipFixture([{ flags: 1, deflate: true }]), /ENCRYPTED/);
  });
  it('rejects XML depth over 64 and oversized sax tokens', async () => {
    await rejects(zipFixture([{ body: '<x>'.repeat(65) + '</x>'.repeat(65) }]), /XML_DEPTH/);
    await rejects(zipFixture([{ body: `<x a="${'x'.repeat(100_000)}"/>` }]), /^XML_TOKEN$/);
  });
  it('kills and reaps a CPU-bound child instead of only timing out a Promise', async () => {
    const result = await run(Buffer.alloc(0), 'hang');
    expect(result.output).toContain('READY');
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    expect(() => process.kill(result.pid!, 0)).toThrow();
  });
  it('removes environment credentials and denies extra file reads, writes and spawning', async () => {
    const result = await run(Buffer.alloc(0), 'permissions');
    expect(result.code, result.diagnostic).toBe(0);
    const body = JSON.parse(result.output);
    expect(body).toMatchObject({ ok: true, codes: ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED'] });
    // macOS injects this platform encoding key even with an empty spawn env.
    expect(body.envKeys.filter((key: string) => key !== '__CF_USER_TEXT_ENCODING')).toEqual([]);
  });
});
