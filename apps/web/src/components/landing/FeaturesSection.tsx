import {
  Search,
  Users,
  FileText,
  PenTool,
  TrendingUp,
  DollarSign,
  ArrowRight,
} from 'lucide-react';

const features = [
  {
    step: 1,
    icon: Search,
    title: '账号审计',
    description: 'AI 深度分析你的账号数据，找出增长瓶颈，制定优化策略。',
    color: '#FFD700',
  },
  {
    step: 2,
    icon: Users,
    title: '受众研究',
    description: '精准定位目标受众，了解他们的兴趣、痛点和行为习惯。',
    color: '#FFA500',
  },
  {
    step: 3,
    icon: FileText,
    title: '内容策略',
    description: '基于数据分析，制定科学的内容规划和发布时间表。',
    color: '#22C55E',
  },
  {
    step: 4,
    icon: PenTool,
    title: '内容创作',
    description: 'AI 辅助创作爆款内容，文案、脚本、图文一键生成。',
    color: '#3B82F6',
  },
  {
    step: 5,
    icon: TrendingUp,
    title: '增长优化',
    description: '实时监控数据表现，持续优化策略，实现指数级增长。',
    color: '#8B5CF6',
  },
  {
    step: 6,
    icon: DollarSign,
    title: '变现指导',
    description: '从流量到收益，提供全方位的商业化路径和变现策略。',
    color: '#EC4899',
  },
];

export default function FeaturesSection() {
  return (
    <section id="features" className="relative py-24 md:py-32">
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#0A0A0A] via-[#1A1A1A]/50 to-[#0A0A0A]" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="text-center mb-16 md:mb-20">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#FFD700]/10 border border-[#FFD700]/20 mb-6">
            <span className="text-sm text-[#FFD700] font-medium">6 步增长系统</span>
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white mb-6">
            科学增长，
            <span className="bg-gradient-to-r from-[#FFD700] to-[#FFA500] bg-clip-text text-transparent">
              步步为赢
            </span>
          </h2>
          <p className="text-lg text-[#B0B0B0] max-w-2xl mx-auto">
            经过验证的 6 步增长方法论，结合 AI 的强大能力，让每一步都事半功倍。
          </p>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 md:gap-8">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div
                key={feature.step}
                className="group relative rounded-2xl border border-[#333333] bg-[#1A1A1A]/80 p-6 transition-[transform,border-color,box-shadow] duration-300 hover:-translate-y-2 hover:border-[#FFD700]/50 hover:shadow-[0_0_28px_rgba(255,215,0,0.08)] md:p-8"
                style={{
                  animationDelay: `${index * 0.1}s`,
                }}
              >
                {/* Step Number */}
                <div className="absolute -top-3 -left-3 w-10 h-10 rounded-xl bg-gradient-to-br from-[#FFD700] to-[#FFA500] flex items-center justify-center text-[#0A0A0A] font-bold text-lg shadow-lg">
                  {feature.step}
                </div>

                {/* Icon */}
                <div
                  className="w-14 h-14 rounded-xl flex items-center justify-center mb-5 transition-transform group-hover:scale-110"
                  style={{ backgroundColor: `${feature.color}20` }}
                >
                  <Icon className="w-7 h-7" style={{ color: feature.color }} />
                </div>

                {/* Content */}
                <h3 className="text-xl font-bold text-white mb-3 group-hover:text-[#FFD700] transition-colors">
                  {feature.title}
                </h3>
                <p className="text-[#B0B0B0] leading-relaxed">
                  {feature.description}
                </p>

                {/* Arrow */}
                <div className="absolute bottom-6 right-6 opacity-0 group-hover:opacity-100 transition-opacity">
                  <ArrowRight className="w-5 h-5 text-[#FFD700]" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Connection Lines (Desktop Only) */}
        <div className="hidden lg:flex justify-center mt-12">
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center">
                <div className="w-8 h-8 rounded-full bg-[#FFD700]/20 border border-[#FFD700]/30 flex items-center justify-center text-[#FFD700] text-sm font-medium">
                  {i}
                </div>
                <div className="w-12 h-0.5 bg-gradient-to-r from-[#FFD700]/50 to-[#FFD700]/20" />
              </div>
            ))}
            <div className="w-8 h-8 rounded-full bg-[#FFD700]/20 border border-[#FFD700]/30 flex items-center justify-center text-[#FFD700] text-sm font-medium">
              6
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
