/**
 * 全站横幅 Hook
 * 用于获取活跃的横幅公告数据
 */

import { trpc } from '@/trpc/client';

export function useBanner(options?: { enabled?: boolean }) {
  const { data: bannerData, isLoading } = trpc.settings.getBannerAnnouncement.useQuery(
    undefined,
    { enabled: options?.enabled ?? true }
  );

  // 转换为 GlobalBanner 组件需要的格式
  const banners = bannerData ? [{
    id: bannerData.id,
    title: bannerData.title,
    description: bannerData.description || '',
    tag: bannerData.tag || '限量优惠',
    banner_style: bannerData.banner_style || 'promo',
    banner_link: bannerData.link_url,
  }] : [];

  return {
    banners,
    isLoading,
    hasBanner: banners.length > 0,
  };
}
