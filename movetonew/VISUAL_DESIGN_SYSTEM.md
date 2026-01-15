# GraylumAI Visual Design System

> **Source**: Extracted from `graylumAi-backup` project
> **Created**: 2026-01-15
> **Purpose**: Reference document for UI restoration (Phase 4)

---

## 1. Color System

### 1.1 Primary Colors (Brand)
| Variable | Value | Usage |
|----------|-------|-------|
| `--color-primary` | `#FFD700` | Gold - Primary buttons, important elements, brand color |
| `--color-secondary` | `#FFA500` | Orange-gold - Secondary buttons, auxiliary emphasis |
| `--color-accent` | `#22C55E` | Green - Success state, positive actions |

### 1.2 Primary Color Variants (Transparency)
| Variable | Value | Usage |
|----------|-------|-------|
| `--color-primary-10` | `rgba(255, 215, 0, 0.1)` | Light background |
| `--color-primary-20` | `rgba(255, 215, 0, 0.2)` | Hover background |
| `--color-primary-30` | `rgba(255, 215, 0, 0.3)` | Active background |

### 1.3 Background Colors (Dark Theme Hierarchy)
| Variable | Value | Usage |
|----------|-------|-------|
| `--bg-primary` | `#0A0A0A` | Deepest - Page main background |
| `--bg-secondary` | `#1A1A1A` | Secondary - Cards, containers |
| `--bg-tertiary` | `#2A2A2A` | Tertiary - Input fields, dropdowns |
| `--bg-elevated` | `#3A3A3A` | Elevated - Popups, modals |

### 1.4 Text Colors
| Variable | Value | Usage |
|----------|-------|-------|
| `--text-primary` | `#FFFFFF` | Primary text - Titles, important content |
| `--text-secondary` | `#B0B0B0` | Secondary text - Descriptions |
| `--text-tertiary` | `#808080` | Tertiary text - Hints, placeholders |
| `--text-disabled` | `#606060` | Disabled text - Non-clickable state |
| `--text-inverse` | `#0A0A0A` | Inverse text - On light backgrounds |

### 1.5 Status Colors
| Variable | Value | Background | Usage |
|----------|-------|------------|-------|
| `--success` | `#22C55E` | `rgba(34, 197, 94, 0.1)` | Success state |
| `--warning` | `#F59E0B` | `rgba(245, 158, 11, 0.1)` | Warning state |
| `--error` | `#EF4444` | `rgba(239, 68, 68, 0.1)` | Error state |
| `--info` | `#3B82F6` | `rgba(59, 130, 246, 0.1)` | Info state |

### 1.6 Border Colors
| Variable | Value | Usage |
|----------|-------|-------|
| `--border-primary` | `#333333` | Primary border - Cards, containers |
| `--border-secondary` | `#444444` | Secondary border - Dividers |
| `--border-focus` | `#FFD700` | Focus border - Input focus state |

---

## 2. Typography System

### 2.1 Font Families
```css
--font-primary: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI',
                'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei',
                'Helvetica Neue', Helvetica, Arial, sans-serif;

--font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Consolas',
             'Liberation Mono', 'Menlo', monospace;
```

### 2.2 Font Sizes - Headings
| Variable | Value | Pixels | Usage |
|----------|-------|--------|-------|
| `--text-h1` | `2rem` | 32px | Page main title |
| `--text-h2` | `1.5rem` | 24px | Section title |
| `--text-h3` | `1.25rem` | 20px | Subsection title |
| `--text-h4` | `1.125rem` | 18px | Card title |

### 2.3 Font Sizes - Body
| Variable | Value | Pixels | Usage |
|----------|-------|--------|-------|
| `--text-body` | `1rem` | 16px | Body content |
| `--text-small` | `0.875rem` | 14px | Secondary text |
| `--text-xs` | `0.75rem` | 12px | Labels, badges |

### 2.4 Font Weights
| Variable | Value | Usage |
|----------|-------|-------|
| `--font-normal` | `400` | Regular |
| `--font-medium` | `500` | Medium |
| `--font-semibold` | `600` | Semi-bold |
| `--font-bold` | `700` | Bold |

### 2.5 Line Heights
| Variable | Value | Usage |
|----------|-------|-------|
| `--leading-tight` | `1.25` | Compact - Headings |
| `--leading-normal` | `1.6` | Normal - Body text |
| `--leading-relaxed` | `1.75` | Relaxed - Long text |

---

## 3. Spacing System

Based on 4px grid system:

