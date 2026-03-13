import Link from 'next/link';
import { ArrowRight, TrendingUp, Users, Zap } from 'lucide-react';

export default function HeroSection() {
  return (
    <section className="relative flex min-h-[92vh] items-center justify-center overflow-hidden pt-20 md:min-h-screen">
      {/* Background Effects */}
      <div className="absolute inset-0">
        {/* Gradient Base */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#0A0A0A] via-[#1A1A1A] to-[#0A0A0A]" />

        {/* Gold Glow - Top Right */}
        <div
          className="absolute -top-24 -right-24 h-[360px] w-[360px] rounded-full opacity-20 blur-[64px] md:-top-32 md:-right-32 md:h-[520px] md:w-[520px] md:opacity-25 md:blur-[88px]"
          style={{
            background: 'linear-gradient(135deg, #FFA500 0%, #FFD700 100%)',
          }}
        />

        {/* Purple Glow - Left */}
        <div
          className="absolute top-1/3 -left-20 h-[240px] w-[240px] rounded-full opacity-10 blur-[56px] md:-left-28 md:h-[340px] md:w-[340px] md:opacity-15 md:blur-[76px]"
          style={{ background: 'rgba(139, 92, 246, 0.6)' }}
        />

        {/* Grid Pattern */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: '60px 60px',
          }}
        />

        {/* Vignette */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 80% 70% at 50% 50%, transparent 30%, rgba(0,0,0,0.4) 70%, rgba(0,0,0,0.7) 100%)',
          }}
        />
      </div>

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        {/* Badge */}
        <div className="landing-fade-in-up mb-8 inline-flex items-center gap-2 rounded-full border border-[#333333] bg-[#1A1A1A] px-4 py-2">
          <Zap className="w-4 h-4 text-[#FFD700]" />
          <span className="text-sm text-[#B0B0B0]">AI 驱动的社媒增长专家</span>
        </div>

        {/* Main Headline */}
        <h1 className="landing-fade-in-up landing-delay-100 mb-6 text-4xl font-bold text-white sm:text-5xl md:text-6xl lg:text-7xl">
          从零到
          <span className="bg-gradient-to-r from-[#FFD700] to-[#FFA500] bg-clip-text text-transparent">
            百万粉丝
          </span>
        </h1>

        {/* Subheadline */}
        <p className="landing-fade-in-up landing-delay-200 mx-auto mb-8 max-w-3xl text-lg text-[#B0B0B0] sm:text-xl">
          6 步 AI 增长策略系统，让你的社交媒体账号实现指数级增长。
          <br className="hidden sm:block" />
          账号审计、受众研究、内容策略、内容创作、增长优化、变现指导。
        </p>

        {/* CTA Buttons */}
        <div className="landing-fade-in-up landing-delay-300 mb-16 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Link
            href="/login?action=signup"
            className="group flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#FFD700] to-[#FFA500] px-8 py-4 text-lg font-bold text-[#0A0A0A] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[0_0_24px_rgba(255,215,0,0.32)]"
          >
            免费开始
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </Link>
          <a
            href="#features"
            className="rounded-xl border border-[#333333] px-8 py-4 text-lg font-semibold text-white transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 hover:border-[#FFD700] hover:bg-[#FFD700]/10"
          >
            了解更多
          </a>
        </div>

        {/* Stats */}
        <div className="landing-fade-in-up landing-delay-400 mx-auto grid max-w-3xl grid-cols-1 gap-8 sm:grid-cols-3">
          <div className="flex flex-col items-center p-6 rounded-2xl bg-[#1A1A1A]/50 border border-[#333333] hover:border-[#FFD700]/30 transition-colors">
            <Users className="w-8 h-8 text-[#FFD700] mb-3" />
            <div className="text-3xl font-bold text-white mb-1">10K+</div>
            <div className="text-sm text-[#808080]">活跃用户</div>
          </div>
          <div className="flex flex-col items-center p-6 rounded-2xl bg-[#1A1A1A]/50 border border-[#333333] hover:border-[#FFD700]/30 transition-colors">
            <TrendingUp className="w-8 h-8 text-[#FFD700] mb-3" />
            <div className="text-3xl font-bold text-white mb-1">300%</div>
            <div className="text-sm text-[#808080]">平均增长率</div>
          </div>
          <div className="flex flex-col items-center p-6 rounded-2xl bg-[#1A1A1A]/50 border border-[#333333] hover:border-[#FFD700]/30 transition-colors">
            <Zap className="w-8 h-8 text-[#FFD700] mb-3" />
            <div className="text-3xl font-bold text-white mb-1">1M+</div>
            <div className="text-sm text-[#808080]">内容生成</div>
          </div>
        </div>
      </div>

      {/* Scroll Indicator */}
      <div className="absolute bottom-8 left-1/2 hidden -translate-x-1/2 motion-safe:animate-bounce md:block">
        <div className="flex h-10 w-6 items-start justify-center rounded-full border-2 border-[#333333] p-2">
          <div className="landing-scroll-down h-3 w-1.5 rounded-full bg-[#FFD700]" />
        </div>
      </div>
    </section>
  );
}
