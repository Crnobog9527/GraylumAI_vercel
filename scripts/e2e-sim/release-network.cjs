/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Defense in depth for release rehearsal processes. Only loopback and local Unix sockets may connect.
const net = require('node:net');
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  let host;
  if (typeof options === 'object' && options !== null) {
    if (options.path) return originalConnect.apply(this, args);
    host = options.host || options.hostname || 'localhost';
  } else if (typeof options === 'string' && !/^\d+$/.test(options)) {
    return originalConnect.apply(this, args); // Unix socket path
  } else {
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('RELEASE_PREFLIGHT_NETWORK_BLOCKED');
  return originalConnect.apply(this, args);
};
