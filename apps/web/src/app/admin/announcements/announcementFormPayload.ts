export type AnnouncementAreaType = 'homepage' | 'banner';

export type BannerStyle =
  | 'info'
  | 'warning'
  | 'success'
  | 'error'
  | 'promo'
  | 'announcement';

interface AnnouncementPresentationInput {
  announcementType: AnnouncementAreaType;
  bannerStyle: BannerStyle;
  bannerLink: string;
}

interface AnnouncementPresentationPayload {
  bannerStyle?: BannerStyle;
  bannerLink?: string;
}

export const ANNOUNCEMENT_LINK_LABEL = '跳转链接（可选）';

export function buildAnnouncementPresentationPayload({
  announcementType,
  bannerStyle,
  bannerLink,
}: AnnouncementPresentationInput): AnnouncementPresentationPayload {
  const normalizedLink = bannerLink.trim();

  return {
    bannerStyle: announcementType === 'banner' ? bannerStyle : undefined,
    bannerLink: normalizedLink || undefined,
  };
}

export function getAnnouncementLinkFormValue(
  bannerLink: string | null | undefined,
): string {
  return bannerLink ?? '';
}
