'use client';

import Link from 'next/link';
import { PlayCircle, Target, Search, Compass, FileText, Settings, TrendingUp } from 'lucide-react';

/**
 * 六步指南组件
 * 使用设计系统: card, card-clickable, btn-primary, btn-secondary, text-gradient
 */

const steps = [
  {
    num: '01',
    title: '账号定位分析',
    desc: '分析目标受众，确定账号定位和差异化策略',
    icon: Target
  },
  {
    num: '02',
    title: '竞品账号研究',
    desc: '分析同领域优秀账号的内容风格、发布频率、爆款特征，找到可借鉴的成功经验。',
    icon: Search
  },
  {
    num: '03',
    title: '账号定位分析',
    desc: '确定你的内容领域、目标受众和个人特色，明确"我是谁"、"为谁服务"、"提供什么价值"',
    icon: Compass
  },
  {
    num: '04',
    title: '制定内容策略',
    desc: '规划内容方向和选题库，确定内容形式，制定差异化路线。让你的内容既有持续性，又有独特记忆点。',
    icon: FileText
  },
  {
    num: '05',
    title: '日常运营建议',
    desc: '制定以商业为导向的运营策略，让每一步都朝着目标前进。',
    icon: Settings
  },
  {
    num: '06',
    title: '商业变现规划',
    desc: '提前规划账号未来的变现渠道和方式，避免努力白费。',
    icon: TrendingUp
  }
];

interface SixStepsGuideProps {
  onStartAnalysis?: () => void;
}

export default function SixStepsGuide({ onStartAnalysis }: SixStepsGuideProps) {
  const handleStartAnalysis = () => {
    if (onStartAnalysis) {
      onStartAnalysis();
    } else {
      // Default: navigate to chat
      window.location.href = '/chat';
    }
  };

  return (
    <div className="mb-16">
      {/* Header - 标题区域 */}
      <div className="text-center mb-12">
        {/* 微标签 */}
        <div
          className="badge badge-default inline-flex items-center gap-2 mb-6"
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-full)',
            padding: 'var(--space-sm) var(--space-md)'
          }}
        >
          <span
            className="uppercase tracking-widest font-medium"
            style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}
          >
            GROWTH STRATEGY
          </span>
        </div>

        {/* 主标题 */}
        <h2
          className="heading-1 mb-4"
          style={{
            fontSize: 'clamp(2rem, 5vw, 3rem)',
            lineHeight: '1.1'
          }}
        >
          从零到百万粉丝
          <br />
          <span className="text-gradient">6步打造爆款账号</span>
        </h2>

        {/* 副标题 */}
        <p
          className="mx-auto max-w-2xl"
          style={{
            color: 'var(--text-secondary)',
            fontSize: 'var(--text-body)',
            lineHeight: 'var(--leading-relaxed)'
          }}
        >
          深度学习全网超过1000万粉丝不同赛道账号的商业策略，只需 10 分钟，立即适配最佳赛道以及差异化内容！
        </p>
      </div>

      {/* Bento Grid - 步骤卡片网格 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-12">
        {steps.map((step, index) => {
          const IconComponent = step.icon;
          return (
            <div
              key={index}
              className="card card-clickable group p-8"
              style={{
                borderRadius: 'var(--radius-2xl)',
                contain: 'layout paint',
              }}
            >
              {/* 步骤编号和图标 */}
              <div className="flex items-center justify-between mb-6">
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-300"
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border-primary)',
                    color: 'var(--color-primary)'
                  }}
                >
                  {step.num}
                </div>
                <IconComponent
                  className="h-5 w-5 transition-colors duration-300"
                  style={{ color: 'var(--text-disabled)' }}
                />
              </div>

              {/* 卡片标题 */}
              <h3
                className="heading-4 mb-3"
                style={{ color: 'var(--text-primary)' }}
              >
                {step.title}
              </h3>

              {/* 卡片描述 */}
              <p
                style={{
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--text-small)',
                  lineHeight: 'var(--leading-relaxed)'
                }}
              >
                {step.desc}
              </p>
            </div>
          );
        })}
      </div>

      {/* CTA Buttons - 行动按钮 */}
      <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
        <button
          onClick={handleStartAnalysis}
          className="btn btn-primary btn-lg"
          style={{
            borderRadius: 'var(--radius-full)',
            boxShadow: 'var(--shadow-glow)',
            minWidth: '180px'
          }}
        >
          <PlayCircle className="h-5 w-5 mr-2" />
          开始分析
        </button>

        <Link href="/chat">
          <button
            className="btn btn-secondary btn-lg"
            style={{
              borderRadius: 'var(--radius-full)',
              minWidth: '180px'
            }}
          >
            自由对话
          </button>
        </Link>
      </div>
    </div>
  );
}