| Variable | Value | Usage |
|----------|-------|-------|
| `--space-xs` | `4px` | Extra small - Icon to text |
| `--space-sm` | `8px` | Small - Compact element spacing |
| `--space-md` | `16px` | Medium - Standard spacing |
| `--space-lg` | `24px` | Large - Block spacing |
| `--space-xl` | `32px` | Extra large - Section spacing |
| `--space-2xl` | `48px` | 2X large - Page level spacing |
| `--space-3xl` | `64px` | 3X large - Major block separation |

---

## 4. Border Radius System

| Variable | Value | Usage |
|----------|-------|-------|
| `--radius-none` | `0` | No radius |
| `--radius-sm` | `4px` | Small - Labels, badges |
| `--radius-md` | `8px` | Medium - Buttons, inputs |
| `--radius-lg` | `12px` | Large - Cards |
| `--radius-xl` | `16px` | Extra large - Modals |
| `--radius-2xl` | `24px` | 2X large - Large containers |
| `--radius-full` | `9999px` | Full round - Avatars, tags |

---

## 5. Shadow System

### 5.1 Standard Shadows
| Variable | Value | Usage |
|----------|-------|-------|
| `--shadow-sm` | `0 2px 4px rgba(0, 0, 0, 0.1)` | Small - Slight elevation |
| `--shadow-md` | `0 4px 12px rgba(0, 0, 0, 0.15)` | Medium - Cards |
| `--shadow-lg` | `0 8px 24px rgba(0, 0, 0, 0.2)` | Large - Popups |
| `--shadow-xl` | `0 12px 48px rgba(0, 0, 0, 0.25)` | Extra large - Modals |

### 5.2 Glow Effects (Gold)
| Variable | Value | Usage |
|----------|-------|-------|
| `--shadow-glow-sm` | `0 0 10px rgba(255, 215, 0, 0.2)` | Small gold glow |
| `--shadow-glow` | `0 0 20px rgba(255, 215, 0, 0.3)` | Standard gold glow |
| `--shadow-glow-lg` | `0 0 40px rgba(255, 215, 0, 0.4)` | Large gold glow |

---

## 6. Transition System

| Variable | Value | Usage |
|----------|-------|-------|
| `--transition-fast` | `0.15s ease` | Fast - Button hover |
| `--transition-normal` | `0.3s ease` | Normal - Most interactions |
| `--transition-slow` | `0.5s ease` | Slow - Page transitions |
| `--transition-bounce` | `0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)` | Bounce effect |

---

## 7. Z-Index System

| Variable | Value | Usage |
|----------|-------|-------|
| `--z-base` | `0` | Base layer |
| `--z-dropdown` | `100` | Dropdown menus |
| `--z-sticky` | `200` | Sticky elements |
| `--z-fixed` | `300` | Fixed elements |
| `--z-modal-backdrop` | `400` | Modal backdrop |
| `--z-modal` | `500` | Modal content |
| `--z-popover` | `600` | Popover cards |
| `--z-tooltip` | `700` | Tooltips |
| `--z-toast` | `800` | Toast notifications |

---

## 8. Responsive Breakpoints

| Breakpoint | Width | Usage |
|------------|-------|-------|
| Mobile | `< 640px` | Phone screens |
| Tablet | `640px - 1024px` | Tablet screens |
| Desktop | `> 1024px` | Desktop screens |
| Large | `> 1280px` | Large screens |

---

## 9. Component Style Patterns

### 9.1 Button Styles (`.btn`)

**Base Button:**
```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-lg);
  min-height: 40px;
  font-size: var(--text-body);
  font-weight: var(--font-medium);
  border-radius: var(--radius-md);
  transition: transform var(--transition-normal), box-shadow var(--transition-normal);
}

.btn:hover {
  transform: translateY(-1px);
}

.btn:active {
  transform: translateY(0);
}
```

**Primary Button (Gold Gradient):**
```css
.btn-primary {
  background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%);
  color: var(--text-inverse);
  font-weight: var(--font-semibold);
}

.btn-primary:hover {
  box-shadow: var(--shadow-glow);
  transform: translateY(-2px);
}
```

**Secondary Button (Gold Border):**
```css
.btn-secondary {
  background-color: transparent;
  color: var(--color-primary);
  border: 1px solid var(--color-primary);
}

.btn-secondary:hover {
  background-color: var(--color-primary-10);
  box-shadow: var(--shadow-glow-sm);
}
```

### 9.2 Card Styles (`.card`)

**Base Card:**
```css
.card {
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  transition: transform var(--transition-normal), box-shadow var(--transition-normal);
}

.card:hover {
  border-color: var(--border-secondary);
  box-shadow: var(--shadow-md);
}
```

