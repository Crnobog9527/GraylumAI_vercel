/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NextResponse } from 'next/server';
import { ownerEditsSchema, ownerEditsTarget } from '@/lib/dev/owner-edits';

/**
 * Local only: the landing sample's edit mode (OwnerEditJ) saves the Owner's text changes here. It works only in a
 * development server started with OWNER_EDITS_FILE (the local preview's launch config sets it, outside the
 * repository); everywhere else — staging, production, any build — it answers 404 and touches nothing.
 * Each save is appended to that file as one JSON line.
 */
export async function POST(request: Request) {
  const file = ownerEditsTarget(process.env);
  if (!file) return new NextResponse(null, { status: 404 });
  const parsed = ownerEditsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ savedAt: new Date().toISOString(), ...parsed.data })}\n`, 'utf8');
  return NextResponse.json({ ok: true, saved: parsed.data.edits.length });
}
