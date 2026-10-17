/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Best-effort client address from proxy headers, for rate-limit buckets only (never an identity). */
export function getClientIp(headers: Headers) {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const firstIp = forwarded.split(',')[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }

  const cfConnectingIp = headers.get('cf-connecting-ip')?.trim();
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) {
    return realIp;
  }

  return null;
}
