## 🎨 UI 还原计划 - Claude Code 执行手册

**文档版本**: 1.0
**生成日期**: 2026-01-14

---

## 📖 使用指南

恭喜您完成了所有业务逻辑的迁移！现在，我们将专注于恢复您网站的原始视觉风格。

这个阶段的目标是将旧项目中的设计系统（颜色、字体、间距、圆角、阴影等）映射到新的 Next.js + Tailwind CSS + Shadcn/ui 架构中。

请继续按照分步执行的方式，将每个【任务块】复制给 Claude Code。

---

## 🚀 阶段十二：全局样式与主题还原 (2-3天)

**目标**: 将原有设计系统中的全局颜色、字体、间距、圆角、阴影等变量，配置到 Tailwind CSS 和 Shadcn/ui 的主题中，实现全局视觉风格的统一。

---

### ## 任务 12.1：配置 Tailwind CSS 颜色变量

**任务描述**: 将旧 `theme.css` 中的颜色变量映射到 `tailwind.config.ts` 中，以便 Tailwind CSS 可以使用这些颜色。

**给 Claude Code 的指令**:

```
请将 `/home/ubuntu/graylumAi-refactor/apps/web/tailwind.config.ts` 文件的 `theme.extend.colors` 部分更新为以下内容，以引入原有设计系统的颜色变量。

```typescript
// ... 其他配置

      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // GraylumAI Custom Colors
        graylumPrimary: "#FFD700",      // --color-primary
        graylumSecondary: "#FFA500",    // --color-secondary
        graylumAccent: "#22C55E",       // --color-accent
        graylumBgPrimary: "#0A0A0A",     // --bg-primary
        graylumBgSecondary: "#1A1A1A",   // --bg-secondary
        graylumBgTertiary: "#2A2A2A",    // --bg-tertiary
        graylumBgElevated: "#3A3A3A",    // --bg-elevated
        graylumTextPrimary: "#FFFFFF",   // --text-primary
        graylumTextSecondary: "#B0B0B0", // --text-secondary
        graylumTextTertiary: "#808080",  // --text-tertiary
        graylumTextDisabled: "#606060",  // --text-disabled
        graylumTextInverse: "#0A0A0A",   // --text-inverse
        graylumSuccess: "#22C55E",       // --success
        graylumWarning: "#F59E0B",       // --warning
        graylumError: "#EF4444",         // --error
        graylumInfo: "#3B82F6",          // --info
        graylumBorderPrimary: "#333333", // --border-primary
        graylumBorderSecondary: "#444444",// --border-secondary
        graylumBorderFocus: "#FFD700",   // --border-focus
      },

// ... 其他配置
```

**预期输出**:
- `tailwind.config.ts` 文件更新成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 在任何组件中使用 `text-graylumPrimary` 或 `bg-graylumBgPrimary` 等 Tailwind 类，检查颜色是否正确应用。

---

### ## 任务 12.2：配置 Shadcn/ui 主题颜色

**任务描述**: 将旧 `theme.css` 中的颜色变量映射到 `globals.css` 中，作为 CSS 变量提供给 Shadcn/ui 组件使用。

**给 Claude Code 的指令**:

```
请将 `/home/ubuntu/graylumAi-refactor/apps/web/src/app/globals.css` 文件中的 `:root` 和 `.dark` 选择器下的 CSS 变量进行更新，以匹配原有设计系统的颜色。

