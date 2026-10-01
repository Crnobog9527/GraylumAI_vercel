import type { ReactNode } from 'react';
import { Loader2, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

// Single-card layout shared by the password reset pages; same look as /verify-email.
export function AuthPageCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-[#070707] px-4 py-6 sm:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-xl items-center justify-center">
        <Card
          className="w-full rounded-[28px] border"
          style={{
            background: 'linear-gradient(180deg, rgba(16,16,16,0.96), rgba(10,10,10,0.96))',
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <CardContent className="space-y-6 px-6 py-7 sm:px-8">
            <div className="space-y-4 text-center">
              <div
                className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[rgba(242,201,76,0.12)] text-[#f2c94c]"
              >
                <Icon className="h-8 w-8" aria-hidden="true" />
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold text-white">{title}</h1>
                <p className="mx-auto max-w-md text-sm leading-7 text-[#b5b5b5] sm:text-base">{description}</p>
              </div>
            </div>
            {children}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

export function AuthPageLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#070707] px-4">
      <Loader2 className="h-8 w-8 animate-spin text-[#f2c94c]" />
    </div>
  );
}

export const AUTH_INPUT_CLASS = 'h-12 rounded-2xl border-[#2d2d2d] bg-[#131313] text-white placeholder:text-[#686868]';
export const AUTH_PRIMARY_BUTTON_CLASS = 'h-12 w-full rounded-2xl bg-[#f2c94c] text-black hover:bg-[#f7d96c]';
export const AUTH_LINK_CLASS = 'text-[#f2c94c] underline-offset-4 hover:underline';
