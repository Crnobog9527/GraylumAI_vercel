export type BannerStyle =
  | 'info'
  | 'warning'
  | 'success'
  | 'error'
  | 'promo'
  | 'announcement';

interface AnnouncementPresentationInput {
  bannerStyle: BannerStyle;
  bannerLink: string;
}

interface AnnouncementPresentationPayload {
  bannerStyle: BannerStyle;
  bannerLink: string | null;
}

export const ANNOUNCEMENT_LINK_LABEL = '跳转链接（可选）';

export function buildAnnouncementPresentationPayload({
  bannerStyle,
  bannerLink,
}: AnnouncementPresentationInput): AnnouncementPresentationPayload {
  const normalizedLink = bannerLink.trim();

  return {
    bannerStyle,
    bannerLink: normalizedLink || null,
  };
}

export function getAnnouncementLinkFormValue(
  bannerLink: string | null | undefined,
): string {
  return bannerLink ?? '';
}
