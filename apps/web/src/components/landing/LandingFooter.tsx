'use client';

import Link from 'next/link';
import { Sparkles, Mail, MessageCircle } from 'lucide-react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.graylum.com';

const footerLinks = {
  product: {
    title: '产品',
    links: [
      { label: '功能介绍', href: '#features' },
      { label: '定价方案', href: '#pricing' },
      { label: '更新日志', href: '#' },
      { label: 'API 文档', href: '#' },
    ],
  },
  company: {
    title: '公司',
    links: [
      { label: '关于我们', href: '#about' },
      { label: '博客', href: '#' },
      { label: '加入我们', href: '#' },
      { label: '联系我们', href: '#' },
    ],
  },
  support: {
    title: '支持',
    links: [
      { label: '帮助中心', href: '#' },
      { label: '使用教程', href: '#' },
      { label: '常见问题', href: '#' },
      { label: '社区', href: '#' },
    ],
  },
  legal: {
    title: '法律',
    links: [
      { label: '服务条款', href: '#' },
      { label: '隐私政策', href: '#' },
      { label: '使用协议', href: '#' },
    ],
  },
};

export default function LandingFooter() {
  return (
    <footer id="about" className="relative bg-[#0A0A0A] border-t border-[#333333]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Main Footer */}
        <div className="py-16 grid grid-cols-2 md:grid-cols-6 gap-8">
          {/* Brand Column */}
          <div className="col-span-2">
            <Link href="/" className="flex items-center gap-2 mb-4">
              <div className="relative">
                <Sparkles className="w-8 h-8 text-[#FFD700]" />
                <div className="absolute inset-0 bg-[#FFD700] blur-lg opacity-30" />
              </div>
              <span className="text-xl font-bold text-white">
                Graylum<span className="text-[#FFD700]">AI</span>
              </span>
            </Link>
            <p className="text-sm text-[#808080] mb-6 max-w-xs">
              AI 驱动的社媒增长专家，帮助创作者和品牌实现指数级增长。
            </p>
            <div className="flex items-center gap-4">
              <a
                href="mailto:support@graylum.com"
                className="flex items-center gap-2 text-sm text-[#B0B0B0] hover:text-[#FFD700] transition-colors"
              >
                <Mail className="w-4 h-4" />
                <span>support@graylum.com</span>
              </a>
            </div>
          </div>

          {/* Link Columns */}
          {Object.entries(footerLinks).map(([key, section]) => (
            <div key={key}>
              <h4 className="text-sm font-semibold text-white mb-4">{section.title}</h4>
              <ul className="space-y-3">
                {section.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-sm text-[#808080] hover:text-[#FFD700] transition-colors"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom Bar */}
        <div className="py-6 border-t border-[#333333] flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-[#808080]">
            &copy; {new Date().getFullYear()} GraylumAI. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            <a
              href={`${APP_URL}/login`}
              className="text-sm text-[#B0B0B0] hover:text-[#FFD700] transition-colors"
            >
              登录
            </a>
            <a
              href={`${APP_URL}/login?action=signup`}
              className="text-sm px-4 py-2 bg-[#FFD700]/10 text-[#FFD700] rounded-lg hover:bg-[#FFD700]/20 transition-colors"
            >
              免费注册
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
