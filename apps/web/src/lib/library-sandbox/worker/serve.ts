/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { toSandboxErrorCode } from '../errors';

type WorkerScope = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
};

export type WorkerHandler<T> = (input: Uint8Array) => Promise<{ value: T; transfer?: Transferable[] }>;

/**
 * Parser Worker main loop: accepts exactly one ArrayBuffer, replies once with `{ ok, value }` or
 * `{ ok: false, code }` (a stable code, never a raw message), then closes itself.
 */
export function serveOnce<T>(handler: WorkerHandler<T>) {
  const scope = globalThis as unknown as WorkerScope;
  let handled = false;
  scope.onmessage = (event) => {
    if (handled) return;
    handled = true;
    const finish = (reply: unknown, transfer: Transferable[] = []) => {
      scope.postMessage(reply, transfer);
      scope.close();
    };
    if (!(event.data instanceof ArrayBuffer)) return finish({ ok: false, code: 'SANDBOX_PROTOCOL' });
    handler(new Uint8Array(event.data)).then(
      ({ value, transfer }) => finish({ ok: true, value }, transfer),
      (error: unknown) => finish({ ok: false, code: toSandboxErrorCode(error, 'WORKER_FAILED') }),
    );
  };
}
