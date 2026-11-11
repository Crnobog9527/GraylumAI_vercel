/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Types, labels and small helpers shared by the admin 功能模块 page, its hook and its views. Moved from page.tsx as is.
import type { ElementType } from 'react';
import { Code, Sparkles, BarChart3, Layers, MessageSquare, Video, BriefcaseBusiness, GraduationCap, Megaphone } from 'lucide-react';

export type ModuleCategory = 'writing' | 'marketing' | 'video' | 'business' | 'education' | 'coding' | 'analysis' | 'creative' | 'other';
export type Platform = 'all' | 'web' | 'mobile' | 'desktop' | 'api';
export type BadgeType = 'new' | 'hot' | 'recommend';

export interface FeatureModule {
  id: string;
  title: string;
  description: string | null;
  full_description: string | null;
  prompt_content: string | null;
  system_prompt: string | null;
  user_prompt_template: string | null;
  model_id: string | null;
  platform: Platform;
  features: string | string[] | null;
  examples: string | string[] | null;
  preparation_questions: string | string[] | null;
  icon: string | null;
  image_url: string | null;
  badge_type: BadgeType | null;
  badge_text: string | null;
  credits_display: string | null;
  category: ModuleCategory;
  is_featured: boolean;
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  skill_id: string | null;
}

export type ModuleForm = {
  title: string;
  description: string;
  fullDescription: string;
  content: string;
  systemPrompt: string;
  userPromptTemplate: string;
  modelId: string;
  platform: Platform;
  features: string;
  examples: string;
  userQuestions: string;
  icon: string;
  imageUrl: string;
  badgeType: BadgeType | 'none';
  badgeText: string;
  creditsDisplay: string;
  category: ModuleCategory;
  sortOrder: string;
  active: boolean;
  isFeatured: boolean;
};

export const platformConfig: Record<Platform, string> = {
  all: '全平台',
  web: '网页端',
  mobile: '移动端',
  desktop: '桌面端',
  api: 'API',
};

export const iconOptions = [
  'Wand2', 'Sparkles', 'MessageSquare', 'Code', 'BarChart3', 'Brain',
  'Lightbulb', 'Rocket', 'Target', 'Zap', 'Star', 'BookOpen',
  'PenTool', 'Camera', 'Film', 'Globe', 'Search', 'Settings', 'Users',
];

export const categoryConfig: Record<ModuleCategory, { label: string; color: string; icon: ElementType }> = {
  writing: { label: '内容创作', color: 'bg-sky-500/20 text-sky-300', icon: MessageSquare },
  marketing: { label: '营销文案', color: 'bg-fuchsia-500/20 text-fuchsia-300', icon: Megaphone },
  video: { label: '视频制作', color: 'bg-rose-500/20 text-rose-300', icon: Video },
  business: { label: '商务办公', color: 'bg-emerald-500/20 text-emerald-300', icon: BriefcaseBusiness },
  education: { label: '教育学习', color: 'bg-amber-500/20 text-amber-300', icon: GraduationCap },
  coding: { label: '编程开发', color: 'bg-cyan-500/20 text-cyan-300', icon: Code },
  analysis: { label: '分析洞察', color: 'bg-violet-500/20 text-violet-300', icon: BarChart3 },
  creative: { label: '创意策划', color: 'bg-pink-500/20 text-pink-300', icon: Sparkles },
  other: { label: '其他分类', color: 'bg-slate-500/20 text-slate-300', icon: Layers },
};

export const BATCH_NO_CHANGE = '__UNCHANGED__' as const;
export type BatchSentinel = typeof BATCH_NO_CHANGE;
export type BatchEditForm = {
  category: ModuleCategory | BatchSentinel;
  platform: Platform | BatchSentinel;
  modelId: string | BatchSentinel;
  icon: string | BatchSentinel;
  isFeatured: 'featured' | 'standard' | BatchSentinel;
};

export function createEmptyForm(): ModuleForm {
  return {
    title: '',
    description: '',
    fullDescription: '',
    content: '',
    systemPrompt: '',
    userPromptTemplate: '',
    modelId: '',
    platform: 'all',
    features: '',
    examples: '',
    userQuestions: '',
    icon: 'Wand2',
    imageUrl: '',
    badgeType: 'none',
    badgeText: '',
    creditsDisplay: '',
    category: 'other',
    sortOrder: '0',
    active: true,
    isFeatured: false,
  };
}

export function parseJsonArray(value: string | string[] | null): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function stringToArray(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}
