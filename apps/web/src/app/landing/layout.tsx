import { JsonLd } from "@/components/seo/JsonLd";
import { buildPageMetadata } from "@/lib/seo/metadata";
import { softwareApplicationJsonLd } from "@/lib/seo/structured-data";

// Home page wording approved by the Owner on 2026-10-12 (SEO_GEO_SPEC section 3.3). The public host
// serves this page at "/", so that is its canonical address.
const HOME_TITLE = "Graylum – AI 自媒体工具：定位、选题、写内容的 AI 自媒体陪跑教练";
const HOME_DESCRIPTION =
  "Graylum 是你的 AI 自媒体陪跑教练：帮你找准账号定位、决定每周发什么、写出能直接发的内容。免费开始定位诊断，一步步把账号做起来。";

export function generateMetadata() {
  return buildPageMetadata({ title: HOME_TITLE, absoluteTitle: true, description: HOME_DESCRIPTION, path: "/" });
}

export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0A0A0A]">
      <JsonLd data={softwareApplicationJsonLd({ description: HOME_DESCRIPTION })} />
      {children}
    </div>
  );
}
