/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { GoogleDriveConfig } from '@/lib/library-sandbox/feature-flag';
import { DRIVE_PICKER_MIME_TYPES, type PickedFile } from './download';

/*
 * VOICE-2 PR-7: Google's own file picker with a drive.file token (Google Identity Services). The user picks files one by one; the
 * token reads only those files, lives only in this page's memory and is never sent to Graylum. Scripts load only when the button is
 * pressed. The site's CSP must allow apis.google.com, accounts.google.com and docs.google.com before this works (Owner's call).
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
type Methods = Record<string, (...args: unknown[]) => unknown>;
type TokenClient = { requestAccessToken(options?: Record<string, unknown>): void };
type Google = { accounts: { oauth2: { initTokenClient(config: Record<string, unknown>): TokenClient } };
  picker: Record<string, unknown> & { PickerBuilder: new () => Methods; DocsView: new (view?: unknown) => Methods;
    ViewId: Record<string, unknown>; Feature: Record<string, unknown>; Action: Record<string, string>; Response: Record<string, string>;
    Document: Record<string, string> } };
type Gapi = { load(name: string, callback: () => void): void };
const win = () => window as unknown as { google?: Google; gapi?: Gapi };

const loaded = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  if (!loaded.has(src)) loaded.set(src, new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.async = true; script.onload = () => resolve(); script.onerror = () => { loaded.delete(src); reject(new Error('DRIVE_SCRIPT')); };
    document.head.appendChild(script);
  }));
  return loaded.get(src)!;
}

/** A drive.file token for this page, asked of the user in Google's own window. */
export async function requestDriveToken(config: GoogleDriveConfig): Promise<string> {
  await loadScript('https://accounts.google.com/gsi/client');
  return new Promise((resolve, reject) => {
    const client = win().google!.accounts.oauth2.initTokenClient({ client_id: config.clientId, scope: DRIVE_SCOPE,
      callback: (answer: { access_token?: string; error?: string }) => answer.access_token ? resolve(answer.access_token) : reject(new Error('DRIVE_DENIED')),
      error_callback: () => reject(new Error('DRIVE_DENIED')) });
    client.requestAccessToken({ prompt: '' });
  });
}

/** The files the user picked (none when the picker was closed). */
export async function pickDriveFiles(config: GoogleDriveConfig, token: string): Promise<PickedFile[]> {
  await loadScript('https://apis.google.com/js/api.js');
  await new Promise<void>(resolve => win().gapi!.load('picker', resolve));
  const picker = win().google!.picker;
  return new Promise(resolve => {
    const view = new picker.DocsView(picker.ViewId.DOCS);
    view.setMimeTypes!(DRIVE_PICKER_MIME_TYPES);
    const built = new picker.PickerBuilder();
    built.addView!(view); built.enableFeature!(picker.Feature.MULTISELECT_ENABLED);
    built.setOAuthToken!(token); built.setDeveloperKey!(config.apiKey); built.setAppId!(config.appId);
    built.setCallback!((data: Record<string, unknown>) => {
      const action = data[picker.Response.ACTION];
      if (action === picker.Action.CANCEL) resolve([]);
      if (action !== picker.Action.PICKED) return;
      const docs = (data[picker.Response.DOCUMENTS] as Array<Record<string, unknown>> | undefined) ?? [];
      resolve(docs.map(doc => ({ id: String(doc[picker.Document.ID]), name: String(doc[picker.Document.NAME] ?? '未命名'),
        mimeType: String(doc[picker.Document.MIME_TYPE] ?? ''), ...(typeof doc.sizeBytes === 'number' ? { sizeBytes: doc.sizeBytes } : {}) })));
    });
    (built.build!() as { setVisible(visible: boolean): void }).setVisible(true);
  });
}
