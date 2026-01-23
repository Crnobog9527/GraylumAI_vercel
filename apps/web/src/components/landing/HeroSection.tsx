'use client';

import { ArrowRight, Zap, TrendingUp, Users } from 'lucide-react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.graylum.com';

export default function HeroSection() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-20">
      {/* Background Effects */}
      <div className="absolute inset-0">
        {/* Gradient Base */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#0A0A0A] via-[#1A1A1A] to-[#0A0A0A]" />

        {/* Gold Glow - Top Right */}
        <div
          className="absolute -top-32 -right-32 w-[600px] h-[600px] rounded-full opacity-30 blur-[120px]"
          style={{
            background: 'linear-gradient(135deg, #FFA500 0%, #FFD700 100%)',
          }}
        />

        {/* Purple Glow - Left */}
        <div
          className="absolute top-1/3 -left-32 w-[400px] h-[400px] rounded-full opacity-20 blur-[100px]"
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
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#1A1A1A] border border-[#333333] mb-8 animate-fadeInUp">
          <Zap className="w-4 h-4 text-[#FFD700]" />
          <span className="text-sm text-[#B0B0B0]">AI 驱动的社媒增长专家</span>
        </div>

        {/* Main Headline */}
        <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold text-white mb-6 animate-fadeInUp animation-delay-100">
          从零到
          <span className="bg-gradient-to-r from-[#FFD700] to-[#FFA500] bg-clip-text text-transparent">
            百万粉丝
          </span>
        </h1>

        {/* Subheadline */}
        <p className="text-lg sm:text-xl text-[#B0B0B0] max-w-3xl mx-auto mb-8 animate-fadeInUp animation-delay-200">
          6 步 AI 增长策略系统，让你的社交媒体账号实现指数级增长。
          <br className="hidden sm:block" />
          账号审计、受众研究、内容策略、内容创作、增长优化、变现指导。
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16 animate-fadeInUp animation-delay-300">
          <a
            href={`${APP_URL}/login?action=signup`}
            className="group px-8 py-4 bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-[#0A0A0A] rounded-xl font-bold text-lg hover:shadow-[0_0_30px_rgba(255,215,0,0.4)] transition-all hover:-translate-y-1 flex items-center gap-2"
          >
            免费开始
            <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
          </a>
          <a
            href="#features"
            className="px-8 py-4 border border-[#333333] text-white rounded-xl font-semibold text-lg hover:border-[#FFD700] hover:bg-[#FFD700]/10 transition-all"
          >
            了解更多
          </a>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 max-w-3xl mx-auto animate-fadeInUp animation-delay-400">
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
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
        <div className="w-6 h-10 rounded-full border-2 border-[#333333] flex items-start justify-center p-2">
          <div className="w-1.5 h-3 bg-[#FFD700] rounded-full animate-scrollDown" />
        </div>
      </div>

      {/* Custom Animations */}
      <style jsx>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes scrollDown {
          0%,
          100% {
            transform: translateY(0);
            opacity: 1;
          }
          50% {
            transform: translateY(8px);
            opacity: 0.5;
          }
        }

        .animate-fadeInUp {
          animation: fadeInUp 0.8s ease-out forwards;
        }

        .animation-delay-100 {
          animation-delay: 0.1s;
          opacity: 0;
        }

        .animation-delay-200 {
          animation-delay: 0.2s;
          opacity: 0;
        }

        .animation-delay-300 {
          animation-delay: 0.3s;
          opacity: 0;
        }

        .animation-delay-400 {
          animation-delay: 0.4s;
          opacity: 0;
        }

        .animate-scrollDown {
          animation: scrollDown 1.5s ease-in-out infinite;
        }
      `}</style>
    </section>
  );
}
