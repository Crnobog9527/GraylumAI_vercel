/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, createHmac } from 'node:crypto';

/**
 * Alibaba Cloud OpenAPI signature V3 (ACS3-HMAC-SHA256) for an RPC-style call with every parameter in
 * the query string and an empty body.
 * https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
 */
const ALGORITHM = 'ACS3-HMAC-SHA256';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** RFC 3986: only A-Z a-z 0-9 - _ . ~ stay as they are. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params).sort()
    .map(key => `${percentEncode(key)}=${percentEncode(params[key] ?? '')}`)
    .join('&');
}

export type SignInput = {
  host: string;
  action: string;
  version: string;
  params: Record<string, string>;
  accessKeyId: string;
  accessKeySecret: string;
  /** 'yyyy-MM-ddTHH:mm:ssZ', UTC. */
  date: string;
  nonce: string;
};

/** The headers for a POST to https://<host>/?<canonical query>, Authorization included. */
export function signRequest(input: SignInput): { query: string; headers: Record<string, string> } {
  const query = canonicalQuery(input.params);
  const signed: Record<string, string> = {
    host: input.host,
    'x-acs-action': input.action,
    'x-acs-content-sha256': EMPTY_SHA256,
    'x-acs-date': input.date,
    'x-acs-signature-nonce': input.nonce,
    'x-acs-version': input.version,
  };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map(name => `${name}:${signed[name]?.trim()}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, EMPTY_SHA256].join('\n');
  const stringToSign = `${ALGORITHM}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const signature = createHmac('sha256', input.accessKeySecret).update(stringToSign).digest('hex');
  return {
    query,
    headers: {
      ...signed,
      Authorization: `${ALGORITHM} Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
    },
  };
}

/** 2026-11-07T10:22:32Z (no milliseconds). */
export function acsDate(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
