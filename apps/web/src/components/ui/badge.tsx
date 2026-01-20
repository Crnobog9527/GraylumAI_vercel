"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/80",
        secondary:
          "border-transparent bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/80",
        destructive:
          "border-transparent bg-[var(--error)] text-white hover:bg-[var(--error)]/80",
        outline:
          "border-[var(--border-secondary)] text-[var(--text-secondary)]",
        success:
          "border-transparent bg-[var(--success-bg)] text-[var(--success)]",
        warning:
          "border-transparent bg-[var(--warning-bg)] text-[var(--warning)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
