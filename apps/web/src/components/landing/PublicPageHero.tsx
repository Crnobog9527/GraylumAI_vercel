/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

type PageAction = {
  label: string;
  href: string;
};

export default function PublicPageHero({
  eyebrow,
  title,
  description,
  primaryAction,
  secondaryAction,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  primaryAction?: PageAction;
  secondaryAction?: PageAction;
  children?: ReactNode;
}) {
  return (
    <section className="relative overflow-hidden border-b border-[#2A2A2A] bg-gradient-to-b from-[#0A0A0A] via-[#101010] to-[#0A0A0A]">
      <div
        className="absolute inset-x-0 top-0 mx-auto h-[220px] w-[280px] opacity-14 blur-[44px] md:h-[320px] md:w-[560px] md:opacity-18 md:blur-[72px]"
        style={{ background: 'radial-gradient(circle, #FFD700 0%, transparent 70%)' }}
      />
      <div className="relative mx-auto flex max-w-6xl flex-col gap-8 px-4 py-16 sm:px-6 md:py-20 lg:px-8">
        <div className="inline-flex w-fit items-center rounded-full border border-[#FFD700]/20 bg-[#FFD700]/10 px-4 py-2 text-sm font-medium text-[#FFD700]">
          {eyebrow}
        </div>
        <div className="max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl md:text-6xl">
            {title}
          </h1>
          <p className="mt-6 text-base leading-8 text-[#B8B8B8] sm:text-lg">{description}</p>
        </div>
        {(primaryAction || secondaryAction) && (
          <div className="flex flex-col gap-3 sm:flex-row">
            {primaryAction ? (
              <Link
                href={primaryAction.href}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#FFD700] to-[#FFA500] px-6 py-3 font-semibold text-[#0A0A0A] transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_0_10px_rgba(255,215,0,0.16)]"
              >
                {primaryAction.label}
                <ArrowRight className="h-4 w-4" />
              </Link>
            ) : null}
            {secondaryAction ? (
              <Link
                href={secondaryAction.href}
                className="inline-flex items-center justify-center rounded-xl border border-[#3A3A3A] px-6 py-3 font-semibold text-white transition-colors hover:border-[#FFD700]/50 hover:bg-[#FFD700]/10"
              >
                {secondaryAction.label}
              </Link>
            ) : null}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
