import "../globals.css";
import { RootDocument, rootMetadata } from "@/components/layout/RootDocument";

// Root layout of the Traditional Chinese (Taiwan) pages under /zh-tw: <html lang="zh-Hant-TW"> (SEO_GEO_SPEC section
// 15). Moving between this and the Simplified root layout is a full page load, as for any two root layouts.
export const generateMetadata = rootMetadata;

export default function TaiwanRootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <RootDocument locale="zh-TW">{children}</RootDocument>;
}