**Clickable Card:**
```css
.card-clickable:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
}
```

**Featured Card (Gold Border):**
```css
.card-featured {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-glow-sm);
}

.card-featured:hover {
  box-shadow: var(--shadow-glow);
}
```

### 9.3 Badge Styles (`.badge`)

```css
.badge {
  display: inline-flex;
  align-items: center;
  padding: var(--space-xs) var(--space-sm);
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
  border-radius: var(--radius-full);
}

.badge-primary {
  background-color: var(--color-primary-20);
  color: var(--color-primary);
}
```

### 9.4 Skeleton Loading

```css
.skeleton {
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  position: relative;
  overflow: hidden;
}

.skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent 0%, var(--bg-elevated) 50%, transparent 100%);
  animation: skeleton-loading 1.5s ease-in-out infinite;
}

@keyframes skeleton-loading {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
```

### 9.5 Gradient Text

```css
.text-gradient {
  background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

---

## 10. Sidebar CSS Variables (Shadcn/ui)

These variables are used by Shadcn/ui sidebar components:

```css
/* Light Mode */
--sidebar-background: 0 0% 98%;
--sidebar-foreground: 240 5.3% 26.1%;
--sidebar-primary: 240 5.9% 10%;
--sidebar-primary-foreground: 0 0% 98%;
--sidebar-accent: 240 4.8% 95.9%;
--sidebar-accent-foreground: 240 5.9% 10%;
--sidebar-border: 220 13% 91%;
--sidebar-ring: 217.2 91.2% 59.8%;

/* Dark Mode */
--sidebar-background: 240 5.9% 10%;
--sidebar-foreground: 240 4.8% 95.9%;
--sidebar-primary: 224.3 76.3% 48%;
--sidebar-primary-foreground: 0 0% 100%;
--sidebar-accent: 240 3.7% 15.9%;
--sidebar-accent-foreground: 240 4.8% 95.9%;
--sidebar-border: 240 3.7% 15.9%;
--sidebar-ring: 217.2 91.2% 59.8%;
```

---

## 11. Global Base Styles

### 11.1 Box Model Reset
```css
*, *::before, *::after {
  box-sizing: border-box;
}
```

### 11.2 HTML Root
```css
html {
  font-size: 16px;
  scroll-behavior: smooth;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

### 11.3 Scrollbar Styles
```css
/* Webkit */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: var(--bg-secondary);
  border-radius: var(--radius-full);
}

::-webkit-scrollbar-thumb {
  background: var(--bg-elevated);
  border-radius: var(--radius-full);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--color-primary-30);
}

/* Firefox */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--bg-elevated) var(--bg-secondary);
}
```

### 11.4 Text Selection
```css
::selection {
  background-color: var(--color-primary-30);
  color: var(--text-primary);
}
```

### 11.5 Focus Styles
```css
:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

:focus:not(:focus-visible) {
  outline: none;
}
```

---

## 12. Gap Analysis: Current vs Old Project

### 12.1 Missing in New Project (globals.css)

| Variable | Status | Notes |
|----------|--------|-------|
| `--color-primary-10` | Missing | Add transparency variants |
| `--color-primary-20` | Missing | Add transparency variants |
| `--color-primary-30` | Missing | Add transparency variants |
| `--success-bg` | Missing | Add status background colors |
| `--warning-bg` | Missing | Add status background colors |
| `--error-bg` | Missing | Add status background colors |
| `--info-bg` | Missing | Add status background colors |
| `--sidebar-*` | Missing | Add sidebar CSS variables |
| `--chart-*` | Missing | Add chart color variables |

### 12.2 Component Classes to Add

| Class | Status | Notes |
|-------|--------|-------|
| `.btn`, `.btn-primary`, `.btn-secondary` | Missing | Add button component classes |
| `.card-clickable`, `.card-featured` | Missing | Add card variant classes |
| `.badge`, `.badge-primary` | Missing | Add badge component classes |
| `.skeleton`, `.skeleton-*` | Missing | Add skeleton loading classes |
| `.text-gradient` | Missing | Add gradient text class |
| `.container` | Missing | Add container class |

---

## 13. Migration Checklist

- [ ] Add missing CSS variables to `:root`
- [ ] Add missing sidebar variables
- [ ] Add chart color variables
- [ ] Add component classes (@layer components)
- [ ] Verify scrollbar styles match
- [ ] Verify selection styles match
- [ ] Verify focus styles match
- [ ] Test all status colors render correctly