**请将 `globals.css` 的内容更新为以下内容：**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 3.9%; /* #0A0A0A - graylumBgPrimary */
    --foreground: 0 0% 98%; /* #FFFFFF - graylumTextPrimary */

    --card: 0 0% 6.9%; /* #1A1A1A - graylumBgSecondary */
    --card-foreground: 0 0% 98%;

    --popover: 0 0% 6.9%;
    --popover-foreground: 0 0% 98%;

    --primary: 47 100% 50%; /* #FFD700 - graylumPrimary */
    --primary-foreground: 0 0% 3.9%; /* #0A0A0A - graylumTextInverse */

    --secondary: 29 100% 50%; /* #FFA500 - graylumSecondary */
    --secondary-foreground: 0 0% 98%;

    --muted: 0 0% 14.9%; /* #2A2A2A - graylumBgTertiary */
    --muted-foreground: 0 0% 63.9%; /* #B0B0B0 - graylumTextSecondary */

    --accent: 137 70% 46%; /* #22C55E - graylumAccent */
    --accent-foreground: 0 0% 98%;

    --destructive: 359 78% 68%; /* #EF4444 - graylumError */
    --destructive-foreground: 0 0% 98%;

    --border: 0 0% 20%; /* #333333 - graylumBorderPrimary */
    --input: 0 0% 14.9%; /* #2A2A2A - graylumBgTertiary */
    --ring: 47 100% 50%; /* #FFD700 - graylumBorderFocus */

    --radius: 0.5rem; /* 8px - graylumRadiusMd */
  }

  .dark {
    --background: 0 0% 3.9%;
    --foreground: 0 0% 98%;

    --card: 0 0% 6.9%;
    --card-foreground: 0 0% 98%;

    --popover: 0 0% 6.9%;
    --popover-foreground: 0 0% 98%;

    --primary: 47 100% 50%;
    --primary-foreground: 0 0% 3.9%;

    --secondary: 29 100% 50%;
    --secondary-foreground: 0 0% 98%;

    --muted: 0 0% 14.9%;
    --muted-foreground: 0 0% 63.9%;

    --accent: 137 70% 46%;
    --accent-foreground: 0 0% 98%;

    --destructive: 359 78% 68%;
    --destructive-foreground: 0 0% 98%;

    --border: 0 0% 20%;
    --input: 0 0% 14.9%;
    --ring: 47 100% 50%;

    --radius: 0.5rem;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
    font-family: var(--font-primary);
  }
}

/* GraylumAI Custom Fonts */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMwM.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/jetbrainsmono/v18/HMfy2gYl_Ft7_JgR0W5D_7pt_z8.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

:root {
  --font-primary: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', 'Consolas', 'Liberation Mono', 'Menlo', monospace;

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;
  --space-2xl: 48px;
  --space-3xl: 64px;

  /* Border Radius */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xl: 24px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 2px 4px rgba(0, 0, 0, 0.1);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.15);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.2);
  --shadow-xl: 0 12px 48px rgba(0, 0, 0, 0.25);
  --shadow-glow: 0 0 20px rgba(255, 215, 0, 0.3);
  --shadow-glow-sm: 0 0 10px rgba(255, 215, 0, 0.2);
  --shadow-glow-lg: 0 0 40px rgba(255, 215, 0, 0.4);

  /* Transitions */
  --transition-fast: 0.15s ease;
  --transition-normal: 0.3s ease;
  --transition-slow: 0.5s ease;
  --transition-bounce: 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);

  /* Z-Index */
  --z-base: 0;
  --z-dropdown: 100;
  --z-sticky: 200;
  --z-fixed: 300;
  --z-modal-backdrop: 400;
  --z-modal: 500;
  --z-popover: 600;
  --z-tooltip: 700;
  --z-toast: 800;
}

/* Global base styles from old theme.css */
*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  font-size: 16px;
  scroll-behavior: smooth;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

code,
pre {
  font-family: var(--font-mono);
}

code {
  padding: 2px 6px;
}

pre {
  padding: var(--space-md);
  overflow-x: auto;
}

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: var(--card);
  border-radius: var(--radius-full);
}

::-webkit-scrollbar-thumb {
  background: var(--muted);
  border-radius: var(--radius-full);
  transition: var(--transition-fast);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--primary);
}

* {
  scrollbar-width: thin;
  scrollbar-color: var(--muted) var(--card);
}

::selection {
  background-color: var(--primary);
  color: var(--foreground);
}

:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

:focus:not(:focus-visible) {
  outline: none;
}
```

**预期输出**:
- `globals.css` 文件更新成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 检查页面的背景色、文字颜色、边框颜色等是否与旧项目的主题一致。
- 检查 Shadcn/ui 组件（如 Button, Card）的颜色是否与新主题匹配。

---

### ## 任务 12.3：配置 Tailwind CSS 字体和间距

**任务描述**: 将旧 `theme.css` 中的字体和间距变量映射到 `tailwind.config.ts` 中。

**给 Claude Code 的指令**:

```
请将 `/home/ubuntu/graylumAi-refactor/apps/web/tailwind.config.ts` 文件的 `theme.extend` 部分更新为以下内容，以引入原有设计系统的字体和间距变量。

