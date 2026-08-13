/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createServer } from 'node:http';

const origin = 'http://127.0.0.1:54321';
const user = {
  id: '00000000-0000-4000-8000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'local-balance-test@example.test',
  email_confirmed_at: '2026-01-01T00:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { email_verified: true },
  created_at: '2026-01-01T00:00:00.000Z',
};
const requestCounts = {
  '/auth/v1/user': 0,
  '/rest/v1/system_settings': 0,
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', origin);

  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
    return;
  }

  if (url.pathname === '/metrics') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ requests: requestCounts }));
    return;
  }

  if (url.pathname === '/auth/v1/user') {
    requestCounts['/auth/v1/user'] += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(user));
    return;
  }

  if (url.pathname === '/rest/v1/system_settings') {
    requestCounts['/rest/v1/system_settings'] += 1;
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Range': '0-0/1',
    });
    response.end(JSON.stringify([{ value: false }]));
    return;
  }

  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ message: 'local test stub route not found' }));
});

server.listen(54321, '127.0.0.1');

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
