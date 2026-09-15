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

## Overview

### Creative North Star

GraylumAI uses the visual hierarchy of a quiet editing studio: the active work is brightly legible, supporting context recedes into dark surfaces, and gold marks the single action that moves the work forward.

### Product context and register

- **Audience and primary job:** Chinese-speaking creators and small teams who need an Agent to turn uncertain ideas into reusable social-media work.
- **Target markets and evidence:** The positioning and content workflows in this repository address OPC social-media operations; the UI must not imply an unsupported geography.
- **Locales and language policy:** Product UI is Chinese-first. English identifiers appear only when they are part of an external account or technical artifact. `PingFang SC`, `Hiragino Sans GB`, and `Microsoft YaHei` provide CJK fallbacks.
- **Usage scene:** Repeated desktop work with long conversations and structured review; mobile stacks the same flow without removing any action.
- **Register:** Product application. Familiar chat, form, navigation, and status patterns take priority over decorative expression.
- **Memorable signature:** Gold identifies the active step and the one primary continuation action.
- **Restraint:** Dense forms, billing states, recovery states, and account handoffs use calm borders and plain language.
- **Anti-references:** Avoid marketing-page hero treatments inside workspaces, card grids for sequential steps, hidden primary forms, and technical recovery jargon in normal flows.
- **Token ownership/runtime mapping:** This file mirrors the implemented tokens in `apps/web/src/app/globals.css`; it does not generate runtime CSS.

## Colors

The application is dark-first. `#0A0A0A` is the page background, `#1A1A1A` and `#2A2A2A` separate working surfaces, and `#333333` provides quiet boundaries. White and `#B0B0B0` establish text hierarchy. Gold `#FFD700` is reserved for active selection, focus, and the primary progression action. Green and red communicate saved/success and actionable failure states.

## Typography

The existing system stack supports mixed Chinese and Latin text. Headings use weight for hierarchy; body copy stays at normal weight with comfortable line height. Controls use sentence case. Monospace is reserved for IDs, code, and immutable technical evidence.

## Layout

Pages use the existing responsive spacing scale and a maximum width of `90rem` for two-pane workspaces. Sequential step navigation stays horizontally scrollable. On wide screens, guided workflows place the persistent conversation on the left and the current structured result on the right. On narrow screens, conversation appears first and the form follows. Only the selected step occupies the working area.

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

Step navigation shows order, active state, and confirmed state. Future dependent steps may remain visible but disabled. Saved results and plans use readable lists rather than decorative dashboards.

### Forms and overlays

Labels remain visible above fields. Routine text edits autosave after an IME-safe debounce and expose saved, syncing, failure, and retry states. Domain metadata such as certainty and source nature is available through a secondary disclosure so it does not obscure the questions users must answer.

### Iconography

Use the repository's existing Lucide icons when an icon improves recognition. Primary and ambiguous actions keep text labels.

### Motion

Use existing 150–300ms state transitions for focus and control feedback. Do not animate long content movement. Reduced-motion preferences must keep every state understandable.

### Content and data visualization

Instructions use direct Chinese verbs and explain the next decision. A recovery message states whether the original request is being checked and whether a new charge or model request can occur. Simulated output is always labeled.

## Do's and Don'ts

- **Do:** Keep the Agent conversation visible while the user reviews the current step.
- **Do:** Let the structured form be the editable step result and freeze it only on explicit confirmation.
- **Do:** Preserve user text locally and on the server across refresh and sign-in recovery.
- **Don't:** Require a manual save button for ordinary form edits.
- **Don't:** Ask the user to copy the form into a second work-draft or trigger a duplicate organizer pass.
- **Don't:** Hide the current task behind explanatory cards or implementation terminology.
