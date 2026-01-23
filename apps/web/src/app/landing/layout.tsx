import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GraylumAI - AI 驱动的社媒增长专家",
  description: "从零到百万粉丝，AI 驱动的 6 步增长策略系统。账号审计、受众研究、内容策略、内容创作、增长优化、变现指导。",
  keywords: ["AI", "社交媒体", "增长", "内容创作", "自媒体"],
  openGraph: {
    title: "GraylumAI - AI 驱动的社媒增长专家",
    description: "从零到百万粉丝，AI 驱动的 6 步增长策略系统",
    type: "website",
    locale: "zh_CN",
  },
};

export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0A0A0A]">
      {children}
    </div>
  );
}
