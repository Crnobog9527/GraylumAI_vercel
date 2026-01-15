import {
  Video, PenTool, Sparkles, Briefcase, BarChart3, Lightbulb,
  Target, Image as ImageIcon, Languages, Code, Megaphone,
  BookOpen, Music, Bot, FileText, Palette, Rocket, Zap,
  Heart, Star, MessageSquare, Mail, Calendar, Clock,
  Camera, Mic, Radio, Tv, Film, Clapperboard,
  ShoppingBag, ShoppingCart, Store, CreditCard, DollarSign,
  TrendingUp, PieChart, LineChart, Activity, Hash,
  Globe, Send, Share2, Users, UserPlus, Award,
  Bookmark, Tag, Folder, Archive, Layers, Grid,
  Edit3, Type, AlignLeft, List, CheckSquare, Clipboard,
  Search, Filter, Settings, Sliders, Wrench,
  Coffee, Gift, Smile, ThumbsUp, Flame, Crown,
  LucideIcon
} from 'lucide-react';

// 图标映射
export const iconMap: Record<string, LucideIcon> = {
  Video, PenTool, Sparkles, Briefcase, BarChart3, Lightbulb,
  Target, Image: ImageIcon, Languages, Code, Megaphone,
  BookOpen, Music, Bot, FileText, Palette, Rocket, Zap,
  Heart, Star, MessageSquare, Mail, Calendar, Clock,
  Camera, Mic, Radio, Tv, Film, Clapperboard,
  ShoppingBag, ShoppingCart, Store, CreditCard, DollarSign,
  TrendingUp, PieChart, LineChart, Activity, Hash,
  Globe, Send, Share2, Users, UserPlus, Award,
  Bookmark, Tag, Folder, Archive, Layers, Grid,
  Edit3, Type, AlignLeft, List, CheckSquare, Clipboard,
  Search, Filter, Settings, Sliders, Wrench,
  Coffee, Gift, Smile, ThumbsUp, Flame, Crown
};

// 图标颜色配置
export const iconColorMap: Record<string, string> = {
  // 内容创作类 - 暖色调
  Zap: '#FFD700',
  Sparkles: '#F59E0B',
  PenTool: '#84CC16',
  Edit3: '#10B981',
  Type: '#14B8A6',
  AlignLeft: '#06B6D4',

  // 视频/媒体类 - 粉紫色调
  Video: '#F472B6',
  Camera: '#EC4899',
  Film: '#D946EF',
  Clapperboard: '#A855F7',
  Tv: '#8B5CF6',
  Radio: '#7C3AED',
  Mic: '#6366F1',

  // 营销/商业类 - 橙红色调
  Megaphone: '#F97316',
  Target: '#EF4444',
  TrendingUp: '#DC2626',
  Rocket: '#FB923C',
  Flame: '#FF6B6B',
  Crown: '#FBBF24',
  Award: '#F59E0B',

  // 数据/分析类 - 蓝色调
  BarChart3: '#3B82F6',
  PieChart: '#2563EB',
  LineChart: '#1D4ED8',
  Activity: '#0EA5E9',
  Hash: '#06B6D4',

  // 办公/商务类 - 绿色调
  Briefcase: '#22C55E',
  FileText: '#16A34A',
  Clipboard: '#15803D',
  Calendar: '#059669',
  Clock: '#0D9488',
  CheckSquare: '#14B8A6',
  List: '#2DD4BF',

  // 社交/沟通类
  MessageSquare: '#8B5CF6',
  Mail: '#6366F1',
  Send: '#3B82F6',
  Share2: '#0EA5E9',
  Globe: '#06B6D4',
  Users: '#14B8A6',
  UserPlus: '#10B981',

  // 电商/购物类
  ShoppingBag: '#FB7185',
  ShoppingCart: '#F472B6',
  Store: '#E879F9',
  CreditCard: '#C084FC',
  DollarSign: '#22C55E',

  // 创意/设计类
  Palette: '#F472B6',
  Image: '#A78BFA',
  Layers: '#818CF8',
  Grid: '#60A5FA',

  // 学习/知识类
  BookOpen: '#0EA5E9',
  Lightbulb: '#FBBF24',
  Search: '#6366F1',
  Filter: '#8B5CF6',

  // 工具类
  Settings: '#64748B',
  Sliders: '#475569',
  Wrench: '#78716C',

  // 其他
  Bot: '#8B5CF6',
  Code: '#22D3EE',
  Languages: '#34D399',
  Music: '#F472B6',
  Heart: '#EF4444',
  Star: '#FBBF24',
  Bookmark: '#F59E0B',
  Tag: '#84CC16',
  Folder: '#FB923C',
  Archive: '#78716C',
  Coffee: '#92400E',
  Gift: '#EC4899',
  Smile: '#FBBF24',
  ThumbsUp: '#22C55E',
};

// 获取图标颜色
export const getIconColor = (iconName: string): string => {
  return iconColorMap[iconName] || '#FFD700';
};

// 获取图标组件
export const getIconComponent = (iconName: string): LucideIcon => {
  return iconMap[iconName] || Bot;
};
