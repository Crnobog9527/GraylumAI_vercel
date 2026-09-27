// monid (https://monid.ai/docs). A tool marketplace: each tool's price and
// input schema are only visible through POST /v1/discover and /v1/inspect,
// and the docs do not say whether those lookups (or run polling and the
// wallet balance) are charged. No worst case can be stated in advance, so
// nothing is sent until the controller approves a bounded lookup budget.

export const monid = {
  id: 'monid',
  label: 'monid',
  keyEnv: 'MONID_API_KEY',
  maxCalls: 0,
  maxUsd: 1,
  blockedReason: 'PRICE_NOT_BOUNDABLE: tool prices need /v1/discover and /v1/inspect, whose own charge is undocumented',
  steps: () => ({ notSupported: 'blocked before planning; see blockedReason' }),
  authorize: () => {
    throw new Error('RESEARCH0_VENDOR_BLOCKED');
  },
  kind: query => query.type,
  normalize: () => [],
};
