import { describe, expect, it } from 'vitest';

import {
  ANNOUNCEMENT_LINK_LABEL,
  buildAnnouncementPresentationPayload,
  getAnnouncementLinkFormValue,
} from './announcementFormPayload';

describe('admin announcement presentation payload', () => {
  it('submits a non-empty homepage link without banner styling', () => {
    expect(
      buildAnnouncementPresentationPayload({
        announcementType: 'homepage',
        bannerStyle: 'promo',
        bannerLink: '  https://example.com/homepage  ',
      }),
    ).toEqual({
      bannerStyle: undefined,
      bannerLink: 'https://example.com/homepage',
    });
    expect(ANNOUNCEMENT_LINK_LABEL).toBe('跳转链接（可选）');
  });

  it('preserves the existing banner link and style behavior', () => {
    expect(
      buildAnnouncementPresentationPayload({
        announcementType: 'banner',
        bannerStyle: 'warning',
        bannerLink: 'https://example.com/banner',
      }),
    ).toEqual({
      bannerStyle: 'warning',
      bannerLink: 'https://example.com/banner',
    });
  });

  it('submits a blank homepage link as undefined', () => {
    expect(
      buildAnnouncementPresentationPayload({
        announcementType: 'homepage',
        bannerStyle: 'info',
        bannerLink: '   ',
      }),
    ).toEqual({
      bannerStyle: undefined,
      bannerLink: undefined,
    });
  });

  it('keeps an existing homepage link when editing and saving', () => {
    const bannerLink = getAnnouncementLinkFormValue(
      'https://example.com/existing-homepage',
    );

    expect(
      buildAnnouncementPresentationPayload({
        announcementType: 'homepage',
        bannerStyle: 'info',
        bannerLink,
      }),
    ).toEqual({
      bannerStyle: undefined,
      bannerLink: 'https://example.com/existing-homepage',
    });
  });
});
