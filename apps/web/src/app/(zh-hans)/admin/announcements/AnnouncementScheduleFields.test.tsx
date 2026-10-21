import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AnnouncementScheduleFields from './AnnouncementScheduleFields';
import { START_DATE_REQUIRED } from './announcementSchedule';

function render(startDate: string, startError: string | null) {
  return renderToStaticMarkup(createElement(AnnouncementScheduleFields, {
    value: { startDate, endDate: '' }, onChange: () => {}, startError,
  }));
}

describe('announcement schedule fields', () => {
  it('marks the start time as required', () => {
    expect(render('2026-10-01T09:30', null)).toMatch(/id="announcement-start"[^>]*required/);
  });

  it('shows the required hint next to a cleared start time', () => {
    const html = render('', START_DATE_REQUIRED);

    expect(html).toContain('role="alert"');
    expect(html).toContain(START_DATE_REQUIRED);
    expect(html).toContain('aria-describedby="announcement-start-error"');
  });

  it('hides the hint once a start time is entered again', () => {
    expect(render('2026-10-01T09:30', START_DATE_REQUIRED)).not.toContain(START_DATE_REQUIRED);
  });
});
