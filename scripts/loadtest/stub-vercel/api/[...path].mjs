/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The load-test model stub as one Vercel function (V2-13, 11-04): the 100-user run's model calls stay inside Vercel's network instead
// of a tunnel to the operator's machine. deploy-stub-vercel.sh copies openrouter-stub.mjs next to this folder and deploys both.
// Vercel serves this file under /api/...; the stub's own paths (its secret prefix first) start after that. Without the prefix the
// function answers nothing: a public URL must never serve the stub to whoever finds it.
import { createStubHandler } from '../openrouter-stub.mjs';

const prefix = process.env.LOAD_STUB_PREFIX ?? '';
const handler = createStubHandler({ prefix });

export default function stub(req, res) {
  if (!/^[0-9a-f]{32}$/.test(prefix)) { res.writeHead(503).end(); return; }
  req.url = req.url.replace(/^\/api(?=\/)/, '');
  handler(req, res);
}
