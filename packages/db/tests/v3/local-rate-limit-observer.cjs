/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Observation only, preloaded exclusively by the disposable website/test runner.
const { Server } = require('node:http');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const originalEmit = Server.prototype.emit;
let sequence = 0;
Server.prototype.emit = function (event, ...args) {
  const [request, response] = args;
  const app = process.env.V3_LOCAL_APP;
  const output = process.env.V3_WORKBENCH_OUTPUT;
  const path = request?.url?.split('?')[0];
  if (event === 'request' && app && output &&
      request.socket?.localPort === Number(new URL(app).port) &&
      (path.startsWith('/api/trpc') || path.startsWith('/api/ai/stream'))) {
    const id = `${process.pid}-${++sequence}`;
    const write = (data) => appendFileSync(join(output, 'rate-limit-requests.jsonl'),
      JSON.stringify({ id, time: Date.now(), ...data }) + '\n', { mode: 0o600 });
    write({ event: 'request', path });
    response.once('finish', () => write({ event: 'response', status: response.statusCode,
      limit: response.getHeader('x-ratelimit-limit') ?? null }));
    response.once('close', () => { if (!response.writableFinished) write({ event: 'aborted' }); });
  }
  return originalEmit.call(this, event, ...args);
};
