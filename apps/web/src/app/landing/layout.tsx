// Shared dark background for the public landing and pricing pages. Metadata and JSON-LD are set by
// each page (the home page's live in app/landing/page.tsx).
export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-[#0A0A0A]">{children}</div>;
}
