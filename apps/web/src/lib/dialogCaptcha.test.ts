import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HCaptchaClient, HCaptchaRenderOptions } from '@/lib/authCaptcha';
import {
  CAPTCHA_REQUIRED_MESSAGE,
  HCAPTCHA_LAYER_SELECTOR,
  captchaOptionsFromToken,
  guardCaptchaFocus,
  isCaptchaChallengeTarget,
  isHCaptchaSource,
  keepDialogOpenForCaptcha,
  loadHCaptcha,
  renderDialogCaptcha,
} from './dialogCaptcha';

function fakeClient() {
  let options: HCaptchaRenderOptions | undefined;
  const client = {
    getResponse: vi.fn(),
    reset: vi.fn(),
    render: vi.fn((_container: HTMLElement, next: HCaptchaRenderOptions) => {
      options = next;
      return 7;
    }),
    remove: vi.fn(),
  } satisfies HCaptchaClient;
  return { client, options: () => options! };
}

type FakeScript = {
  id: string; src: string; async: boolean;
  listeners: Record<string, Array<() => void>>;
  addEventListener: (event: string, handler: () => void) => void;
  remove: () => void;
};

function fakeDocument() {
  const byId = new Map<string, FakeScript>();
  const scripts: FakeScript[] = [];
  const createElement = vi.fn(() => {
    const script: FakeScript = {
      id: '', src: '', async: false, listeners: {},
      addEventListener(event, handler) { (this.listeners[event] ??= []).push(handler); },
      remove() { if (byId.get(this.id) === this) byId.delete(this.id); },
    };
    scripts.push(script);
    return script;
  });
  const doc = {
    getElementById: vi.fn((id: string) => byId.get(id) ?? null),
    createElement,
    head: { appendChild: vi.fn((script: FakeScript) => { byId.set(script.id, script); }) },
  };
  const latest = () => scripts[scripts.length - 1];
  return {
    doc: doc as unknown as Document,
    get script() { return latest(); },
    fire: (event: string) => latest().listeners[event]?.forEach((handler) => handler()),
    attached: () => byId.size,
  };
}

describe('captchaOptionsFromToken', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('needs no token when CAPTCHA is not configured', () => {
    expect(captchaOptionsFromToken(null, '')).toEqual({});
  });

  it('fails closed without a token and passes a fresh token through', () => {
    expect(() => captchaOptionsFromToken(null, 'site-key')).toThrow(CAPTCHA_REQUIRED_MESSAGE);
    expect(captchaOptionsFromToken('token-1', 'site-key')).toEqual({ captchaToken: 'token-1' });
  });
});

describe('renderDialogCaptcha', () => {
  it('renders into the given container and reports token, expiry and errors', () => {
    const { client, options } = fakeClient();
    const onToken = vi.fn();
    const onExpired = vi.fn();
    const container = {} as HTMLElement;
    const remove = renderDialogCaptcha(client, container, 'site-key', { onToken, onExpired });

    expect(client.render).toHaveBeenCalledWith(container, expect.objectContaining({ sitekey: 'site-key' }));
    options().callback?.('token-1');
    expect(onToken).toHaveBeenLastCalledWith('token-1');
    options()['expired-callback']?.();
    expect(onToken).toHaveBeenLastCalledWith(null);
    expect(onExpired).toHaveBeenCalledTimes(1);
    options()['error-callback']?.();
    expect(onToken).toHaveBeenLastCalledWith(null);

    remove();
    expect(client.remove).toHaveBeenCalledWith(7);
  });

  it('refuses a client without explicit rendering', () => {
    const client = { getResponse: vi.fn(), reset: vi.fn() };
    expect(() => renderDialogCaptcha(client, {} as HTMLElement, 'k', { onToken: vi.fn(), onExpired: vi.fn() }))
      .toThrow('explicit rendering');
  });
});

describe('loadHCaptcha', () => {
  it('reuses an already loaded client', async () => {
    const { client } = fakeClient();
    const { doc } = fakeDocument();
    await expect(loadHCaptcha({ doc, win: { hcaptcha: client } as unknown as Window })).resolves.toBe(client);
    expect(doc.createElement).not.toHaveBeenCalled();
  });

  it('loads the explicit-render script once and resolves when it is ready', async () => {
    const { client } = fakeClient();
    const fake = fakeDocument();
    const win = {} as Window;
    const first = loadHCaptcha({ doc: fake.doc, win });
    const second = loadHCaptcha({ doc: fake.doc, win });
    expect(fake.doc.createElement).toHaveBeenCalledTimes(1);
    expect(fake.script.src).toBe('https://js.hcaptcha.com/1/api.js?render=explicit');
    (win as { hcaptcha?: HCaptchaClient }).hcaptcha = client;
    fake.fire('load');
    await expect(first).resolves.toBe(client);
    await expect(second).resolves.toBe(client);
  });

  it('rejects when the script fails to load and loads afresh on the next call', async () => {
    const fake = fakeDocument();
    const win = {} as Window;
    const first = loadHCaptcha({ doc: fake.doc, win });
    fake.fire('error');
    await expect(first).rejects.toThrow('hCaptcha unavailable');
    expect(fake.attached()).toBe(0);

    const { client } = fakeClient();
    const second = loadHCaptcha({ doc: fake.doc, win });
    expect(fake.doc.createElement).toHaveBeenCalledTimes(2);
    (win as { hcaptcha?: HCaptchaClient }).hcaptcha = client;
    fake.fire('load');
    await expect(second).resolves.toBe(client);
  });

  it('settles every caller of a failed load and removes a script that loads without a client', async () => {
    const fake = fakeDocument();
    const win = {} as Window;
    const a = loadHCaptcha({ doc: fake.doc, win });
    const b = loadHCaptcha({ doc: fake.doc, win });
    fake.fire('load');
    await expect(a).rejects.toThrow('hCaptcha unavailable');
    await expect(b).rejects.toThrow('hCaptcha unavailable');
    expect(fake.attached()).toBe(0);
  });
});

