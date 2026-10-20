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
`version-compare.module.css`, `apps/web/src/app/app/runtime/runtime-work.module.css`,
and the library's `library.module.css`, adapted
from the accepted local high-fidelity reference. The new-task surface is in
`apps/web/src/app/app/positioning/start-work.module.css`.
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

The Owner decided on 2026-10-13 that this file is the only design specification, in three layers:
(1) this foundation, taken from the accepted conversation workbench; (2) the public-page layer (hero,
article text, price cards, sticky notes, FAQ, header and footer, section rhythm, motion), written here
after the Owner picks one of the public-page samples; (3) the management layer (tables, long forms,
settings, statistics, empty states), added when the signed-in pages are unified after launch.

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
| Gold accent | `--gl-accent-gold`, `--gl-accent-gold-soft`, `--gl-accent-gold-text` | `#ffbb17`, 10% tint, `#ad6700` | credit widget, membership |
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
