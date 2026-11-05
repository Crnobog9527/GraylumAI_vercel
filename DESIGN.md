---
version: alpha
name: "GraylumAI"
description: "Dark-first AI workspaces that guide creators from a conversation to reviewable business artifacts."
colors:
  primary: "#FFD700"
  secondary: "#FFA500"
  background: "#0A0A0A"
  surface: "#1A1A1A"
  surface-muted: "#2A2A2A"
  text: "#FFFFFF"
  text-muted: "#B0B0B0"
  border: "#333333"
  success: "#22C55E"
  error: "#EF4444"
typography:
  sans:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Helvetica Neue, Arial, sans-serif"
  mono:
    fontFamily: "JetBrains Mono, Fira Code, SF Mono, Consolas, Menlo, monospace"
rounded:
  DEFAULT: "0.5rem"
  sm: "0.25rem"
  md: "0.5rem"
  lg: "0.75rem"
  xl: "1rem"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
  page-max: "90rem"
components:
  button: {}
  card: {}
  input: {}
  conversation: {}
  step-navigation: {}
---

# GraylumAI Design System

## U0/U1 accepted workbench and U2 migration boundary

The accepted workbench is a scoped light surface. The dark tokens above still
describe the older application; they must not be applied over the accepted
workbench or replaced globally as part of the first U2 slice. The workbench
uses white conversation and result surfaces, a `#f7f7f7` surrounding canvas,
`#262626` primary text, `#777` secondary text, and quiet `#ededed` borders.
The small warm selection accent is reserved for the active work. The current
component source is `apps/web/src/components/opc/workspace-frame.module.css`,
`work-composer.module.css`, `content-editor.module.css`,
`version-compare.module.css`, `apps/web/src/app/(zh-hans)/app/runtime/runtime-work.module.css`,
and the library's `library.module.css`, adapted
from the accepted local high-fidelity reference. The new-task surface is in
`apps/web/src/app/(zh-hans)/app/positioning/start-work.module.css`.
These styles are scoped to the OPC workbench.

On desktop the shell uses a 264px platform/account/work rail, a flexible
conversation, an 8px gutter, and a 330px results rail. The global navigation
contains Home, Chat, and Profile; Feature Marketplace belongs in the left
work rail. The account strategy is a fixed entry under each account, while
individual adopted topics link to their own Runtime session. At narrow widths
the work rail and results rail become dismissible surfaces so the conversation
and composer remain usable. A viewed library item does not change the active
session; continuation is an explicit link to that item's session.
The visible first-week entry opens the bound `/topics` conversation. Existing
`/plan` URLs remain available for retained request recovery and old records;
they are not the entry used for a new topic work session.

The ordinary Chat entry opens a general new-task surface. Choosing account
positioning first presents the two accepted methods; the existing real
registration and business prerequisites appear only after a method is chosen.
The in-progress strategy keeps its actual Skill questions and persistence in
the right rail, while the conversation remains central. Isolated UX acceptance
uses the approved six-stage positioning scenario, including all nine questions;
production renders the actual bound Skill without inventing stages. The
sidebar's Search opens a workspace search page for work, archived records,
and features. The separate account/work filter above platform groups is intentionally
omitted per the Owner's latest direction, even though it appears in the accepted prototype. Fixed
account strategy, independent chat display names, pinning, archive recovery, and account display
names use owned projections and versioned mutations. Chat actions appear on
hover or keyboard focus; renaming is inline and deleting requires a second
explicit action.

U2 currently migrates the bound topic conversation, explicit single-topic
adoption, Runtime Agent suggestion and draft adoption, manual version save,
expanded edit, read-only version comparison, library detail, and return path.
The same result editor now handles articles and video scripts. Video manual
revisions must descend from an admitted execution; storyboard and editing
results remain bound to the exact final script version. The editor creates
immutable server versions; local text caching only protects unsent or unsaved
input. `draft`, `final`, and publication are distinct states. A definite
conflict keeps the edit available for comparison, and an unknown outcome
retains the original request for recovery. A single saved version leaves the
opposite comparison pane empty, and the same version cannot occupy both panes.
The left Feature Marketplace is viewed within the workspace; a module may
begin a new task only when its Runtime Skill and prerequisites are available.
Viewing a module does not execute it. The positioning route keeps the central
conversation and the bound Skill questions in the right rail. The library
offers account strategy detail, actual saved history, metadata and content
editing, and manual publication-date/status recording; it does not publish to
an external platform. Feedback, credits and account popovers use existing
services. File, library, and connector attachments, publication scheduling,
data review, full Profile migration, and unrelated application pages remain
outside this workbench slice. The formal strategy edit currently saves a
pending revision through the shared OPC draft; the reference's independent
per-account versus shared-business edit choice is not yet a formal contract.

