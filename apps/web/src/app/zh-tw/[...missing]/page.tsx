import { notFound } from 'next/navigation';

// An address under /zh-tw that matches no page would otherwise reach app/global-not-found.tsx (Simplified,
// lang="zh-Hans"). This catch-all keeps it inside the Taiwan root layout, where zh-tw/not-found.tsx answers 404.
export default function TaiwanMissingPage() {
  notFound();
}