```typescript
// ... 其他配置

      extend: {
        colors: { /* ... 保持任务 12.1 的内容 ... */ },
        fontFamily: {
          sans: ["var(--font-primary)", ...fontFamily.sans],
          mono: ["var(--font-mono)", ...fontFamily.mono],
        },
        spacing: {
          xs: "var(--space-xs)",
          sm: "var(--space-sm)",
          md: "var(--space-md)",
          lg: "var(--space-lg)",
          xl: "var(--space-xl)",
          "2xl": "var(--space-2xl)",
          "3xl": "var(--space-3xl)",
        },
        borderRadius: {
          lg: "var(--radius)",
          md: "calc(var(--radius) - 2px)",
          sm: "calc(var(--radius) - 4px)",
          graylumSm: "var(--radius-sm)",
          graylumMd: "var(--radius-md)",
          graylumLg: "var(--radius-lg)",
          graylumXl: "var(--radius-xl)",
          graylum2xl: "var(--radius-2xl)",
          graylumFull: "var(--radius-full)",
        },
        boxShadow: {
          graylumSm: "var(--shadow-sm)",
          graylumMd: "var(--shadow-md)",
          graylumLg: "var(--shadow-lg)",
          graylumXl: "var(--shadow-xl)",
          graylumGlow: "var(--shadow-glow)",
          graylumGlowSm: "var(--shadow-glow-sm)",
          graylumGlowLg: "var(--shadow-glow-lg)",
        },
        transitionTimingFunction: {
          "graylum-bounce": "var(--transition-bounce)",
        },
        transitionDuration: {
          "graylum-fast": "var(--transition-fast)",
          "graylum-normal": "var(--transition-normal)",
          "graylum-slow": "var(--transition-slow)",
        },
        zIndex: {
          "graylum-base": "var(--z-base)",
          "graylum-dropdown": "var(--z-dropdown)",
          "graylum-sticky": "var(--z-sticky)",
          "graylum-fixed": "var(--z-fixed)",
          "graylum-modal-backdrop": "var(--z-modal-backdrop)",
          "graylum-modal": "var(--z-modal)",
          "graylum-popover": "var(--z-popover)",
          "graylum-tooltip": "var(--z-tooltip)",
          "graylum-toast": "var(--z-toast)",
        },
      },

// ... 其他配置
```

**预期输出**:
- `tailwind.config.ts` 文件更新成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 在任何组件中使用 `font-sans`, `font-mono`, `p-graylumMd`, `rounded-graylumLg`, `shadow-graylumGlow` 等 Tailwind 类，检查样式是否正确应用。

---

### ## 任务 12.4：提交第十二阶段成果

**任务描述**: 提交全局样式与主题还原的代码。

**给 Claude Code 的指令**:

```
请在 `/home/ubuntu/graylumAi-refactor` 目录下执行以下 shell 命令：

git add . && \
git commit -m "feat: apply global styles and theme from old design system

- Map old CSS variables to Tailwind CSS colors, fonts, spacing, border-radius, shadows, transitions, and z-index.
- Update globals.css to include custom fonts and base styles.
- Ensure Shadcn/ui components adopt the new theme." && \
git push origin refactor
```

**预期输出**:
- git commit 和 push 的成功信息。

---

**阶段十二完成！**

您已成功将旧项目的设计系统集成到新架构中。现在，您的应用应该已经具备了与旧项目相似的全局视觉风格。接下来，我们将专注于核心 UI 组件的样式还原。


---

## 🚀 阶段十三：核心 UI 组件样式还原 (3-5天)

**目标**: 针对 Shadcn/ui 的核心组件，根据原有 UI 的设计稿或截图，进行样式定制，使其与旧项目的外观保持一致。

---

### ## 任务 13.1：定制 Button 组件样式

**任务描述**: 根据旧项目按钮的样式（颜色、圆角、阴影、悬停效果），定制 Shadcn/ui 的 `Button` 组件。

**给 Claude Code 的指令**:

```
请修改 `/home/ubuntu/graylumAi-refactor/apps/web/src/components/ui/button.tsx` 文件，调整其样式以匹配旧项目的按钮风格。

**`button.tsx` 文件中 `buttonVariants` 的修改示例：**

```typescript
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-graylumPrimary text-graylumTextInverse hover:bg-graylumPrimary/90 shadow-graylumGlowSm", // 主色按钮
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-graylumBorderPrimary bg-background hover:bg-graylumBgSecondary hover:text-graylumTextPrimary", // 边框按钮
        secondary:
          "bg-graylumSecondary text-graylumTextInverse hover:bg-graylumSecondary/90", // 次色按钮
        ghost: "hover:bg-graylumBgSecondary hover:text-graylumTextPrimary",
        link: "text-graylumPrimary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
```
```

