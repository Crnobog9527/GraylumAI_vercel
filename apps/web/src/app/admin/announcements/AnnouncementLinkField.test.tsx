import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AnnouncementLinkField, { announcementSaveError } from './AnnouncementLinkField';
import { ANNOUNCEMENT_LINK_ERROR } from '../../../../../../packages/api/src/shared/announcementLink';

describe('announcement save errors', () => {
  it('shows the known Chinese reason from a server validation error', () => {
    const error = new Error(JSON.stringify([{ path: ['bannerLink'], message: ANNOUNCEMENT_LINK_ERROR }]));
    const html = renderToStaticMarkup(createElement(AnnouncementLinkField, {
      value: 'javascript:alert(1)', onChange: () => {}, error,
    }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(ANNOUNCEMENT_LINK_ERROR);
    expect(html).not.toContain('&quot;path&quot;');
  });

  it('hides internal failures behind a safe fallback', () => {
    expect(announcementSaveError(new Error('permission denied for relation announcements')))
      .toBe('公告保存失败，请稍后重试。');
    expect(announcementSaveError(null)).toBeNull();
  });
});
