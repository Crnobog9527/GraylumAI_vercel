import type { Metadata } from "next";
import { getPublicSiteSettings } from "@/lib/public-site";

export async function generateMetadata(): Promise<Metadata> {
  const { siteName } = await getPublicSiteSettings();
  const title = `${siteName} - AI 驱动的社媒增长平台`;
  const description = "用更贴近真实运营场景的 AI 工作流完成账号审计、受众研究、内容策略、内容生成与增长优化。";

  return {
    title,
    description,
    keywords: ["AI", "社交媒体", "增长", "内容策略", "创作者"],
    openGraph: {
      title,
      description,
      type: "website",
      locale: "zh_CN",
    },
  };
}

export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="min-h-screen bg-[#0A0A0A]">{children}</div>;
}
