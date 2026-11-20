/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createServer } from 'node:http';
/** Synthetic account identity for read-only local catalog tests. Never creates a payment. */
export function createStripeReadonly() {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const data = req.method === 'GET' && path === '/v1/account' ? { id: 'acct_rehearsal', object: 'account' }
      : req.method === 'GET' && path === '/v1/balance' ? { object: 'balance', livemode: false, available: [], pending: [] } : null;
    req.resume();
    res.writeHead(data ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data ?? { error: { type: 'invalid_request_error', message: 'Local read-only simulator refused this request' } }));
  });
}