## Light foundation (layer 1, shared by the workbench and public pages)

The Owner decided on 2026-10-13 that this file is the only design specification. On 2026-11-05 the Owner fixed its scope:
the home page (public) and the conversation page (signed-in) are the two baselines, written as (1) this foundation, taken from
the accepted conversation workbench, and (2) the public-page layer below ("Public-page layer (layer 2)"), taken from the accepted
home page. The management layer is not written: the admin back office is not changed.

The values below are read from the workbench modules listed in the previous section. Their runtime
mirror is `apps/web/src/components/design/light-tokens.module.css` (class `.light`, variables
`--gl-*`), which public pages and the landing demo put on their root. Pages use these variables, not
literal colors or sizes. The workbench keeps its own scoped values; it is the source, not a consumer.
The dark tokens in the front matter remain only for signed-in pages that are not yet unified.

### Color

| Role | Variable | Value | Where it comes from |
| --- | --- | --- | --- |
| Canvas around panels | `--gl-canvas` | `#f7f7f7` | workspace background |
| Panel, card, field | `--gl-surface` | `#fff` | conversation and result panels |
| Quiet box (update, notice) | `--gl-surface-subtle` | `#fafafa` | checklist update, completion notice |
| User bubble, hover row | `--gl-surface-muted` | `#f4f4f5` | user message, option hover |
| Warm page tint | `--gl-surface-warm` | `#faf9f5` | rail hover |
| Primary text | `--gl-text` | `#262626` | all panels |
| Message body | `--gl-text-body` | `#444` | mentor message body |
| Secondary / tertiary text | `--gl-text-secondary` / `--gl-text-tertiary` | `#777` / `#999` | captions, states |
| Small text on public pages | `--gl-text-secondary-aa` | `#6b6b6b` | reaches 4.5:1 on white; `#777` and `#999` stay workbench-only |
| Border / control border / strong | `--gl-border` / `--gl-border-control` / `--gl-border-strong` | `#ededed` / `#e5e5e5` / `#dcdcdc` | dividers, fields, current question |
| Primary action | `--gl-action` (hover `--gl-action-hover`) | `#262626` (`#3b3b3b`) | send, confirm, publish bar |
| Current work | `--gl-accent-selected` | `#faf4e5` | active rail item |
| Recommended tag | `--gl-accent-tag` / `--gl-accent-tag-text` | `#f4efe3` / `#7a5f2c` | question card 推荐 |
| Gold accent | `--gl-accent-gold`, `--gl-accent-gold-soft`, `--gl-accent-gold-text` | `#ffbb17`, 10% tint, `#995900` | credit widget, membership |
| Brand mark | `--gl-brand-gold` | `#ffd700` | logo only |
| Success / warning / error | `--gl-success*`, `--gl-warning*`, `--gl-error*` | text on tinted background | conversation notices |

The primary action is dark, not gold. Gold and the warm tints mark the current work, the recommended
choice and membership; they are never the background of long text.

### Type

One family, `--font-primary` (MiSans with PingFang SC, Hiragino Sans GB and Microsoft YaHei fallbacks).
Workbench sizes: 11px micro labels, 12px captions and states, 13px UI rows and options, 14px fields and
questions, 15px message body (line height 1.75), 17px panel titles. Weights are 400 and 500, with 550–600
only for short titles. Larger display sizes for public pages belong to layer 2.

### Space, shape and depth

Spacing steps are 4, 8, 12, 16, 20 and 24px (6, 10 and 14 appear inside compact rows). Radii: 6px small
controls, 8px buttons and fields, 12px cards and panels, 18px dialogs, 25px the message composer, pill
for tags. Depth is tonal: panels use `--gl-shadow-panel`, the composer `--gl-shadow-composer`, menus and
dialogs `--gl-shadow-menu` and `--gl-shadow-dialog`; routine cards have a border and no shadow.

### Base components

