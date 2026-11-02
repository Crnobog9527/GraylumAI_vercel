import { z } from 'zod';
const uuid = z.string().uuid();
const timestamp = z.string().min(1).nullable();
const stateSchema = z.object({
    purpose: z.literal('team_improvement'), currentVersion: z.string().min(1), granted: z.boolean(),
    version: z.string().min(1).nullable(), grantedAt: timestamp, revokedAt: timestamp,
}).strict();
export const dataUseConsentInput = z.object({
    granted: z.boolean(), version: z.string().regex(/^[a-z0-9-]{1,64}$/),
}).strict();
export class DataUseError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const known = ['DATA_USE_VERSION_STALE', 'DATA_USE_ACCOUNT_CLOSED'];
function failure(error) {
    const code = known.find(item => error?.message?.includes(item));
    return new DataUseError(code ?? 'DATA_USE_UNAVAILABLE');
}
export async function readDataUseConsent(db, profileId) {
    const result = await db.rpc('data_use_consent_state', { a: uuid.parse(profileId) });
    if (result.error)
        throw failure(result.error);
    const parsed = stateSchema.safeParse(result.data);
    if (!parsed.success)
        throw failure(null);
    return parsed.data;
}
export async function setDataUseConsent(db, profileId, input) {
    const { granted, version } = dataUseConsentInput.parse(input);
    const result = await db.rpc('data_use_consent_set', { a: uuid.parse(profileId), p_granted: granted, p_version: version });
    if (result.error)
        throw failure(result.error);
    const parsed = stateSchema.safeParse(result.data);
    if (!parsed.success)
        throw failure(null);
    return parsed.data;
}
const FILTER_CHUNK = 1000;
/**
 * The single server-side gate for team-improvement reads (case views, exports, admin analysis of
 * user records). Rows whose owner has no current consent are dropped; any failure drops everything
 * by throwing, never by returning unfiltered rows. Not for a user's own reads of their own data.
 */
export async function filterTeamReadable(db, rows, ownerOf) {
    const owner = (row) => uuid.parse(ownerOf(row)).toLowerCase();
    const owners = [...new Set(rows.map(owner))];
    const allowed = new Set();
    for (let i = 0; i < owners.length; i += FILTER_CHUNK) {
        const chunk = owners.slice(i, i + FILTER_CHUNK);
        const result = await db.rpc('data_use_team_readable', { p_profile_ids: chunk });
        if (result.error)
            throw failure(null);
        const ids = z.array(z.union([uuid, z.object({ data_use_team_readable: uuid }).strict()])).safeParse(result.data);
        if (!ids.success)
            throw failure(null);
        for (const id of ids.data) {
            const value = (typeof id === 'string' ? id : id.data_use_team_readable).toLowerCase();
            if (!chunk.includes(value))
                throw failure(null);
            allowed.add(value);
        }
    }
    return rows.filter(row => allowed.has(owner(row)));
}
/** Retention for the consent audit (DATA-ERASURE E6): one year after revocation. */
export async function expireDataUseConsentAudit(db, signal) {
    const call = db.rpc('data_use_consent_expire', {});
    const result = await (signal ? call.abortSignal(signal) : call);
    if (result.error)
        throw failure(null);
    return z.number().int().nonnegative().parse(result.data);
}
