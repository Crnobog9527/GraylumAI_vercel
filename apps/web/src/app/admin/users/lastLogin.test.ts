import { describe, expect, it } from 'vitest';
import { formatLastLogin } from './lastLogin';

describe('formatLastLogin', () => {
  it('shows 未记录 when the API marks login fields as unrecorded', () => {
    expect(formatLastLogin({ last_login_at: null, login_record_status: 'unrecorded' })).toBe('未记录');
  });

  it('keeps the recorded timestamp and the never-logged-in wording for real data', () => {
    const at = '2026-09-29T00:00:00.000Z';
    expect(formatLastLogin({ last_login_at: at, login_record_status: 'unrecorded' }))
      .toBe(new Date(at).toLocaleString('zh-CN'));
    expect(formatLastLogin({ last_login_at: null })).toBe('从未登录');
  });
});
