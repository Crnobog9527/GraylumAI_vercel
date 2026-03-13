# Phase 4 Local Performance Baseline

Last updated: 2026-03-12

## Scope

This signoff covers pages that can be validated locally without relying on live provider responses:

- `/profile`
- `/marketplace`
- `/admin/settings`
- `/admin/transactions`
- `/admin/finance`
- `/landing`
- shared landing/public surfaces (`LandingHeader`, `LandingFooter`, `PricingSection`, `PublicPageHero`)
- shared app surfaces (`AppHeader`, prompt/module cards)

## Hotspots Found Before Cleanup

### Marketplace

- Large blurred background layers (`blur-[90px]` to `blur-[120px]`) were always rendered on mobile.
- The filter bar used `sticky + backdrop-blur-xl`, which increased repaint cost during scroll.
- Category, sorting, and pagination controls used repeated `transition-all` and hover scale effects.

### Profile

- Background glow layers were oversized for small screens.
- Subscription and credits cards used broad `transition-all` rules on large containers and nested cards.
- Credit record rows used JS-driven hover handlers to mutate border and shadow styles.

### Shared Landing and App Surfaces

- Shared headers still used broad blur and `transition-all` rules even after the earlier mobile layout pass.
- Landing pricing cards still combined large top glow on mobile with broad `transition-all` hover animations.
- Prompt and template cards still used repeated `transition-all` on high-frequency interactive surfaces.

### Admin

- Main gains already came from Work Package A:
  - reduced nested overflow containers
  - mobile-first stacking of headers and controls
  - horizontal scrolling constrained to table regions instead of page-level wrappers

## Cleanup Applied

### Marketplace

- Reduced mobile glow sizes, opacity, and blur radius while keeping desktop visuals intact.
- Downgraded the mobile filter bar blur from `backdrop-blur-xl` to `backdrop-blur-md`.
- Replaced broad `transition-all` usage with narrower color/transform transitions.
- Limited hover scale effects to `md` and above.

### Profile

- Reduced mobile background glow size and blur strength.
- Removed broad container-level `transition-all` usage from subscription and credits surfaces.
- Narrowed animations to `transition-colors` or `transition-opacity` where needed.
- Removed JS hover mutation from credit transaction rows to avoid per-row style writes.

### Shared Landing and App Surfaces

- Downgraded the app header blur to `backdrop-blur-md` on mobile while keeping desktop depth.
- Replaced `transition-all` on the shared app header, landing header, pricing cards, template cards, and prompt-module cards with targeted transitions (`transform`, `opacity`, `colors`, or `box-shadow`).
- Reduced the mobile top glow footprint in `PricingSection` from desktop-scale blur to a smaller mobile-specific glow.
- Kept desktop emphasis effects where they still carry visual hierarchy value.

### Landing Completion Pass

- Reduced oversized hero and CTA glow layers on mobile and narrowed desktop blur radii.
- Replaced broad CTA and hero button transitions with targeted transform/shadow or color transitions.
- Added `prefers-reduced-motion` fallbacks for hero entrance motion and CTA particle motion.
- Hid continuous decorative particle motion on small screens and reduced the CTA particle count.
- Added `content-visibility: auto` and `contain-intrinsic-size` to below-the-fold landing sections and public-page hero shells so they do less initial work before entering the viewport.
- Reduced the public-page hero glow and tightened CTA hover cost on support/legal/tutorial surfaces.

### Landing Hydration Reduction Pass