- **Button:** `components/ui/button` under `.light`: default is the dark primary action, outline is white
  with `--gl-border-control`; 8px radius, 34px minimum height (44px on touch widths for important actions).
- **Field:** white, `--gl-border-control`, 8px radius, 14px text, line height 1.65; the label stays visible.
- **Card:** white, 1px `--gl-border`, 12px radius, 12–16px padding, no shadow.
- **Tag:** pill, 11px, `--gl-accent-tag` for recommended, `--gl-surface-muted` for neutral.
- **Notice:** `ChatInlineNotice`, 13px on a tinted background by tone; status notices have no background.
- **Dialog:** white, 18px radius, `--gl-shadow-dialog`, title row with a divider; actions centered, the
  primary one first and dark.
- **Composer:** 25px radius, `--gl-shadow-composer`, round 34px icon buttons, dark round send button.

Motion is 150ms for hover and focus. Long content does not animate in; with reduced motion every state
shows its end state.

## Public-page layer (layer 2) and the signed-in baseline

Decided by the Owner on 2026-11-05 (recorded in Master Plan 2.1 by #1766, pending merge when this was written), verbatim: "上线前做 A0+A；以首页（公开页）和对话页（登录后）为全站设计基线，写进设计规范；首页背景和动效不纳入。后台不改。"

The Owner decision is only that sentence. Everything below it is specification derived from the code as of 2026-11-05 and from the 2026-11-05 UI audit (the "Decision" and "Reason" columns are proposals for the A-tier work, not Owner decisions). Two baselines:

- **Public pages** (home, pricing, articles, FAQ, legal, contact, sign-in and sign-up): the accepted home page (sample L: `SampleL`, `SiteHeaderJ`, `SiteFooterJ`). Its values are written below as fact, taken from `apps/web/src/components/landing/preview-j/j.module.css`, `chrome-j.module.css` and `preview-k/k.module.css`, `preview-l/l.module.css`.
- **Signed-in pages** (workbench, conversation, library, profile center): the conversation page (`apps/web/src/components/opc/*.module.css`, `workspace-frame`, `work-composer`, `question-card`, `capture-checklist`, `positioning-result`). Where the numbers in this file's layer 1 and the code disagree, the conversation page as rendered wins; section "Signed-in baseline" lists the disagreements.

**Not in this specification.** (a) The home page's own background design and motion: the three-tone section bands (`[data-band]` tint `#f0efeb`, ink `#1b1a18`, panel radius `clamp(24px, 3vw, 48px)`), the sticky-note wall and its drop-in animation, the moving report-card row, the hero picture and every `--j-ease` transition. They belong to the home page, are not shared variables, and other public pages must not copy them. Other public pages sit on the plain public canvas. (b) The management layer: the admin back office is not changed (Owner 2026-11-05); there is no layer 3 in this file.

### Public layer: the home page's values

Put `.light` on the page root, then the public modifier (`.light.public`, to be added to `light-tokens.module.css` in the first A-tier change; this document change adds no code). The modifier overrides only the variables marked "public override" in the crosswalk below. Everything else is `--gl-*`.

| Part | Fact (home page today) |
| --- | --- |
| Canvas | `#fafaf9`; text `#141312` ink, body `#3d3c3a`, muted `#63625f`, hairline `#e7e6e2`; selection highlight `#ffe8a8` |
| Body text | 16px, line height 1.7; lead paragraph `clamp(17px, 1.5vw, 20px)` / 1.75, max 34em |
| Display headings | weight 600, letter spacing `-.04em`, line height 1.1, `text-wrap: balance`; page title `clamp(34px, 4.6vw, 64px)` / 1.08; section title `clamp(32px, 4.2vw, 60px)`; sub-section `clamp(26px, 2.8vw, 38px)` / 1.15, letter spacing `-.03em`; item title `clamp(22px, 2vw, 28px)`; card title 18–19px, 600 |
| Small text | 14px (`14.5px` in menus), captions 12–13px; secondary text on cards uses `--gl-text-secondary-aa` (`#6b6b6b`), never `#777` or `#999` |
| Layout | content width `min(100%, 1240px)`, side gutter 16px below 768px and 32px from 768px; section padding 88px top and bottom, 64px below 768px (`k.module.css` `.section`, used by most home sections; the comparison section alone uses `j.module.css` `.section`, 112px and 72px); section header block gap 20px, bottom margin 56px (36px below 768px); two-column section header 7fr / 5fr from 960px, gap 48px |
| Primary button (pill) | height 52px, padding `0 28px`, 17px / 500, radius 999px, background `#141312`, white text, hover `#33322f`; one per screen area |
| Small pill buttons | 40px high, padding `0 18px`, 14px / 500; dark (`#141312`) or light (white, 1px `#e7e6e2` border, ink text); below 420px: 36px high, padding `0 12px`, 13px; below 360px: padding `0 9px`, 12.5px |
| Step / tab pill | 48px high in the scenario steps (`k.module.css`), 46px in the daily-operations tabs (`l.module.css`), both 42px below 480px; radius 999px, white, 1px hairline; selected: ink background, white text, gold `#ffbb17` number disc |
| Card | white, 1px `#e7e6e2`, radius 18px; ordinary cards have no shadow; the answer card and the report cards use `--j-shadow` (`0 1px 2px rgba(20,19,18,.04), 0 18px 40px -24px rgba(20,19,18,.28)`); the sample report and the moment picture use `--j-shadow-lift` (`0 1px 2px rgba(20,19,18,.04), 0 40px 80px -48px rgba(20,19,18,.45)`). Exceptions to the 18px radius: the answer card 6px, the step cards 14px below 768px |
| Dialog and popover | report dialog radius 20px, backdrop `rgba(20,19,18,.45)`; menu panel radius 16px, items radius 10px, language menu radius 14px, items 9px; white; menus have a 1px hairline and a soft long shadow, the report dialog has no border |
| Gold | accent `#ffbb17`, accent text `#8a5a00` (passes 4.5:1 on white), tag background `#fff4d6`; gold marks the recommended choice and the current step, never a button fill or a text background |
| Focus | `outline: 2px solid #141312; outline-offset: 3px` on links, buttons and `summary` on the page, 2px offset on header items and menu links |
| Header | sticky, `padding: 12px 0`, background `rgba(250,250,249,.94)` with 16px backdrop blur, one row only (a long site name ends in an ellipsis, never wraps); wordmark 21px / 600 / `-.04em` with a 28px logo (radius 6px, `#262626` behind it); full navigation from 1100px, below that a 40px round menu button and a drawer (`#fafaf9`, hairline top, max height `100svh - 64px`); nav items 15px, padding `8px 12px`, radius 999px, hover `rgba(20,19,18,.05)`; the language switch is a 36px pill with a globe |
| Footer | padding `56px 0 40px`, 1px hairline on top, 14px muted text; four columns from 900px, two below, gap `28px 24px`; column heading 14px / 600 ink; link list gap 9px; base line margin-top 44px, padding-top 22px, hairline on top |
| Phone | page `overflow-x: clip`; section padding 64px; the header never wraps; headings shrink below 480px (`min(48px, 12.8vw)` and `min(34px, 7.4vw)`); touch targets today: 36px header buttons, 38–40px for the dialog close and pause buttons, 42px or more for content tabs, 44px for the fold button; new public work uses 44px for any important action; the report cards in the moving row are a fixed 300px wide; hover-only information is not allowed; with reduced motion every state shows its end state |

Public pages follow one more rule: no literal colors or sizes in page files, use the variables. A new public page uses the shared public shell (header, footer, canvas); it never builds its own header.

### Crosswalk: the home page's `--j-*` against `--gl-*`

Rule for conflicts: a value the Owner accepted on the home page stays as it is and becomes a "public override" of the `--gl-*` variable (the home page must not change by one pixel because of the merge). Everything else shares `--gl-*`. Signed-in pages never read an override.

| Home variable / value | `--gl-*` target | Conflict? | Decision and reason |
| --- | --- | --- | --- |
| `--j-canvas` `#fafaf9` | `--gl-canvas` (`#f7f7f7`) | yes | Public override `#fafaf9` (home is the public standard); signed-in keeps `#f7f7f7` (conversation page) |
| `--j-ink` `#141312`; pill `#141312` | `--gl-text` (`#262626`) and `--gl-action` (`#262626`) | yes | Public override: `--gl-text` and `--gl-action` become `#141312`, `--gl-action-hover` `#33322f`; signed-in keeps `#262626` / `#3b3b3b` |
| `--j-body` `#3d3c3a` | `--gl-text-body` (`#444`) | yes (small) | Public override `#3d3c3a`; a later merge to `#444` is an Owner-visible change on the home page, not done now |
| `--j-muted` `#63625f` | `--gl-text-secondary-aa` (`#6b6b6b`) | yes (small) | Public override `#63625f` for footer, menu captions and drawer headings; card captions on the home page already read `--gl-text-secondary-aa` through `--k-secondary`, so both grays stay on the home page today |
| `--j-line` `#e7e6e2` | `--gl-border` (`#ededed`) | yes (small) | Public override `#e7e6e2` |
| `--j-gold` `#ffbb17` | `--gl-accent-gold` | no | Same value, use `--gl-accent-gold` |
| `--j-gold-text` `#8a5a00` | `--gl-accent-gold-text` (`#995900`) | yes | Public override `#8a5a00` (slightly darker, better contrast on the `#fff4d6` tag); signed-in keeps `#995900`. Layer 1's table said `#ad6700`; the token file says `#995900`, which is correct and now written here |
| `--j-note`, `--j-note-text`, `--j-note-meta` | none | n/a | Home-only sticky notes; stay `--j-*` on the home page, not shared |
| `--j-ease` | none | n/a | Home-only motion; stays |
| `--j-gutter` 16px / 32px | none | n/a | Becomes the public layout rule in the table above (no variable needed) |
| `--j-shadow`, `--j-shadow-lift` | `--gl-shadow-panel` (`0 2px 8px rgba(2,4,26,.06)`) | yes | Featured public cards only keep `--j-shadow` (public override of `--gl-shadow-panel`); ordinary cards on every layer have a border and no shadow |
| Card radius 18px | `--gl-radius-card` (12px) | yes | Public override `--gl-radius-card: 18px`; signed-in cards keep 12px |
| Popover 16px / items 10px; language menu 14px / 9px | none | n/a | Public-only menu radii as written; signed-in menus keep `--gl-shadow-menu` |
| Pill radius 999px | `--gl-radius-pill` | no | Same |
| Button height 52 / 40px | layer 1: 34px (44px on touch for important actions) | yes | Public pages: pill 52 / 40px; signed-in pages: 8px-radius button, 34px (44px on touch) |
| Body 16px / 1.7 | `--gl-text-base` 14px, `--gl-text-message` 15px | yes | Public pages 16px, signed-in 14px fields and 15px message body; the types are not merged, they sit on different layers |
| `.light` on `SampleL`; `--k-secondary` | `.light`, `--gl-text-secondary-aa` | no | Already the foundation |

### Signed-in baseline: where the conversation page and layer 1 disagree

Counted on 2026-11-05 across `components/opc/*.module.css`, the new-task page and the runtime work page (about 480 lines; approximate counts, the ranking matters, not the digits). The conversation page, not the layer 1 table, is the standard for signed-in pages.

| In code (count) | Layer 1 says | Decision |
| --- | --- | --- |
| Secondary and caption text `#6b6b6b` (121), `#666` (18), `#555` (19); `#777` once, `#999` once | `--gl-text-secondary` `#777`, `--gl-text-tertiary` `#999` | Signed-in secondary and tertiary text become `#6b6b6b` (`--gl-text-secondary-aa`); `#777` and `#999` retire (they fail 4.5:1 on white). `#666` maps to the same token, `#555` to `--gl-text-body` (`#444`) |
| Strong labels `#333` (34), headings `#262626` (40) | `--gl-text` only | Add `--gl-text-strong: #333` for labels and sub-headings; `#262626` stays `--gl-text` |
| Lines `#eee` (30), `#ededed` (11), `#ececec` (17), `#e5e5e5` (18), `#ddd` (7) | `--gl-border` `#ededed`, `--gl-border-control` `#e5e5e5`, `--gl-border-strong` `#dcdcdc` | `#eee`, `#ececec`, `#ededed` become `--gl-border`; `#e5e5e5` becomes `--gl-border-control`; `#ddd` becomes `--gl-border-strong` |
| Surfaces `#fafafa` (13), `#f7f7f7` (9), `#f4f4f5` (4), `#f5f5f5` (6), `#f1f1f2` (1) | `--gl-surface-subtle`, `--gl-canvas`, `--gl-surface-muted` | `#fafafa` to `--gl-surface-subtle`; `#f7f7f7` to `--gl-canvas`; `#f4f4f5`, `#f5f5f5`, `#f1f1f2` to `--gl-surface-muted` |
| Primary `#242424` (8), `#222` (3) | `--gl-action` `#262626` | Both become `--gl-action` |
| Radii: 8px (30), 7px (17), 12px (15), 6px (13), 9px (10), 20px (9), 16px (6), 10px (6), 14px (4) | 6, 8, 12, 18, 25px | Round to the step: 5, 6, 7 to 6px; 8, 9, 10 to 8px; 11, 12, 14 to 12px; 16, 18, 20 to 18px; composer stays 25px |
| Font sizes: 12px (89), 11px (51), 13px (49), 14px (33), 10px (20), 15px (12), 18px (11), 16px (10), 17px (8) | 11, 12, 13, 14, 15, 17px | 10px becomes 11px (no text below 11px); 16px becomes 15px (message) or 17px (title) by role; 18px and above are headings and stay |

### Which layer the entry pages follow

| Page | Layer | Reason | What it takes from the other layer |
| --- | --- | --- | --- |
| Sign-in, sign-up, email verification, forgot and reset password | **Public layer** | The visitor arrives from the home page's call-to-action and has no session yet; the page must read as the next screen of the same site (the audit found the light-dark switch at this step is the largest source of "not unified"). Same canvas `#fafaf9`, the shared public brand header, ink `#141312`, a white card at 18px, the submit button as the 52px pill, minimum height `100dvh` so the iOS keyboard cannot push the card off screen | Fields and labels follow the layer 1 base components (white, `--gl-border-control`, 8px radius, label always visible, 16px text on phones so iOS does not zoom); error and success use `--gl-error` / `--gl-success` notices. The audit proposed a 12px card and a dark button without a shape; the card is now 18px and the button a pill because the public layer exists |
| Pricing | **Public layer** | It is indexed, reached from the public header and read before an account exists; users compare it with the home page's promise. Page shell, canvas, headings, 18px price cards with a border and no shadow, the recommended plan marked by a gold border and tag, pill call-to-action | The checkout dialog it opens (payment method, card form) is a signed-in dialog: white, 18px radius, `--gl-shadow-dialog`, light backdrop, primary action first and dark |
| Profile center (membership, credits, billing, profile, security, tickets, consent, erasure) | **Signed-in layer** | It is part of the signed-in session and reached from the workbench top bar; its neighbours are the conversation and library pages. Shell `WorkspaceFrame` or the shared light page shell with the global header, canvas `#f7f7f7`, cards 12px with a 1px border and no shadow, dark `#262626` 34px buttons (44px on touch), gold only for the current plan tag, state colors from `--gl-*` | Nothing; no glow, grid background, gradient buttons or white 8% borders |

This matches the 2026-11-05 audit's proposals (sign-in on a light shell, pricing under the light public shell, profile center on the workbench shell); the two differences are the card radius and the button shape on the sign-in pages, explained above.

## Overview

### Creative North Star

GraylumAI uses the visual hierarchy of a quiet editing studio: the active work is brightly legible, supporting context recedes into dark surfaces, and gold marks the current target and the single action that moves the work forward.

### Product context and register

- **Audience and primary job:** Chinese-speaking creators and small teams who need an Agent to turn uncertain ideas into reusable social-media work.
- **Target markets and evidence:** The positioning and content workflows in this repository address OPC social-media operations; the UI must not imply an unsupported geography.
- **Locales and language policy:** Product UI is Chinese-first. English identifiers appear only when they are part of an external account or technical artifact. `PingFang SC`, `Hiragino Sans GB`, and `Microsoft YaHei` provide CJK fallbacks.
- **Usage scene:** Repeated desktop work with long conversations and structured review; mobile stacks the same flow without removing any action.
- **Register:** Product application. Familiar chat, form, navigation, and status patterns take priority over decorative expression.
- **Memorable signature:** A compact gold target mark identifies the current work, and gold identifies the one primary continuation action.
- **Restraint:** Dense forms, billing states, recovery states, and account handoffs use calm borders and plain language.
- **Anti-references:** Avoid marketing-page hero treatments inside workspaces, card grids for sequential steps, hidden primary forms, and technical recovery jargon in normal flows.
- **Token ownership/runtime mapping:** This file mirrors the implemented tokens in `apps/web/src/app/globals.css`; it does not generate runtime CSS.

## Colors

The application is dark-first. `#0A0A0A` is the page background, `#1A1A1A` and `#2A2A2A` separate working surfaces, and `#333333` provides quiet boundaries. White and `#B0B0B0` establish text hierarchy. Gold `#FFD700` is reserved for active selection, focus, and the primary progression action. Green and red communicate saved/success and actionable failure states.

## Typography

The existing system stack supports mixed Chinese and Latin text. Headings use weight for hierarchy; body copy stays at normal weight with comfortable line height. Controls use sentence case. Monospace is reserved for IDs, code, and immutable technical evidence.

## Layout

Pages use the existing responsive spacing scale and a maximum width of `90rem` for two-pane workspaces. The global header remains visible. A compact work strip names the business and current target; a collapsible evidence summary holds positioning, method, source, confirmed facts, and pending facts without taking over the conversation.

On wide screens, the Agent conversation remains uninterrupted on the left and the current material or document opens on the right. Candidate cards and short results remain at their point in the conversation. On narrow screens, conversation remains primary and the material/document pane opens as a dismissible sheet. Closing the pane, viewing history, or making an unsaved manual edit protects that view from being replaced by a late result.

## Elevation & Depth

Hierarchy uses tonal surfaces and one-pixel borders. Sticky workspace panes may use their surface color to preserve readability. Shadows remain limited to menus, dialogs, and existing primary-button feedback; routine cards do not float.

## Shapes

Controls use the existing 8px radius. Major work areas use 12px to 16px radii. Pills are reserved for compact status or selection; normal actions remain rectangular and labeled.

## Components

### Foundational visual states

Focus uses the gold ring defined by the runtime theme. Disabled controls preserve their geometry. Long operations show specific inline status. Autosave uses `正在自动保存`, `已自动保存`, and an actionable failure with retry; it does not block continued typing.

### Buttons and actions

Each working pane has one primary action. Outline buttons handle recovery, revision, or optional actions. Destructive actions remain separated and explicit. Busy labels keep button width stable.

### Navigation and data display

The work strip always distinguishes the current operation target from content that is merely being viewed. Opening a title previews its material; only an explicit continuation action changes the target. Saved results, candidates, versions, and plans use readable lists or cards rather than decorative dashboards. Do not expose future steps as a generic Agent-workspace navigation pattern; a Skill may show its own real progress when that progress helps the current task.

### Forms and overlays

Labels remain visible above fields. Routine structured-form edits autosave after an IME-safe debounce and expose saved, syncing, failure, and retry states. Long-form documents may use an explicit save action when the version boundary matters; success must show the saved version and a direct route to its library record. Domain metadata such as certainty and source nature is available through a secondary disclosure so it does not obscure the questions users must answer.

### Iconography

Use the repository's existing Lucide icons when an icon improves recognition. Primary and ambiguous actions keep text labels.

### Motion

Use existing 150–300ms state transitions for focus and control feedback. Do not animate long content movement. Reduced-motion preferences must keep every state understandable.

### Content and data visualization

Instructions use direct Chinese verbs and explain the next decision. A recovery message states whether the original request is being checked and whether a new charge or model request can occur. Simulated output is always labeled.

## Do's and Don'ts

- **Do:** Keep the Agent conversation visible while the user reviews the current step.
- **Do:** Keep candidate cards in conversation and full material in the document pane.
- **Do:** Preserve the current work target while the user previews another item.
- **Do:** Let the structured form be the editable step result and freeze it only on explicit confirmation.
- **Do:** Preserve user text locally and on the server across refresh and sign-in recovery.
- **Don't:** Require a manual save button for ordinary form edits.
- **Don't:** Ask the user to copy the form into a second work-draft or trigger a duplicate organizer pass.
- **Don't:** Hide the current task behind explanatory cards or implementation terminology.
- **Don't:** Hard-code coaching questions, response templates, or content-generation order into the workspace shell.
- **Do:** Render positioning steps and questions from the draft's published Skill revision. A newly uploaded Skill package can declare changed structure in `workflow.yaml`; see [Skill workflow manifest](docs/skills/workflow-manifest.md). Existing drafts retain their bound revision.
- **Do:** In the library, show the confirmed account positioning as saved; when editing without a pending revision, preview the latest published Skill questions without writing until Save. A pending revision stays on its pinned questions, and Save rejects a Skill change made during editing.
- **Don't:** Make the library a required detour before continuing the selected content.
