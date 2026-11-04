/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The load-test model stub as one Vercel function (V2-13, 11-04): the 100-user run's model calls stay inside Vercel's network instead
// of a tunnel to the operator's machine. deploy-stub-vercel.sh copies openrouter-stub.mjs next to this folder and deploys both.
// A plain (non-Next) Vercel project routes only one path segment to a catch-all file, so every /api/... path is rewritten to this
// one function with the original path in the query (vercel.json: /api/(.*) -> /api/stub?path=$1); the stub's own paths (its secret
// prefix first) start after /api. Without the prefix the function answers nothing: a public URL must never serve the stub to whoever
// finds it.
import { createStubHandler } from '../openrouter-stub.mjs';

const prefix = process.env.LOAD_STUB_PREFIX ?? '';
const handler = createStubHandler({ prefix });

/** The stub's own path and query: from the rewrite's `path` parameter, or from the URL itself when it arrives unrewritten. */
export function stubPath(url) {
  const parsed = new URL(url, 'http://stub.invalid');
  if (parsed.pathname !== '/api/stub') return url.replace(/^\/api(?=\/)/, '');
  const path = parsed.searchParams.get('path') ?? '';
  parsed.searchParams.delete('path');
  const query = parsed.searchParams.toString();
  return `/${path}${query ? `?${query}` : ''}`;
}

export default function stub(req, res) {
  if (!/^[0-9a-f]{32}$/.test(prefix)) { res.writeHead(503).end(); return; }
  req.url = stubPath(req.url);
  handler(req, res);
}
