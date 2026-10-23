// DATA-ERASURE T01: every place that opens a Storage bucket is a bucket account erasure already clears.
// A new storage.from(...) call site, or a new bucket name, fails here until its erasure path is reviewed and listed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');

// Bucket -> how account erasure removes its objects.
const ERASED_BUCKETS = {
  'ticket-attachments': 'packages/api/src/services/accountErasure/storage.ts (prefix + manifest removal before Auth deletion)',
  'library-documents': 'packages/api/src/services/library/erasure.ts (library cleanup proof before Auth deletion)',
};
// Reviewed call sites -> the bucket each one opens.
const CALL_SITES = {
  'apps/web/src/app/api/upload/upload-intent.ts': 'ticket-attachments',
  'packages/api/src/lib/ticketAttachments.ts': 'ticket-attachments',
  'packages/api/src/services/accountErasure/storageTransport.ts': 'ticket-attachments',
  'packages/api/src/services/library/storage.ts': 'library-documents',
};

const sources = () => execFileSync('git', ['ls-files', '--', ':(glob)apps/*/src/**', ':(glob)packages/*/src/**'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(file => /\.(ts|tsx|mjs|js)$/.test(file) && !/(\.test\.|\.integration\.|__tests__\/)/.test(file));

test('every storage.from call site is reviewed for account erasure', () => {
  const found = sources().filter(file => /storage\s*\.\s*from\s*\(/.test(readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(found.sort(), Object.keys(CALL_SITES).sort());
});

test('each reviewed call site opens a bucket that account erasure clears', () => {
  const read = file => readFileSync(path.join(root, file), 'utf8');
  for (const [file, bucket] of Object.entries(CALL_SITES)) {
    assert.ok(ERASED_BUCKETS[bucket], `${file}: ${bucket} has no erasure path`);
    // The library store opens the BUCKET constant from its content module.
    const opens = file === 'packages/api/src/services/library/storage.ts'
      ? read(file).includes('storage.from(BUCKET)') && read('packages/api/src/services/library/content.ts').includes(`BUCKET = '${bucket}'`)
      : read(file).includes(`'${bucket}'`);
    assert.ok(opens, `${file} still opens ${bucket}`);
  }
  assert.ok(read('packages/api/src/services/accountErasure/storage.ts').includes("'ticket-attachments'"));
  assert.ok(/\blibrary-documents\b|\bBUCKET\b|library_erasure/.test(read('packages/api/src/services/library/erasure.ts')));
});

test('no code creates a bucket on its own', () => {
  const creates = sources().filter(file => /\b(createBucket|updateBucket)\s*\(/.test(readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(creates, []);
});
