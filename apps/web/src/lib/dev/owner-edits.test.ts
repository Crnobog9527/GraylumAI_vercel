import { describe, expect, it } from 'vitest';
import { POST } from '@/app/api/dev/owner-edits/route';
import { ownerEditsTarget } from './owner-edits';

describe('owner edit mode (local preview only)', () => {
  it('saves only in a development server started with the local edits file', () => {
    expect(ownerEditsTarget({ NODE_ENV: 'production', OWNER_EDITS_FILE: '/tmp/edits.jsonl' })).toBeNull();
    expect(ownerEditsTarget({ NODE_ENV: 'test', OWNER_EDITS_FILE: '/tmp/edits.jsonl' })).toBeNull();
    expect(ownerEditsTarget({ NODE_ENV: 'development' })).toBeNull();
    expect(ownerEditsTarget({ NODE_ENV: 'development', OWNER_EDITS_FILE: '/tmp/edits.json' })).toBeNull();
    expect(ownerEditsTarget({ NODE_ENV: 'development', OWNER_EDITS_FILE: '/tmp/edits.jsonl' })).toBe('/tmp/edits.jsonl');
  });

  it('answers 404 outside development, whatever is sent', async () => {
    const request = new Request('http://localhost/api/dev/owner-edits', {
      method: 'POST', body: JSON.stringify({ page: '/', edits: [{ module: 'm', original: 'a', edited: 'b' }] }),
    });
    expect((await POST(request)).status).toBe(404);
  });
});
