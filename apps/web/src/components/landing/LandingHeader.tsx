'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Menu, X, Sparkles } from 'lucide-react';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.graylum.com';

export default function LandingHeader() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navLinks = [
    { label: '功能', href: '#features' },
    { label: '定价', href: '#pricing' },
    { label: '关于', href: '#about' },
  ];

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        isScrolled
          ? 'bg-[#0A0A0A]/90 backdrop-blur-lg border-b border-[#333333]'
          : 'bg-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 group">
            <div className="relative">
              <Sparkles className="w-8 h-8 text-[#FFD700] transition-transform group-hover:scale-110" />
              <div className="absolute inset-0 bg-[#FFD700] blur-lg opacity-30 group-hover:opacity-50 transition-opacity" />
            </div>
            <span className="text-xl font-bold text-white">
              Graylum<span className="text-[#FFD700]">AI</span>
            </span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-[#B0B0B0] hover:text-white transition-colors text-sm font-medium"
              >
                {link.label}
              </a>
            ))}
          </nav>

          {/* Desktop CTA Buttons */}
          <div className="hidden md:flex items-center gap-4">
            <a
              href={`${APP_URL}/login`}
              className="text-[#B0B0B0] hover:text-white transition-colors text-sm font-medium"
            >
              登录
            </a>
            <a
              href={`${APP_URL}/login?action=signup`}
              className="px-5 py-2.5 bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-[#0A0A0A] rounded-lg font-semibold text-sm hover:shadow-[0_0_20px_rgba(255,215,0,0.3)] transition-all hover:-translate-y-0.5"
            >
              免费开始
            </a>
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
              {navLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="text-[#B0B0B0] hover:text-white transition-colors text-sm font-medium py-2"
                >
                  {link.label}
                </a>
              ))}
              <div className="flex flex-col gap-3 pt-4 border-t border-[#333333]">
                <a
                  href={`${APP_URL}/login`}
                  className="text-center text-[#B0B0B0] hover:text-white transition-colors text-sm font-medium py-2"
                >
                  登录
                </a>
                <a
                  href={`${APP_URL}/login?action=signup`}
                  className="text-center px-5 py-2.5 bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-[#0A0A0A] rounded-lg font-semibold text-sm"
                >
                  免费开始
                </a>
              </div>
            </nav>
          </div>
        )}
      </div>
    </header>
  );
}