**预期输出**:
- `button.tsx` 文件更新成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 检查应用中的所有按钮，特别是主色、次色和边框按钮，看其颜色、圆角和悬停效果是否与旧项目一致。

---

### ## 任务 13.2：定制 Card 组件样式

**任务描述**: 根据旧项目卡片的样式（背景色、圆角、阴影、边框），定制 Shadcn/ui 的 `Card` 组件。

**给 Claude Code 的指令**:

```
请修改 `/home/ubuntu/graylumAi-refactor/apps/web/src/components/ui/card.tsx` 文件，调整其样式以匹配旧项目的卡片风格。

**`card.tsx` 文件中 `Card` 组件的修改示例：**

```typescript
import * as React from "react"

import { cn } from "@/lib/utils"

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-graylumLg border border-graylumBorderPrimary bg-graylumBgSecondary text-graylumTextPrimary shadow-graylumMd", // 应用旧项目卡片样式
        className
      )}
      {...props}
    />
  )
)
Card.displayName = "Card"

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-col space-y-1.5 p-6", className)}
      {...props}
    />
  )
)
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn("font-semibold leading-none tracking-tight text-graylumTextPrimary", className)}
      {...props}
    />
  )
)
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn("text-sm text-graylumTextSecondary", className)}
      {...props}
    />
  )
)
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  )
)
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex items-center p-6 pt-0", className)}
      {...props}
    />
  )
)
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
```
```

**预期输出**:
- `card.tsx` 文件更新成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 检查应用中的所有卡片组件，看其背景、边框、圆角和阴影是否与旧项目一致。

---

### ## 任务 13.3：定制 Input 和 Textarea 组件样式

**任务描述**: 根据旧项目输入框和文本域的样式（背景、边框、聚焦效果），定制 Shadcn/ui 的 `Input` 和 `Textarea` 组件。

**给 Claude Code 的指令**:

```
请修改 `/home/ubuntu/graylumAi-refactor/apps/web/src/components/ui/input.tsx` 和 `/home/ubuntu/graylumAi-refactor/apps/web/src/components/ui/textarea.tsx` 文件，调整其样式以匹配旧项目的输入框风格。

**`input.tsx` 文件中 `Input` 组件的修改示例：**

```typescript
import * as React from "react"

import { cn } from "@/lib/utils"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-graylumBorderPrimary bg-graylumBgTertiary px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-graylumTextTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-graylumBorderFocus focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50", // 应用旧项目输入框样式
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
```

**`textarea.tsx` 文件中 `Textarea` 组件的修改示例：**

```typescript
import * as React from "react"

import { cn } from "@/lib/utils"

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-md border border-graylumBorderPrimary bg-graylumBgTertiary px-3 py-2 text-sm ring-offset-background placeholder:text-graylumTextTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-graylumBorderFocus focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50", // 应用旧项目文本域样式
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
```
```

**预期输出**:
- `input.tsx` 和 `textarea.tsx` 文件更新成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 检查应用中的所有输入框和文本域，看其背景、边框和聚焦效果是否与旧项目一致。

---

### ## 任务 13.4：提交第十三阶段成果

**任务描述**: 提交核心 UI 组件样式还原的代码。

**给 Claude Code 的指令**:

```
请在 `/home/ubuntu/graylumAi-refactor` 目录下执行以下 shell 命令：

git add . && \
git commit -m "feat: restore core UI component styles

- Customize Shadcn/ui Button component to match old design.
- Customize Shadcn/ui Card component to match old design.
- Customize Shadcn/ui Input and Textarea components to match old design." && \
git push origin refactor
```

**预期输出**:
- git commit 和 push 的成功信息。

---

**阶段十三完成！**

您已成功定制了核心 UI 组件的样式。现在，您的应用在组件层面应该已经具备了与旧项目相似的外观。接下来，我们将专注于页面布局和交互细节的还原。


---

## 🚀 阶段十四：页面布局与交互细节还原 (3-5天)

**目标**: 调整关键页面的布局（例如，聊天页面、仪表盘）并恢复特定的交互细节（例如，动画、自定义滚动条）以匹配旧 UI。

---

### ## 任务 14.1：调整聊天页面布局

**任务描述**: 根据旧项目的聊天页面布局，调整 `HomePage` 的结构，确保对话列表和聊天界面的宽度、间距和响应式行为与旧项目一致。

**给 Claude Code 的指令**:

```
请将 `/home/ubuntu/graylumAi-refactor/apps/web/src/app/page.tsx` 文件的内容完全替换为以下代码，以调整聊天页面的布局。

```typescript
'use client';

