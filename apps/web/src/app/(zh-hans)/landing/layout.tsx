// Shared dark background for the landing previews.
export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-[#0A0A0A]">{children}</div>;
}
