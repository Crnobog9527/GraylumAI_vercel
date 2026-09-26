/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect} from 'vitest';
import {stagingRuntimeWindow} from './stagingEnvironment';
const env={V3_RUNTIME_STAGING_ENABLED:'true',VERCEL:'1',VERCEL_PROJECT_PRODUCTION_URL:'graylumai-staging.vercel.app',VERCEL_GIT_COMMIT_REF:'staging',VERCEL_GIT_REPO_OWNER:'Crnobog9527',VERCEL_GIT_REPO_SLUG:'GraylumAI_vercel',V3_RUNTIME_STAGING_PROJECT_ID:'synthetic-staging-project',VERCEL_PROJECT_ID:'synthetic-staging-project',NEXT_PUBLIC_SUPABASE_URL:'https://synthetic.supabase.co',V3_RUNTIME_STAGING_DATABASE_HOST:'synthetic.supabase.co',V3_RUNTIME_STAGING_WINDOW_ID:'00000000-0000-4000-8000-000000000001'};
it('requires explicit server configuration and accepts the separate staging project',()=>{
 expect(()=>stagingRuntimeWindow({})).toThrow();expect(stagingRuntimeWindow({...env,VERCEL_ENV:'production'})).toBe(env.V3_RUNTIME_STAGING_WINDOW_ID);
});
it.each(Object.keys(env))('fails closed with missing %s',key=>expect(()=>stagingRuntimeWindow({...env,[key]:undefined})).toThrow());
it.each([
 {VERCEL_GIT_COMMIT_REF:'main'},{VERCEL_PROJECT_PRODUCTION_URL:'graylumai.com'},
 {VERCEL_PROJECT_ID:'production-project'},{V3_RUNTIME_STAGING_ENABLED:'false'},
 {NEXT_PUBLIC_SUPABASE_URL:'https://production.supabase.co'},
 {NEXT_PUBLIC_SUPABASE_URL:'https://synthetic.supabase.co.evil.invalid'},
 {NEXT_PUBLIC_SUPABASE_URL:'https://user:secret@synthetic.supabase.co'},
 {NEXT_PUBLIC_SUPABASE_URL:'https://synthetic.supabase.co/path'},
 {NEXT_PUBLIC_SUPABASE_URL:'http://synthetic.supabase.co'},
])('rejects production or mismatched configuration %#',patch=>expect(()=>stagingRuntimeWindow({...env,...patch})).toThrow());

it('allows original-call maintenance after disablement, but never across targets',()=>{
 expect(stagingRuntimeWindow({...env,V3_RUNTIME_STAGING_ENABLED:'false'},true)).toBe(env.V3_RUNTIME_STAGING_WINDOW_ID);
 expect(()=>stagingRuntimeWindow({...env,VERCEL_GIT_COMMIT_REF:'main'},true)).toThrow();
 expect(()=>stagingRuntimeWindow({...env,VERCEL_PROJECT_ID:'production'},true)).toThrow();
 expect(()=>stagingRuntimeWindow({...env,NEXT_PUBLIC_SUPABASE_URL:'https://production.supabase.co'},true)).toThrow();
});
