'use client';

import { ArrowRight, Sparkles } from 'lucide-react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.graylum.com';

export default function CTASection() {
  return (
    <section className="relative py-24 md:py-32 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] to-[#1A1A1A]" />

        {/* Gold Glow */}
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] opacity-30 blur-[120px]"
          style={{
            background: 'radial-gradient(circle, #FFD700 0%, #FFA500 30%, transparent 70%)',
          }}
        />

        {/* Animated Particles */}
        <div className="absolute inset-0 overflow-hidden">
          {[...Array(20)].map((_, i) => (
            <div
              key={i}
              className="absolute w-1 h-1 bg-[#FFD700] rounded-full opacity-30"
              style={{
                left: `${Math.random() * 100}%`,
                top: `${Math.random() * 100}%`,
                animation: `float ${3 + Math.random() * 4}s ease-in-out infinite`,
                animationDelay: `${Math.random() * 2}s`,
              }}
            />
          ))}
        </div>
      </div>

      <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        {/* Icon */}
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-[#FFD700]/20 to-[#FFA500]/20 border border-[#FFD700]/30 mb-8">
          <Sparkles className="w-10 h-10 text-[#FFD700]" />
        </div>

        {/* Headline */}
        <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white mb-6">
          准备好开启你的
          <br />
          <span className="bg-gradient-to-r from-[#FFD700] to-[#FFA500] bg-clip-text text-transparent">
            增长之旅
          </span>
          了吗？
        </h2>

        {/* Description */}
        <p className="text-lg text-[#B0B0B0] mb-10 max-w-2xl mx-auto">
          立即注册，获得 100 积分免费体验。无需绑定信用卡，随时取消。
        </p>

        {/* CTA Button */}
        <a
          href={`${APP_URL}/login?action=signup`}
          className="group inline-flex items-center gap-3 px-10 py-5 bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-[#0A0A0A] rounded-2xl font-bold text-xl hover:shadow-[0_0_40px_rgba(255,215,0,0.5)] transition-all hover:-translate-y-1"
        >
          免费开始
          <ArrowRight className="w-6 h-6 group-hover:translate-x-2 transition-transform" />
        </a>

        {/* Trust Badges */}
        <div className="flex flex-wrap items-center justify-center gap-6 mt-12 text-sm text-[#808080]">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#22C55E]" />
            <span>安全支付</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#22C55E]" />
            <span>数据加密</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#22C55E]" />
            <span>7 天退款保障</span>
          </div>
        </div>
      </div>

      {/* Animation Keyframes */}
      <style jsx>{`
        @keyframes float {
          0%,
          100% {
            transform: translateY(0) scale(1);
            opacity: 0.3;
          }
          50% {
            transform: translateY(-20px) scale(1.5);
            opacity: 0.6;
          }
        }
      `}</style>
    </section>
  );
}
