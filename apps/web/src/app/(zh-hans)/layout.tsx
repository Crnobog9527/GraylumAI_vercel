import "../globals.css";
import { RootDocument, rootMetadata } from "@/components/layout/RootDocument";

// Root layout of the Simplified site, the logged-in app (/app), admin and login pages: <html lang="zh-Hans">.
export const generateMetadata = rootMetadata;

export default function SimplifiedRootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <RootDocument locale="zh-Hans">{children}</RootDocument>;
}