// Minimal element tree (no DOM library in this workspace): tag, attributes, children.
type FakeEl = {
  tagName: string; parentElement: FakeEl | null; ownerDocument: { body: FakeEl | null };
  attrs: Record<string, string>; children: FakeEl[];
  getAttribute: (name: string) => string | null;
  querySelector: (selector: string) => FakeEl | null;
  querySelectorAll: (selector: string) => FakeEl[];
};
function el(tag: string, attrs: Record<string, string> = {}, children: FakeEl[] = []): FakeEl {
  const node: FakeEl = {
    tagName: tag.toUpperCase(), parentElement: null, ownerDocument: { body: null }, attrs, children,
    getAttribute: name => attrs[name] ?? null,
    querySelector: selector => node.querySelectorAll(selector)[0] ?? null,
    querySelectorAll: selector => {
      const all: FakeEl[] = [];
      const walk = (n: FakeEl) => n.children.forEach(child => { all.push(child); walk(child); });
      walk(node);
      if (selector === 'iframe') return all.filter(n => n.tagName === 'IFRAME');
      if (selector === '[role="dialog"]') return all.filter(n => n.attrs.role === 'dialog');
      throw new Error(`unsupported selector ${selector}`);
    },
  };
  children.forEach(child => { child.parentElement = node; });
  return node;
}
function page() {
  const challengeBackdrop = el('div');
  const challengeFrame = el('iframe', { src: 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge' });
  const challenge = el('div', {}, [challengeBackdrop, el('div', {}, [challengeFrame])]);
  const checkboxFrame = el('iframe', { src: 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox' });
  const overlay = el('div', { 'data-state': 'open' });
  const dialog = el('div', { role: 'dialog' }, [el('div', { 'data-dialog-captcha': '' }, [checkboxFrame])]);
  const portal = el('div', {}, [overlay, dialog]);
  const other = el('button');
  const app = el('main', {}, [other, el('iframe', { src: 'https://www.youtube.com/embed/x' })]);
  const body = el('body', {}, [app, portal, challenge]);
  const all = [body, app, other, portal, overlay, dialog, checkboxFrame, challenge, challengeBackdrop, challengeFrame];
  const walk = (n: FakeEl) => { n.ownerDocument = { body }; n.children.forEach(walk); };
  walk(body);
  return { all, challengeBackdrop, challengeFrame, checkboxFrame, overlay, other, app };
}

describe('keeping a dialog open for the hCaptcha challenge', () => {
  it('recognises hCaptcha frames by host only', () => {
    expect(isHCaptchaSource('https://newassets.hcaptcha.com/captcha/v1/x.html')).toBe(true);
    expect(isHCaptchaSource('https://hcaptcha.com/1/api.js')).toBe(true);
    expect(isHCaptchaSource('https://hcaptcha.com.evil.example/x')).toBe(false);
    expect(isHCaptchaSource('https://evil.example/?u=hcaptcha.com')).toBe(false);
    expect(isHCaptchaSource(null)).toBe(false);
  });

  it('keeps the dialog open for pointer or focus events inside the challenge', () => {
    const { challengeBackdrop, challengeFrame } = page();
    expect(isCaptchaChallengeTarget(challengeBackdrop as unknown as EventTarget)).toBe(true);
    expect(isCaptchaChallengeTarget(challengeFrame as unknown as EventTarget)).toBe(true);
    const preventDefault = vi.fn();
    keepDialogOpenForCaptcha({ target: challengeFrame as unknown as EventTarget, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('still closes on the overlay, elsewhere on the page, and for non-element targets', () => {
    const { overlay, other, app } = page();
    for (const target of [overlay, other, app]) {
      const preventDefault = vi.fn();
      keepDialogOpenForCaptcha({ target: target as unknown as EventTarget, preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(isCaptchaChallengeTarget(null)).toBe(false);
    expect(isCaptchaChallengeTarget({} as EventTarget)).toBe(false);
  });

  it('does not treat the checkbox frame inside the dialog as the outside challenge', () => {
    const { checkboxFrame } = page();
    expect(isCaptchaChallengeTarget(checkboxFrame as unknown as EventTarget)).toBe(false);
  });
});

describe('hCaptcha layer stays clickable under a modal dialog', () => {
  it('globals.css applies exactly HCAPTCHA_LAYER_SELECTOR with pointer-events: auto', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../app/globals.css'), 'utf8');
    const rule = css.slice(css.indexOf(HCAPTCHA_LAYER_SELECTOR));
    expect(css.includes(HCAPTCHA_LAYER_SELECTOR)).toBe(true);
    expect(rule.slice(HCAPTCHA_LAYER_SELECTOR.length, rule.indexOf('}')).replace(/\s+/g, ' ').trim())
      .toBe('{ pointer-events: auto;');
    expect(css.split('hcaptcha.com').length - 1).toBe(1); // no other rule touches the hCaptcha layer
  });

  it('targets top-level body children holding an hCaptcha frame, never the dialog itself', () => {
    expect(HCAPTCHA_LAYER_SELECTOR.startsWith('body > ')).toBe(true);
    expect(HCAPTCHA_LAYER_SELECTOR).toContain(':has(iframe[src*="hcaptcha.com"])');
    expect(HCAPTCHA_LAYER_SELECTOR).toContain(':not([role="dialog"])');
    expect(HCAPTCHA_LAYER_SELECTOR).toContain(':not(:has([role="dialog"]))');
    expect(HCAPTCHA_LAYER_SELECTOR).not.toMatch(/#/);
  });
});

describe('focus stays in the hCaptcha challenge under the dialog focus trap', () => {
  function fakeWindow() {
    const listeners: Array<{ type: string; handler: (event: Event) => void; capture: unknown }> = [];
    return {
      listeners,
      addEventListener: vi.fn((type: string, handler: (event: Event) => void, capture?: unknown) => {
        listeners.push({ type, handler, capture });
      }),
      removeEventListener: vi.fn((type: string, handler: (event: Event) => void, capture?: unknown) => {
        const i = listeners.findIndex(l => l.type === type && l.handler === handler && l.capture === capture);
        if (i >= 0) listeners.splice(i, 1);
      }),
    };
  }
  const fire = (win: ReturnType<typeof fakeWindow>, type: string, init: { target?: unknown; relatedTarget?: unknown }) => {
    const event = { type, target: init.target ?? null, relatedTarget: init.relatedTarget ?? null,
      stopImmediatePropagation: vi.fn() };
    win.listeners.filter(l => l.type === type).forEach(l => l.handler(event as unknown as Event));
    return event.stopImmediatePropagation;
  };

  it('listens on window in the capture phase and stops only challenge focus moves', () => {
    const { challengeFrame, checkboxFrame, overlay, other } = page();
    const win = fakeWindow();
    guardCaptchaFocus(win as unknown as Window);
    expect(win.listeners.map(l => [l.type, l.capture])).toEqual([['focusin', true], ['focusout', true]]);

    expect(fire(win, 'focusin', { target: challengeFrame })).toHaveBeenCalledTimes(1);
    expect(fire(win, 'focusout', { target: other, relatedTarget: challengeFrame })).toHaveBeenCalledTimes(1);

    for (const target of [other, overlay, checkboxFrame, null]) {
      expect(fire(win, 'focusin', { target })).not.toHaveBeenCalled();
    }
    // focusout decides by where focus goes next (relatedTarget), never by the element left.
    for (const relatedTarget of [null, checkboxFrame, other, overlay]) {
      expect(fire(win, 'focusout', { target: challengeFrame, relatedTarget })).not.toHaveBeenCalled();
    }
  });

  it('removes both listeners when the widget unmounts', () => {
    const { challengeFrame } = page();
    const win = fakeWindow();
    const release = guardCaptchaFocus(win as unknown as Window);
    release();
    expect(win.listeners).toEqual([]);
    expect(fire(win, 'focusin', { target: challengeFrame })).not.toHaveBeenCalled();
  });

  it('matches the pinned Radix focus trap: document listeners in the bubble phase', () => {
    // Re-verify guardCaptchaFocus whenever this fails after a Radix upgrade.
    const dialogEntry = createRequire(import.meta.url).resolve('@radix-ui/react-dialog');
    const requireFromDialog = createRequire(dialogEntry);
    const scopeEntry = requireFromDialog.resolve('@radix-ui/react-focus-scope');
    const scopePackage = JSON.parse(readFileSync(resolve(dirname(dirname(scopeEntry)), 'package.json'), 'utf8'));
    expect(scopePackage.version).toBe('1.1.7');
    const source = readFileSync(scopeEntry.replace(/index\.js$/, 'index.mjs'), 'utf8');
    expect(source).toMatch(/document\.addEventListener\("focusin", handleFocusIn2?\);/);
    expect(source).toMatch(/document\.addEventListener\("focusout", handleFocusOut2?\);/);
  });
});
