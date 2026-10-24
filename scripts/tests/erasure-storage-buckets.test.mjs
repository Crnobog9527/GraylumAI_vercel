// DATA-ERASURE T01: every place that opens a Storage bucket opens a bucket account erasure already clears.
// Each storage.from(...) call is checked by its argument: a new call site, or a call in a reviewed file that
// opens anything else, fails here until its erasure path is reviewed and listed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const read = file => readFileSync(path.join(root, file), 'utf8');

// Bucket -> how account erasure removes its objects.
const ERASED_BUCKETS = {
  'ticket-attachments': 'packages/api/src/services/accountErasure/storage.ts',
  'library-documents': 'packages/api/src/services/library/erasure.ts',
};
// Reviewed call sites -> argument passed to storage.from -> where that argument is defined.
// A string literal needs no definition; an identifier must resolve to `const NAME = '<bucket>'` in that file.
const CALL_SITES = {
  'apps/web/src/app/api/upload/upload-intent.ts': { "'ticket-attachments'": null },
  'packages/api/src/lib/ticketAttachments.ts': { TICKET_ATTACHMENT_BUCKET: 'packages/api/src/lib/ticketAttachments.ts' },
  'packages/api/src/services/accountErasure/storageTransport.ts': { bucket: 'packages/api/src/services/accountErasure/storageTransport.ts' },
  'packages/api/src/services/library/storage.ts': { BUCKET: 'packages/api/src/services/library/content.ts' },
};

const sources = () => execFileSync('git', ['ls-files', '--', ':(glob)apps/*/src/**', ':(glob)packages/*/src/**'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(file => /\.(ts|tsx|mjs|js)$/.test(file) && !/(\.test\.|\.integration\.|__tests__\/)/.test(file));
const storageCalls = source => [...source.matchAll(/storage\s*\.\s*from\s*\(\s*([^)]*?)\s*\)/g)].map(match => match[1]);
function resolveBucket(argument, definedIn) {
  const literal = /^'([a-z0-9-]+)'$/.exec(argument);
  if (literal) return definedIn === null ? literal[1] : undefined;
  if (!/^[A-Za-z_]\w*$/.test(argument) || !definedIn) return undefined;
  return new RegExp(`\\bconst\\s+${argument}\\s*=\\s*'([a-z0-9-]+)'`).exec(read(definedIn))?.[1];
}

test('every storage.from call site is reviewed for account erasure', () => {
  const found = sources().filter(file => storageCalls(read(file)).length > 0);
  assert.deepEqual(found.sort(), Object.keys(CALL_SITES).sort());
});

test('every storage.from call opens a bucket that account erasure clears', () => {
  for (const file of Object.keys(CALL_SITES)) {
    const calls = storageCalls(read(file));
    assert.ok(calls.length > 0, `${file} no longer opens Storage; remove it from the list`);
    for (const argument of calls) {
      assert.ok(Object.hasOwn(CALL_SITES[file], argument), `${file}: storage.from(${argument}) is not reviewed`);
      const bucket = resolveBucket(argument, CALL_SITES[file][argument]);
      assert.ok(bucket && ERASED_BUCKETS[bucket], `${file}: storage.from(${argument}) opens ${bucket ?? 'an unknown bucket'}, which erasure does not clear`);
    }
  }
  assert.match(read(ERASED_BUCKETS['ticket-attachments']), /'ticket-attachments'/);
  assert.match(read(ERASED_BUCKETS['library-documents']), /library_erasure_proof/);
});

test('a call in a reviewed file that opens another bucket is caught', () => {
  const file = 'apps/web/src/app/api/upload/upload-intent.ts';
  const source = `${read(file)}\nclient.storage.from('unhandled-private-files');`;
  assert.deepEqual(storageCalls(source).filter(argument => !Object.hasOwn(CALL_SITES[file], argument)), ["'unhandled-private-files'"]);
  assert.equal(resolveBucket('BUCKET', null), undefined);
  assert.equal(resolveBucket("'library-documents'", 'packages/api/src/services/library/content.ts'), undefined);
});

test('no code creates a bucket on its own', () => {
  const creates = sources().filter(file => /\b(createBucket|updateBucket)\s*\(/.test(read(file)));
  assert.deepEqual(creates, []);
});
