// monid (https://monid.ai/docs). A tool marketplace: each tool's price and
// input schema are only visible through POST /v1/discover and /v1/inspect,
// and the docs do not say whether those lookups (or run polling and the
// wallet balance) are charged. The Owner approved only a bounded catalogue
// phase (see ../monidCatalog.mjs); the comparison queries need a second
// approval once prices are known, so they stay blocked here.

export const monid = {
  id: 'monid',
  label: 'monid',
  keyEnv: 'MONID_API_KEY',
  maxCalls: 0,
  maxUsd: 1,
  blockedReason: 'AWAITING_APPROVAL: comparison queries need Owner approval after the catalogue phase prices them',
  steps: () => ({ notSupported: 'blocked before planning; see blockedReason' }),
  authorize: () => {
    throw new Error('RESEARCH0_VENDOR_BLOCKED');
  },
  kind: query => query.type,
  normalize: () => [],
};
