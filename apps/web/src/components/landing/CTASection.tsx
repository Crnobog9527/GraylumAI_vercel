import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';
import { buildAuthHref } from '@/lib/site-config';
const PARTICLES = Array.from({ length: 10 }, (_, index) => ({
  left: `${(index * 17 + (index % 3) * 11) % 100}%`,
  top: `${(index * 23 + (index % 4) * 7) % 100}%`,
  animationDuration: `${3 + (index % 5) * 0.7}s`,
  animationDelay: `${(index % 4) * 0.35}s`,
}));

export default function CTASection() {
  return (
    <section className="relative overflow-hidden py-24 md:py-32">
      {/* Background */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] to-[#1A1A1A]" />

        {/* Gold Glow */}
        <div
          className="absolute top-1/2 left-1/2 h-[360px] w-[320px] -translate-x-1/2 -translate-y-1/2 opacity-20 blur-[64px] md:h-[560px] md:w-[720px] md:opacity-25 md:blur-[92px]"
          style={{
            background: 'radial-gradient(circle, #FFD700 0%, #FFA500 30%, transparent 70%)',
          }}
        />

        {/* Animated Particles */}
        <div aria-hidden="true" className="absolute inset-0 hidden overflow-hidden md:block">
          {PARTICLES.map((particle, index) => (
            <div
              key={index}
              className="landing-float-particle absolute h-1 w-1 rounded-full bg-[#FFD700] opacity-30"
              style={{
                left: particle.left,
                top: particle.top,
                ['--landing-float-duration' as string]: particle.animationDuration,
                ['--landing-float-delay' as string]: particle.animationDelay,
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

        <div className="flex items-center justify-center">
          <Link
            href={buildAuthHref('/login?action=signup')}
            className="group inline-flex items-center gap-3 rounded-2xl bg-gradient-to-r from-[#FFD700] to-[#FFA500] px-10 py-5 text-xl font-bold text-[#0A0A0A] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[0_0_28px_rgba(255,215,0,0.38)]"
          >
            免费开始
            <ArrowRight className="w-6 h-6 group-hover:translate-x-2 transition-transform" />
          </Link>
        </div>

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
    </section>
  );
}
