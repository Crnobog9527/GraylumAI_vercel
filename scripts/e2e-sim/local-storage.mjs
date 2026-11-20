/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHmac, timingSafeEqual } from 'node:crypto';

function serviceToken(header, secret) {
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header ?? '');
  if (!match) return false;
  try {
    const sig = Buffer.from(match[3], 'base64url');
    const expected = createHmac('sha256', secret).update(`${match[1]}.${match[2]}`).digest();
    const payload = JSON.parse(Buffer.from(match[2], 'base64url').toString());
    return sig.length === expected.length && timingSafeEqual(sig, expected) && payload.role === 'service_role'
      && Number.isFinite(payload.exp) && payload.exp > Date.now() / 1000;
  } catch { return false; }
}

/** Disposable private-attachment double. It does not emulate Supabase Storage policies or serving signed downloads. */
export function createLocalStorage(secret) {
  const objects = new Set();
  return async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (!serviceToken(req.headers.authorization, secret)) { req.resume(); return reply(403, { error: 'forbidden' }); }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/storage\/v1\/object\/(sign\/)?ticket-attachments\/([0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:png|jpg|gif|webp))$/i.exec(url.pathname);
    if (req.method !== 'POST' || !match) { req.resume(); return reply(404, { error: 'unsupported' }); }
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 6 * 1024 * 1024) { req.destroy(); return; } }
    const path = match[2];
    if (match[1]) {
      if (!objects.has(path)) return reply(404, { error: 'missing' });
      return reply(200, { signedURL: `/object/sign/ticket-attachments/${path}?token=synthetic` });
    }
    if (objects.has(path)) return reply(409, { error: 'already exists' });
    objects.add(path);
    return reply(200, { Key: `ticket-attachments/${path}`, Id: 'synthetic' });
  };
}
