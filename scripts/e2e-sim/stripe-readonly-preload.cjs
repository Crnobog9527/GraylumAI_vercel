/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Redirect the SDK's exact Stripe host to a read-only local double; the network guard still blocks all remote sockets.
const localStripe = new URL(process.env.SIM_STRIPE_ORIGIN);
if (localStripe.protocol !== 'http:' || localStripe.hostname !== '127.0.0.1' || !localStripe.port) throw new Error('invalid local Stripe simulator');
const httpsModule = require('node:https');
const httpModule = require('node:http');
const originalStripeHttpsRequest = httpsModule.request;
httpsModule.request = function (options, ...rest) {
  if (!options || typeof options !== 'object' || options.host !== 'api.stripe.com') return originalStripeHttpsRequest.call(this, options, ...rest);
  const request = httpModule.request({ ...options, host: '127.0.0.1', hostname: '127.0.0.1', port: Number(localStripe.port),
    agent: false, headers: { ...options.headers, authorization: 'Bearer synthetic-local-only' } }, ...rest);
  // Stripe's Node client waits for secureConnect before sending its body; this is an in-process local HTTP double.
  request.once('socket', socket => { if (socket.connecting) socket.once('connect', () => socket.emit('secureConnect')); });
  return request;
};
