/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
it('keeps the stopped receipt waiting window aligned with the deployed HTTP lifetime',()=>{
 const route=readFileSync(new URL('../../../../../apps/web/src/app/api/trpc/[trpc]/route.ts',import.meta.url),'utf8');
 const migration=readFileSync(new URL('../../../../db/migrations/0171_runtime_native_stop.sql',import.meta.url),'utf8');
 const duration=Number(route.match(/export const maxDuration = (\d+)/)?.[1]);
 const window=Number(migration.match(/'responsePending',[\s\S]*?interval '(\d+) seconds'/)?.[1]);
 expect(duration).toBeGreaterThan(0);expect(window).toBe(duration);
});
