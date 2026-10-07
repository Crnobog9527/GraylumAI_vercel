# OUTPUT-CAP-RAISE

Risk: **high** (billing capacity and receipt CHECK). Target: staging; merge requires approval.

The 2026-10-07 authorized implementation supersedes the staging 8192 value in
CHAT_NATIVE_OUTPUT_PLAN §3.1 for this delivery: one global cap of 32768 for new
admissions, still bounded by model capability, approved quote and remaining context.
Purpose input limits, organizer output, and 262144 result/session limits remain unchanged.
No paid model calls or remote configuration changes are part of this PR.

## Handoff

- Done: initial capacity implementation and migration 0186 drafted.
- Next: validate receipt retention, reservation, replay, result fitting and timeout recovery;
  complete unit/integration checks and independent review.
- Blockers: validation pending; staging configuration remains a post-merge operation.
- Validation: NOT_RUN at initial draft.
