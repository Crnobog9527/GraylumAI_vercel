'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Menu, X, Sparkles } from 'lucide-react';
import { resolveSiteName } from '@/lib/site-config';

const NAV_LINKS = [
  { label: '功能', href: '/landing#features' },
  { label: '定价', href: '/landing#pricing' },
  { label: '关于', href: '/landing#about' },
] as const;

export default function LandingHeader({ siteName = resolveSiteName() }: { siteName?: string }) {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const isScrolledRef = useRef(false);

  useEffect(() => {
    let frameId = 0;

    const handleScroll = () => {
      if (frameId) {
        return;
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        const nextScrolled = window.scrollY > 20;
        if (nextScrolled !== isScrolledRef.current) {
          isScrolledRef.current = nextScrolled;
          setIsScrolled(nextScrolled);
        }
      });
    };

    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-colors duration-300 ${
        isScrolled
          ? 'border-b border-[#333333] bg-[#0A0A0A]/94 md:backdrop-blur-md'
          : 'bg-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link href="/landing" className="flex items-center gap-2 group">
            <div className="relative">
              <Sparkles className="h-8 w-8 text-[#FFD700] transition-transform group-hover:scale-110" />
              <div className="absolute inset-0 bg-[#FFD700] opacity-16 blur-[6px] transition-opacity group-hover:opacity-24 md:blur-sm" />
            </div>
            <span className="text-xl font-bold text-white">{siteName}</span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-8">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="text-[#B0B0B0] hover:text-white transition-colors text-sm font-medium"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Desktop CTA Buttons */}
          <div className="hidden md:flex items-center gap-4">
            <Link
              href="/login"
              className="text-[#B0B0B0] hover:text-white transition-colors text-sm font-medium"
            >
              登录
            </Link>
            <Link
              href="/login?action=signup"
              className="rounded-lg bg-gradient-to-r from-[#FFD700] to-[#FFA500] px-5 py-2.5 text-sm font-semibold text-[#0A0A0A] transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_0_10px_rgba(255,215,0,0.16)]"
            >
              免费开始
            </Link>
          </div>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="md:hidden p-2 text-white"
          >
            {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile Menu */}
        {isMobileMenuOpen && (
          <div className="md:hidden py-4 border-t border-[#333333]">
            <nav className="flex flex-col gap-4">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.label}
                  href={link.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="text-[#B0B0B0] hover:text-white transition-colors text-sm font-medium py-2"
                >
                  {link.label}
                </Link>
              ))}
              <div className="flex flex-col gap-3 pt-4 border-t border-[#333333]">
                <Link
                  href="/login"
                  className="text-center text-[#B0B0B0] hover:text-white transition-colors text-sm font-medium py-2"
                >
                  登录
                </Link>
                <Link
                  href="/login?action=signup"
                  className="text-center px-5 py-2.5 bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-[#0A0A0A] rounded-lg font-semibold text-sm"
                >
                  免费开始
                </Link>
              </div>
            </nav>
          </div>
        )}
      </div>
    </header>
  );
}
