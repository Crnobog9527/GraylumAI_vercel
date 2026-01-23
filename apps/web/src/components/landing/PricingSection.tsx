'use client';

import { Check, Sparkles, Zap, Crown } from 'lucide-react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.graylum.com';

const plans = [
  {
    name: '入门版',
    icon: Zap,
    price: '99',
    credits: '1,000',
    description: '适合个人创作者起步使用',
    features: [
      '1,000 AI 积分',
      '基础账号审计',
      '内容生成功能',
      '标准客服支持',
    ],
    cta: '开始使用',
    popular: false,
  },
  {
    name: '专业版',
    icon: Sparkles,
    price: '299',
    credits: '5,000',
    description: '专业创作者的最佳选择',
    features: [
      '5,000 AI 积分',
      '深度账号诊断',
      '受众分析报告',
      '内容策略规划',
      '优先客服支持',
      '数据导出功能',
    ],
    cta: '立即购买',
    popular: true,
  },
  {
    name: '企业版',
    icon: Crown,
    price: '999',
    credits: '20,000',
    description: 'MCN 机构和团队的理想方案',
    features: [
      '20,000 AI 积分',
      '全部功能解锁',
      '多账号管理',
      '团队协作功能',
      '专属客户经理',
      'API 接口访问',
      '定制化服务',
    ],
    cta: '联系我们',
    popular: false,
  },
];

export default function PricingSection() {
  return (
    <section id="pricing" className="relative py-24 md:py-32">
      {/* Background */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-[#0A0A0A]" />
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] opacity-20 blur-[100px]"
          style={{ background: 'radial-gradient(circle, #FFD700 0%, transparent 70%)' }}
        />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#FFD700]/10 border border-[#FFD700]/20 mb-6">
            <span className="text-sm text-[#FFD700] font-medium">灵活定价</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white mb-6">
            选择适合你的
            <span className="bg-gradient-to-r from-[#FFD700] to-[#FFA500] bg-clip-text text-transparent">
              套餐
            </span>
          </h2>
          <p className="text-lg text-[#B0B0B0] max-w-2xl mx-auto">
            按需购买积分，没有订阅绑定，用多少付多少。
          </p>
        </div>

        {/* Pricing Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {plans.map((plan) => {
            const Icon = plan.icon;
            return (
              <div
                key={plan.name}
                className={`relative p-8 rounded-2xl transition-all duration-300 hover:-translate-y-2 ${
                  plan.popular
                    ? 'bg-gradient-to-b from-[#FFD700]/10 to-[#1A1A1A] border-2 border-[#FFD700]/50 shadow-[0_0_40px_rgba(255,215,0,0.15)]'
                    : 'bg-[#1A1A1A] border border-[#333333] hover:border-[#FFD700]/30'
                }`}
              >
                {/* Popular Badge */}
                {plan.popular && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 bg-gradient-to-r from-[#FFD700] to-[#FFA500] rounded-full text-[#0A0A0A] text-sm font-bold">
                    最受欢迎
                  </div>
                )}

                {/* Icon */}
                <div
                  className={`w-14 h-14 rounded-xl flex items-center justify-center mb-6 ${
                    plan.popular ? 'bg-[#FFD700]/20' : 'bg-[#2A2A2A]'
                  }`}
                >
                  <Icon
                    className={`w-7 h-7 ${plan.popular ? 'text-[#FFD700]' : 'text-[#B0B0B0]'}`}
                  />
                </div>

                {/* Plan Name */}
                <h3 className="text-xl font-bold text-white mb-2">{plan.name}</h3>
                <p className="text-sm text-[#808080] mb-6">{plan.description}</p>

                {/* Price */}
                <div className="mb-6">
                  <div className="flex items-baseline gap-1">
                    <span className="text-[#808080]">¥</span>
                    <span className="text-4xl font-bold text-white">{plan.price}</span>
                  </div>
                  <div className="text-sm text-[#FFD700] mt-1">{plan.credits} 积分</div>
                </div>

                {/* Features */}
                <ul className="space-y-3 mb-8">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-3">
                      <div
                        className={`w-5 h-5 rounded-full flex items-center justify-center ${
                          plan.popular ? 'bg-[#FFD700]/20' : 'bg-[#2A2A2A]'
                        }`}
                      >
                        <Check
                          className={`w-3 h-3 ${
                            plan.popular ? 'text-[#FFD700]' : 'text-[#22C55E]'
                          }`}
                        />
                      </div>
                      <span className="text-sm text-[#B0B0B0]">{feature}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA Button */}
                <a
                  href={`${APP_URL}/login?action=signup&plan=${plan.name}`}
                  className={`block w-full py-3 rounded-xl font-semibold text-center transition-all ${
                    plan.popular
                      ? 'bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-[#0A0A0A] hover:shadow-[0_0_20px_rgba(255,215,0,0.4)]'
                      : 'bg-[#2A2A2A] text-white border border-[#333333] hover:border-[#FFD700] hover:bg-[#FFD700]/10'
                  }`}
                >
                  {plan.cta}
                </a>
              </div>
            );
          })}
        </div>

        {/* Bottom Note */}
        <p className="text-center text-sm text-[#808080] mt-12">
          所有套餐均支持微信、支付宝付款。积分永久有效，不限制使用时间。
        </p>
      </div>
    </section>
  );
}
