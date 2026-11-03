# F-Node B notes (V2-12 F: web entries drop the old execution path)

Scope: `/app/runtime/**`, workbench composer, start/marketplace pages. The survey showed the pages already run only on the turn path
(`/runtime` routes to TurnWorkspace / WorkItemWorkspace); what was left was dead helper code and tests of the old path.

## Changes
- `runtime-notices.ts` (+ test): deleted. No importer outside its own test and one positioning-card test; the turn path has `turn-notices.ts`.
- `gate-notices.ts`: only what still has callers stays: `POSITIONING_REQUIRED_NOTICE`, `showsReply`, `definiteRefusal`,
  `DEFINITE_REFUSAL_NOTICE`, `definiteRefusalNotice`. Removed: `runtimeAdmissionNotice`, `runtimeExecutionNotice`, `libraryReferenceRefusal`,
  `isLibrarySourceDeleted`, `SOURCE_DELETED_NOTICE`, `videoGate*`, `rememberGateStop` / `gateStopNotices`, user-stop helpers, the `payg-wait` import.
- `runtime/page.tsx` + `runtime-path.ts`: reads only `sessionId`, `scope.kind`, `legacy` (defensively) from `runtime.view`. A conversation with no
  turn-path scope, or `legacy: true`, shows a notice and a "new conversation" button instead of a blank page. A failed read stays "unreadable".
- `work-turn-path.ts`: dropped the unused `executionId` field of `ContentVersion`.
- `composer-references.ts`: comments only. The turn path already carries references (`TurnChoice.references`, `referenceRequest()` in
  `turn-workspace.tsx`); no rewiring needed.
- `profile-archive.test.ts`: path string no longer names the old stream procedure.

## Exports kept for window A (positioning/[draftId]/**)
| export (gate-notices.ts) | importer |
| --- | --- |
| `DEFINITE_REFUSAL_NOTICE` | admission-message.ts, admission-message.test.ts, topics/topic-notices.test.ts |
| `definiteRefusal` | mentor-turn.ts |
| `definiteRefusalNotice`, `showsReply` | topics/topic-notices.ts |
Also in this package for runtime itself: `POSITIONING_REQUIRED_NOTICE` (turn-notices.ts, turn-workspace.tsx, positioning-required.ts).

## Old scenario -> new test
| old scenario (deleted test) | new test |
| --- | --- |
| admission refusals: minute/day limit, new calls paused, limit unavailable (`gate-notices.test.ts`) | `turn-notices.test.ts` "keeps the text of the refusal %s" (TURN_RATE_LIMITED, TURN_NEW_CALLS_PAUSED, TURN_LIMIT_UNAVAILABLE) |
| too-long input refused before admission | `turn-notices.test.ts` (TURN_INPUT_TOO_LARGE); `gate-notices.test.ts` keeps the `definiteRefusalNotice` too-long case for window A |
| library reference refusal / source deleted | `turn-notices.test.ts` (TURN_REFERENCES_UNAVAILABLE, and the CONTENT_SOURCE codes in `turn-notices.ts`) |
| positioning refusal (admission, refused execution, refreshed turn) shows one guide card | `positioning-required.test.tsx` (card text, not-charged note, both entries, same text as `turnCodeNotice('POSITIONING_REQUIRED')`) |
| provider history / preflight / output truncated notices on a cancelled round | `turn-notices.test.ts` "provider failure refunded the round" (TURN_PROVIDER_402 / BUSY); truncation belongs to window A's `agent-turn-display` |
| gate stop remembered across reload (`rememberGateStop`), user stop remembered (`userStopIds`), stop-with-record (`stopWithRecord`) | none: stop/cancel does not exist on the turn path (a turn is paused for credits and continued with `继续`) |
| BILL-PAYG pause / skipped organizer notices in `runtimeTurnNotices` | `turn-notices.test.ts` "paused for credits"; organizer is window A's |
| `runtimeModeSubtitle` | none: no caller (dead) |
| open turn "重试 / 停止", capacity, tail notices | none: old execution rounds; the turn path has its own send / resume / error state in `use-turn-chat.ts` |
| runtime page: unreadable view | `page.test.tsx`, `runtime-path.test.ts` (kept, now separated from "legacy") |
| (new) old conversation without turns | `page.test.tsx` "tells an old conversation...", `runtime-path.test.ts` "...flagged legacy" |

## Needed from `runtime.view` (window C)
`legacy: true` for a conversation without turns. B also treats "view answered, scope missing or not positioning_draft / work_item" as legacy,
so the page is safe before and after the flag ships. B reads only `sessionId`, `scope.kind` (+ `scope.workItemId` for work items), `legacy`.

## Not changed on purpose
- `use-turn-chat.ts` `chat.resume()` / `TURN_CONTINUE` are the turn path's own continue (paused for credits), not `runtime.resume`.
- `positioning/page.tsx`, `workbench/marketplace/page.tsx`, `checkoutSyncInvalidations.ts`, `work-composer.tsx` use only `runtime.choices` / `runtime.start`.

## Validation handoff (for the PR body)
- Entry: preview or staging URL of this PR head (placeholder, to fill when the PR exists). Test identity: the shared staging test account
  (reference in the controller notes; never credentials here).
- Steps:
  1. Sign in, open `/app/positioning`, type a first message, send. Expect: the conversation opens at `/app/runtime?session=...` in the turn workspace and a reply streams.
  2. Reload that page. Expect: same conversation, history intact, no error.
  3. Open a work item from the workbench marketplace. Expect: the work item workspace opens, a Skill reply can be sent.
  4. Open `/app/runtime?session=<id of an old staging conversation that has no turns>`. Expect: "这个对话是旧版本产生的，已不再支持查看。" and a
     "开始新对话" button; no blank page, no stack trace. The button leads to `/app/positioning`.
  5. Open `/app/runtime?session=<random uuid>`. Expect: redirect to `/app/positioning` (not found leaves the page).
- Pass: steps 1-5 as expected, no console errors. Fail: any blank page, error text with a code or stack, or old-conversation content shown.
- Out of scope: positioning/[draftId] pages, payments, reports.
