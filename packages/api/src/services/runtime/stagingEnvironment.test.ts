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

it.each(['graylumai-staging.vercel.app','auth-staging.graylum.com'])('accepts the exact staging production domain %s',url=>
 expect(stagingRuntimeWindow({...env,VERCEL_PROJECT_PRODUCTION_URL:url})).toBe(env.V3_RUNTIME_STAGING_WINDOW_ID));
it.each([
 'app.graylum.com','graylum.com','www.graylum.com','staging.graylum.com','graylumai-staging-abc123-team.vercel.app',
 'auth-staging.graylum.com.evil.invalid','evil-auth-staging.graylum.com','x.auth-staging.graylum.com',
 'AUTH-STAGING.GRAYLUM.COM','auth-staging.graylum.com.','https://auth-staging.graylum.com',' auth-staging.graylum.com','',
])('rejects any other production domain %j',url=>expect(()=>stagingRuntimeWindow({...env,VERCEL_PROJECT_PRODUCTION_URL:url})).toThrow('RUNTIME_STAGING_TARGET_DENIED'));
it.each([
 {VERCEL:'0'},{VERCEL_GIT_COMMIT_REF:'main'},{VERCEL_GIT_REPO_OWNER:'someone-else'},{VERCEL_GIT_REPO_SLUG:'fork'},
 {VERCEL_PROJECT_ID:'production-project'},{NEXT_PUBLIC_SUPABASE_URL:'https://production.supabase.co'},
])('keeps every other binding with the custom domain %#',patch=>
 expect(()=>stagingRuntimeWindow({...env,VERCEL_PROJECT_PRODUCTION_URL:'auth-staging.graylum.com',...patch})).toThrow('RUNTIME_STAGING_TARGET_DENIED'));
it('keeps configuration and enablement checks with the custom domain',()=>{
 const custom={...env,VERCEL_PROJECT_PRODUCTION_URL:'auth-staging.graylum.com'};
 expect(()=>stagingRuntimeWindow({...custom,V3_RUNTIME_STAGING_WINDOW_ID:'not-a-uuid'})).toThrow('RUNTIME_STAGING_NOT_CONFIGURED');
 expect(()=>stagingRuntimeWindow({...custom,V3_RUNTIME_STAGING_DATABASE_HOST:undefined})).toThrow('RUNTIME_STAGING_NOT_CONFIGURED');
 expect(()=>stagingRuntimeWindow({...custom,V3_RUNTIME_STAGING_ENABLED:'false'})).toThrow('RUNTIME_STAGING_DISABLED');
});

it('allows original-call maintenance after disablement, but never across targets',()=>{
 expect(stagingRuntimeWindow({...env,V3_RUNTIME_STAGING_ENABLED:'false'},true)).toBe(env.V3_RUNTIME_STAGING_WINDOW_ID);
 expect(()=>stagingRuntimeWindow({...env,VERCEL_GIT_COMMIT_REF:'main'},true)).toThrow();
 expect(()=>stagingRuntimeWindow({...env,VERCEL_PROJECT_ID:'production'},true)).toThrow();
 expect(()=>stagingRuntimeWindow({...env,NEXT_PUBLIC_SUPABASE_URL:'https://production.supabase.co'},true)).toThrow();
});
