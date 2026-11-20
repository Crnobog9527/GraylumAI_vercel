/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createServer, request } from 'node:http';
import { connect } from 'node:net';

// The browser can reach only the exact loopback origins created by this run.
export function createReleaseProxy(origins) {
  const allowed = new Set(origins.map(origin => new URL(origin).origin));
  const server = createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(403).end(); return; }
    if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || !allowed.has(target.origin)) {
      res.writeHead(403).end(); return;
    }
    const upstream = request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.destroySockets = () => { for (const socket of sockets) socket.destroy(); };
  server.on('upgrade', (req, socket, head) => {
    let target;
    try { target = new URL(req.url); } catch { socket.destroy(); return; }
    const origin = `http://${target.host}`;
    if (target.hostname !== '127.0.0.1' || !allowed.has(origin)) { socket.destroy(); return; }
    const upstream = connect(Number(target.port), '127.0.0.1', () => {
      upstream.write(`${req.method} ${target.pathname}${target.search} HTTP/${req.httpVersion}\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      upstream.write('\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  server.on('connect', (req, socket, head) => {
    let target;
    try { target = new URL(`http://${req.url}`); } catch { socket.destroy(); return; }
    if (target.hostname !== '127.0.0.1' || !allowed.has(target.origin)) { socket.destroy(); return; }
    const upstream = connect(Number(target.port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return server;
}