- Converted `LandingFooter` back to a server component so it no longer hydrates on every public page.
- Moved landing animation keyframes out of `styled-jsx` and into global CSS so `HeroSection` and `CTASection` can render as server components again.
- Converted `AudienceSection`, `FeaturesSection`, `WhyChooseSection`, and `FAQPreviewSection` back to server components because they are static content blocks with no client-side state.
- Removed the retired `AudienceSection`, `WhyChooseSection`, and `FAQPreviewSection` entirely once the homepage was restored to its original information structure, so the landing component surface now matches the real page composition.
- Kept only `LandingHeader` on the client because it still owns scroll state and the mobile menu.
- Removed `content-visibility` from `PublicPageHero` because it is the first visible block on public support/legal/tutorial pages and should not be treated like below-the-fold content.
- Left deferred rendering only on sections that actually sit below the fold; `PricingSection` was moved back to normal rendering after local verification exposed hydration instability on the homepage.
- Extended the same deferred-rendering pattern to the long-form body sections on `/contact`, `/tutorials`, `/faq`, `/terms`, `/privacy`, and `/acceptable-use`, so those independent pages keep the new routes and content while avoiding full below-the-fold layout work on first paint.

## Expected Local Impact

- Lower paint cost on 360px/390px profile and marketplace pages.
- Less scroll jank on the marketplace filter bar.
- Fewer layout and style recalculations when moving across transaction rows and package cards.
- Lower animation overhead on small screens without changing business behavior.
- Lower repaint and style recalculation cost on shared high-traffic surfaces such as the global header, landing CTA area, and prompt cards.
- Lower first-load and scroll cost on `/contact`, `/tutorials`, `/faq`, and legal support pages due to deferred section rendering and lighter decorative layers.
- Smaller hydration surface on public marketing routes because large static blocks no longer ship as client components.
- Smaller landing hydration surface because the hero, CTA, and supporting marketing sections now render on the server and only the header remains interactive.
- Lower repaint cost on support/tutorial pages from reduced hero glow, softer footer logo blur, and lighter large-card shadows.
- Lower repaint cost on shared marketing routes from a lighter scrolled-header blur and reduced landing CTA/logo glow shadows.

## Remaining Non-Blocking Issues

- Marketplace still intentionally keeps decorative gradients and keyframe entrance animations; they are lighter now but not removed.
- Admin finance and costs pages still render dense analytical surfaces on mobile; the current work prioritizes structure and readability over aggressive visual simplification.
- Landing hero, CTA, and pricing still intentionally keep decorative gradients and glow layers; they are reduced, not removed.
- No hosted Lighthouse run is recorded here; this signoff is still scoped to local, code-path-aware verification and interaction stability.
- Live provider latency is intentionally excluded from this document and remains covered by the Vercel runtime evidence tracked elsewhere.

## Final Verification Evidence

The following local verification set passed after the last performance-oriented admin shell-first refactors:

- `pnpm --dir apps/web exec tsc --noEmit`
- `pnpm --dir apps/web build`
- `PLAYWRIGHT_BASE_URL='http://localhost:3002' pnpm --dir apps/web exec playwright test tests/e2e/auth.spec.ts --project=chromium --grep 'landing page in www mode|public support and legal pages|load profile page when logged in'`
- `PLAYWRIGHT_BASE_URL='http://127.0.0.1:3001' pnpm --dir apps/web exec playwright test tests/e2e/user-supplemental.spec.ts --project=chromium --grep 'browse marketplace modules, change sort order, and open a module detail flow'`
- `PLAYWRIGHT_BASE_URL='http://127.0.0.1:3001' pnpm --dir apps/web exec playwright test tests/e2e/user-extended.spec.ts --project=chromium --grep 'high-value profile tabs|daily check-in flow'`
- `PLAYWRIGHT_BASE_URL='http://127.0.0.1:3001' pnpm --dir apps/web exec playwright test tests/e2e/chat.spec.ts --project=chromium --grep 'should require confirmation before sending oversized long text prompts'`
- `PLAYWRIGHT_BASE_URL='http://127.0.0.1:3001' pnpm --dir apps/web exec playwright test tests/e2e/admin-ops.spec.ts --project=chromium --grep 'operational read pages'`

## Signoff Conclusion

The local performance work is complete enough to count as final non-payment signoff:

- high-traffic public/landing surfaces have reduced blur, glow, and hydration cost
- profile, marketplace, chat, and admin operational read pages no longer block on full-page loading shells before showing actionable UI
- no hydration mismatch remains in the signed-off public route subset
- remaining items in this document are non-blocking polish notes, not release blockers
