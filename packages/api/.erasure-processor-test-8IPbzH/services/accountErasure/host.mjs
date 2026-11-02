import { z } from 'zod';
import { createScopedErasureManifest } from './scopedManifest.mjs';
import { createErasureAttachmentManifest } from './manifest.mjs';
import { processAccountErasure } from './processor.mjs';
import { createErasureStorageAdapter } from './storage.mjs';
const uuid = z.string().uuid();
const requestSchema = z.object({
    profile_id: uuid, request_id: uuid,
    stage: z.enum(['closed', 'erasing', 'billing_pending', 'completed']),
    last_error_code: z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable(),
}).strict();
/** Injected single-subject composition; executor.ts supplies the authenticated cron binding.
 * The same service client reads the service-only request and all subjects' raw references.
 * Proof providers are trusted local dependencies, never client input. Quiescence must hold
 * until all injected I/O settles; checking a timestamp/empty table is not such proof.
 * The per-instance latch is NOT a distributed lease; the executor holds a durable DB claim. */
export function createAccountErasureHost(input) {
    let active = false;
    let authDispatched = false;
    const idleWaiters = new Set();
    const becameIdle = () => { active = false; for (const notify of idleWaiters)
        notify(); };
    return { isIdle: () => !active, didDispatchAuth: () => authDispatched,
        waitForIdle: (timeoutMs) => new Promise(resolve => {
            if (!active) {
                resolve(true);
                return;
            }
            const done = () => { clearTimeout(timer); idleWaiters.delete(done); resolve(true); };
            const timer = setTimeout(() => { idleWaiters.delete(done); resolve(false); }, Math.max(0, timeoutMs));
            idleWaiters.add(done);
        }), async run() {
            const denied = (code, previous = null) => ({
                stage: 'erasing', retry: true, remaining: 1, manualReview: 0,
                errorCodes: [...new Set([...(previous ? [previous] : []), code])],
            });
            if (active)
                return denied('ERASURE_HOST_BUSY');
            const timeout = input.operationTimeoutMs ?? 2000;
            if (!uuid.safeParse(input.profileId).success || !uuid.safeParse(input.requestId).success
                || !Number.isInteger(timeout) || timeout < 1 || timeout > 5000)
                return denied('ERASURE_INVALID_INPUT');
            active = true;
            authDispatched = false;
            let sealed = false;
            let pending = 0;
            let previous = null;
            // A returned timeout does not imply underlying I/O stopped. Block local re-entry
            // until it settles, and seal all later writes from an abandoned storage operation.
            const track = async (operation) => {
                if (sealed)
                    throw new Error('ERASURE_HOST_CLOSED');
                pending++;
                try {
                    return await operation();
                }
                finally {
                    pending--;
                    if (sealed && pending === 0)
                        becameIdle();
                }
            };
            const controller = new AbortController();
            let timer;
            const admission = async () => {
                const result = await input.client.from('account_erasure_requests')
                    .select('profile_id,request_id,stage,last_error_code', { count: 'exact' })
                    .eq('profile_id', input.profileId).limit(2).abortSignal(controller.signal);
                if (result.error || result.count !== 1)
                    throw new Error('ERASURE_REQUEST_UNKNOWN');
                const rows = z.array(requestSchema).length(1).parse(result.data);
                const row = rows[0];
                if (row.profile_id !== input.profileId || row.request_id !== input.requestId || row.stage === 'completed') {
                    throw new Error('ERASURE_REQUEST_UNKNOWN');
                }
                previous = row.last_error_code;
                if (!input.verifyRetainedHistory || !input.verifyQuiescence)
                    throw new Error('ERASURE_HISTORY_UNKNOWN');
                if (input.deferStorageProof)
                    return;
                await input.verifyRetainedHistory(input.profileId, controller.signal);
                if (controller.signal.aborted)
                    throw new Error('ERASURE_HOST_TIMEOUT');
                await input.verifyQuiescence(input.profileId, controller.signal);
            };
            try {
                await Promise.race([track(admission), new Promise((_, reject) => {
                        timer = setTimeout(() => { controller.abort(); reject(new Error('ERASURE_HOST_TIMEOUT')); }, timeout);
                    })]);
                clearTimeout(timer);
                if (controller.signal.aborted)
                    throw new Error('ERASURE_HOST_TIMEOUT');
                // Track the actual query, not manifest's timeout race. This deliberately
                // exposes only the query operations used by the raw-reference adapter.
                const metadata = { from(table) {
                        return { select(columns, options) {
                                let query = input.client.from(table).select(columns, options);
                                const page = {
                                    order(column) { query = query.order(column); return page; },
                                    limit(count) { query = query.limit(count); return page; },
                                    gt(column, value) { query = query.gt(column, value); return page; },
                                    abortSignal(signal) { return track(() => query.abortSignal(signal)); },
                                };
                                return page;
                            } };
                    } };
                const verify = async (profileId, signal) => {
                    await track(() => input.verifyRetainedHistory(profileId, signal));
                    await track(() => input.verifyQuiescence(profileId, signal));
                };
                const manifest = input.scopedManifest ? createScopedErasureManifest({ verify, requestId: input.requestId, token: input.executorToken,
                    read: (name, args, signal) => track(() => input.client.rpc(name, args).abortSignal(signal)),
                }) : createErasureAttachmentManifest({ client: metadata, limits: { timeoutMs: timeout }, verifyRetainedHistory: verify });
                // A pass contains many individually bounded reads; checkpoint one object at a time.
                const storageBudget = input.scopedManifest ? 8000 : timeout;
                const storage = createErasureStorageAdapter({ manifest, storage: {
                        listPrefix: args => track(() => input.storage.listPrefix(args)),
                        getState: args => track(() => input.storage.getState(args)),
                        remove: args => track(() => input.storage.remove(args)),
                    }, limits: { requestTimeoutMs: timeout, totalTimeoutMs: storageBudget,
                        ...(input.scopedManifest ? { pageSize: 1, maxPages: 100 } : {}) } });
                const result = await processAccountErasure({ profileId: input.profileId,
                    database: { rpc: (name, args) => track(async () => {
                            const response = await input.client.rpc(name, args);
                            if (name === 'account_erasure_work_batch' && !response.error
                                && response.data?.requestId !== input.requestId)
                                throw new Error('ERASURE_IDENTITY_CHANGED');
                            return response;
                        }) },
                    storageAdapter: { async cleanSubject(profileId) {
                            const ticket = await storage.cleanSubject(profileId);
                            if (!ticket.complete || !input.additionalStorage)
                                return ticket;
                            // Track all library I/O until it really settles, including a processor timeout.
                            // A failed second bucket never invalidates the ticket checkpoint or permits Auth deletion.
                            return track(() => input.additionalStorage.cleanSubject(profileId));
                        } },
                    authAdapter: { getState: id => track(() => input.auth.getState(id)),
                        remove: id => track(() => { authDispatched = true; return input.auth.remove(id); }) },
                    budget: { operationTimeoutMs: timeout, storagePassTimeoutMs: storageBudget, deadline: input.deadline }, });
                // Do not use note_error here: a stale read/late host must not overwrite a
                // newer AUTH_BAN_FAILED or billing diagnostic. Keep original error priority in output.
                if (previous && result.stage !== 'completed')
                    result.errorCodes = [...new Set([previous, ...result.errorCodes])];
                return result;
            }
            catch {
                return denied(controller.signal.aborted ? 'ERASURE_HOST_TIMEOUT' : 'ERASURE_HOST_UNVERIFIED', previous);
            }
            finally {
                clearTimeout(timer);
                controller.abort();
                sealed = true;
                if (pending === 0)
                    becameIdle();
            }
        } };
}
