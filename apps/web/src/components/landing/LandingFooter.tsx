import Link from 'next/link';
import { Mail } from 'lucide-react';
import { buildAuthHref, resolveSiteName, resolveSupportEmail } from '@/lib/site-config';

const footerLinks = {
  product: {
    title: '产品',
    links: [
      { label: '功能介绍', href: '/landing#features' },
      { label: '定价方案', href: '/landing#pricing' },
    ],
  },
  company: {
    title: '公司',
    links: [
      { label: '关于我们', href: '/landing#about' },
      { label: '联系我们', href: '/contact' },
    ],
  },
  support: {
    title: '支持',
    links: [
      { label: '使用教程', href: '/tutorials' },
      { label: '常见问题', href: '/faq' },
    ],
  },
  legal: {
    title: '法律',
    links: [
      { label: '服务条款', href: '/terms' },
      { label: '隐私政策', href: '/privacy' },
      { label: '使用协议', href: '/acceptable-use' },
    ],
  },
};

export default function LandingFooter({
  siteName = resolveSiteName(),
  supportEmail = resolveSupportEmail(),
}: {
  siteName?: string;
  supportEmail?: string;
}) {
  return (
    <footer id="about" className="relative bg-[#0A0A0A] border-t border-[#333333]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Main Footer */}
        <div className="grid grid-cols-1 gap-10 py-16 md:grid-cols-2 xl:grid-cols-[1.4fr,1fr,1fr,1fr,1fr]">
          {/* Brand Column */}
          <div>
            <Link href="/landing" className="mb-4 flex items-center gap-2">
              <div className="relative">
                <img
                  src="/graylum-logo.svg"
                  alt=""
                  aria-hidden="true"
                  className="h-8 w-8 rounded-[10px]"
                />
                <div className="absolute inset-0 bg-[#FFD700] opacity-18 blur-[8px]" />
              </div>
              <span className="text-xl font-bold text-white">{siteName}</span>
            </Link>
            <p className="mb-6 max-w-xs text-sm text-[#808080]">
              AI 驱动的社媒增长专家，帮助创作者和品牌实现指数级增长。
            </p>
            <div className="flex items-center gap-4">
              <a
                href={`mailto:${supportEmail}`}
                className="flex items-center gap-2 text-sm text-[#B0B0B0] hover:text-[#FFD700] transition-colors"
              >
                <Mail className="w-4 h-4" />
                <span>{supportEmail}</span>
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
                    <Link
                      href={link.href}
                      className="text-sm text-[#808080] hover:text-[#FFD700] transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom Bar */}
        <div className="py-6 border-t border-[#333333] flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-[#808080]">
            &copy; {new Date().getFullYear()} {siteName}. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            <Link
              href={buildAuthHref('/login')}
              className="text-sm text-[#B0B0B0] hover:text-[#FFD700] transition-colors"
            >
              登录
            </Link>
            <Link
              href={buildAuthHref('/login?action=signup')}
              className="text-sm px-4 py-2 bg-[#FFD700]/10 text-[#FFD700] rounded-lg hover:bg-[#FFD700]/20 transition-colors"
            >
              免费注册
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