import { useState } from 'react';
import { ConversationList } from '@/components/chat/ConversationList';
import { ChatInterface } from '@/components/chat/ChatInterface';
import { Button } from '@/components/ui/button';
import { PlusIcon } from '@radix-ui/react-icons';

export default function HomePage() {
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  return (
    <div className="flex h-screen bg-graylumBgPrimary text-graylumTextPrimary">
      {/* Left Sidebar for Conversations */}
      <div className="w-80 border-r border-graylumBorderPrimary flex flex-col">
        <div className="p-4 flex justify-between items-center">
          <h2 className="text-lg font-semibold">Conversations</h2>
          <Button variant="ghost" size="icon" onClick={() => setSelectedConversationId(null)}>
            <PlusIcon className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex-grow overflow-y-auto p-4 space-y-2">
          <ConversationList onSelectConversation={setSelectedConversationId} />
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-grow flex flex-col">
        {selectedConversationId ? (
          <ChatInterface conversationId={selectedConversationId} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-graylumTextSecondary">Select a conversation or start a new one</p>
          </div>
        )}
      </div>
    </div>
  );
}
```
```

**预期输出**:
- 文件写入成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 访问主页 (`/`)，检查聊天页面的布局是否与旧项目一致，特别是侧边栏的宽度、分隔线和背景色。

---

### ## 任务 14.2：恢复自定义滚动条样式

**任务描述**: 确保应用中的滚动条样式与旧 `theme.css` 中定义的自定义滚动条样式一致。这已经在 `globals.css` 中配置，但需要确保其在所有可滚动区域生效。

**给 Claude Code 的指令**:

```
请确保 `/home/ubuntu/graylumAi-refactor/apps/web/src/app/globals.css` 文件中包含以下滚动条样式。如果缺少，请添加。

```css
/* Webkit 浏览器滚动条 (Chrome, Safari, Edge) */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: var(--card);
  border-radius: var(--radius-full);
}

::-webkit-scrollbar-thumb {
  background: var(--muted);
  border-radius: var(--radius-full);
  transition: var(--transition-fast);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--primary);
}

/* Firefox 滚动条 */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--muted) var(--card);
}
```
```

**预期输出**:
- `globals.css` 文件确认包含滚动条样式。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 检查任何有滚动条的区域（例如聊天消息列表、对话列表），看滚动条的颜色和样式是否与旧项目一致。

---

### ## 任务 14.3：恢复全局动画和过渡效果

**任务描述**: 确保应用中的动画和过渡效果与旧 `theme.css` 中定义的 `transition-fast`, `transition-normal`, `transition-slow`, `transition-bounce` 一致。这主要通过 Tailwind CSS 的配置实现。

**给 Claude Code 的指令**:

```
请确保 `/home/ubuntu/graylumAi-refactor/apps/web/tailwind.config.ts` 文件的 `theme.extend` 部分包含以下过渡动画配置。如果缺少，请添加。

```typescript
// ... 其他配置

      extend: {
        // ... 其他 extend 配置
        transitionTimingFunction: {
          "graylum-bounce": "var(--transition-bounce)",
        },
        transitionDuration: {
          "graylum-fast": "var(--transition-fast)",
          "graylum-normal": "var(--transition-normal)",
          "graylum-slow": "var(--transition-slow)",
        },
      },

// ... 其他配置
```
```

**预期输出**:
- `tailwind.config.ts` 文件确认包含过渡动画配置。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 检查按钮悬停、模态框弹出等交互，看动画效果是否流畅且符合旧项目风格。

---

### ## 任务 14.4：提交第十四阶段成果

**任务描述**: 提交页面布局和交互细节还原的代码。

**给 Claude Code 的指令**:

```
请在 `/home/ubuntu/graylumAi-refactor` 目录下执行以下 shell 命令：

git add . && \
git commit -m "feat: restore page layouts and interaction details

- Adjust chat page layout to match old design.
- Ensure custom scrollbar styles are applied globally.
- Verify global animation and transition effects." && \
git push origin refactor
```

**预期输出**:
- git commit 和 push 的成功信息。

---

**阶段十四完成！**

恭喜您！至此，GraylumAI 项目的 UI 还原工作也已基本完成。您的应用现在不仅拥有了现代化的架构和完整的业务逻辑，还恢复了原有的视觉风格和交互体验。

**下一步**：您可以将 `refactor` 分支合并到 `main` 分支，然后部署到 Vercel。
