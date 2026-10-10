/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from './errors';
import { buildSandboxSrcdoc, RELAY_SCRIPT, SANDBOX_FRAME_ATTRIBUTES, scriptHashSource } from './frame-document';
import { MESSAGE, parseFrameMessage, parseWorkerReply } from './protocol';

/**
 * Runs one untrusted-file parser in the sandbox and returns its raw reply value (LIB-2b; reused
 * by LIB-2c pdf.js and LIB-2d OCR with their own worker bundles). Bytes in, one structured value out.
 * The caller validates the value's shape. Timeouts, navigation or protocol errors tear the frame
 * down, which also terminates its Worker; the page itself never runs parser code.
 */

export type SandboxRunOptions = {
  /** Same-origin worker bundle text (never a CDN); started from a blob inside the frame. */
  workerSource: string;
  /** Transferred to the sandbox: the caller's buffer is detached afterwards. */
  input: ArrayBuffer;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Test hook: a different relay script, still allowed only by its own hash. */
  relayScript?: string;
};

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sandboxSupported(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined' && Boolean(globalThis.crypto?.subtle)
    && typeof Worker === 'function' && 'sandbox' in document.createElement('iframe');
}

export async function runSandboxedWorker(options: SandboxRunOptions): Promise<unknown> {
  if (!sandboxSupported()) throw new SandboxError('SANDBOX_UNAVAILABLE');
  if (options.signal?.aborted) throw new SandboxError('SANDBOX_TIMEOUT');
  const script = options.relayScript ?? RELAY_SCRIPT;
  const token = randomToken();
  const hash = await scriptHashSource(script);
  // The signal may fire while hashing; its listener is only attached below.
  if (options.signal?.aborted) throw new SandboxError('SANDBOX_TIMEOUT');
  const frame = document.createElement('iframe');
  for (const [name, value] of Object.entries(SANDBOX_FRAME_ATTRIBUTES)) frame.setAttribute(name, value);
  frame.style.display = 'none';
  frame.srcdoc = buildSandboxSrcdoc(token, hash, script);

  return new Promise<unknown>((resolve, reject) => {
    let loads = 0;
    let port: MessagePort | null = null;
    let settled = false;
    const finish = (error: SandboxError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onReady);
      options.signal?.removeEventListener('abort', onAbort);
      port?.postMessage({ type: MESSAGE.abort, token });
      port?.close();
      frame.remove();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new SandboxError('SANDBOX_TIMEOUT'));
    const timer = setTimeout(onAbort, options.timeoutMs);
    const onPortMessage = (event: MessageEvent) => {
      const message = parseFrameMessage(event.data, token);
      if (!message || message.type === MESSAGE.ready) return finish(new SandboxError('SANDBOX_PROTOCOL'));
      if (message.type === MESSAGE.failure) return finish(new SandboxError('WORKER_FAILED'));
      const reply = parseWorkerReply(message.data);
      if (!reply) return finish(new SandboxError('SANDBOX_PROTOCOL'));
      if (reply.ok) finish(null, reply.value);
      else finish(new SandboxError(reply.code));
    };
    // The only window message accepted: the relay's "ready", carrying the port for everything else.
    const onReady = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== 'null') return;
      const message = parseFrameMessage(event.data, token);
      if (message?.type !== MESSAGE.ready) return;
      if (port || event.ports.length !== 1) return finish(new SandboxError('SANDBOX_PROTOCOL'));
      port = event.ports[0];
      port.onmessage = onPortMessage;
      port.postMessage({ type: MESSAGE.start, token, source: options.workerSource, input: options.input }, [options.input]);
    };
    // srcdoc loads exactly once; a second load means the frame navigated away.
    frame.addEventListener('load', () => {
      loads += 1;
      if (loads > 1) finish(new SandboxError('SANDBOX_NAVIGATED'));
    });
    window.addEventListener('message', onReady);
    options.signal?.addEventListener('abort', onAbort);
    document.body.appendChild(frame);
  });
}
