import { LightFirstPaint } from "@/components/layout/LightFirstPaint";

// This route's finished page is light (WorkspaceFrame), so its first painted frame must be light too.
export default function LightRouteLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <LightFirstPaint />
      {children}
    </>
  );
}
