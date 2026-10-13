/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Hard limits for the staging one-click login tool. Everything here is a refusal: the tool only
// ever talks to the staging Supabase project and only for emails on the local test-account list.
import { readFile } from 'node:fs/promises';

export const STAGING_PROJECT_REF = 'gvcpmcunmfrbxuwimxfa';
export const PRODUCTION_PROJECT_REF = 'fhmshnqjjnnlvplojktv';
export const STAGING_SUPABASE_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
export const STAGING_APP_ORIGIN = 'https://auth-staging.graylum.com';

const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class RefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefusalError';
  }
}

export function assertValidRole(role) {
  if (typeof role !== 'string' || !ROLE_PATTERN.test(role)) {
    throw new RefusalError('角色名只能用小写字母、数字和连字符，例如 user、free、admin。');
  }
  return role;
}

function refBehind(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /^([a-z0-9]{20})\.supabase\.(co|in)$/.exec(parsed.hostname.toLowerCase());
  return match ? match[1] : null;
}

// Any Supabase URL other than the staging project is refused, production is named explicitly.
export function assertStagingSupabaseUrl(url) {
  const ref = refBehind(url);
  if (ref === PRODUCTION_PROJECT_REF) {
    throw new RefusalError('拒绝：目标是正式环境的 Supabase 项目。本工具只允许测试站。');
  }
  const parsed = ref ? new URL(url) : null;
  if (!parsed || ref !== STAGING_PROJECT_REF || parsed.protocol !== 'https:' || parsed.port ||
    (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.username) {
    throw new RefusalError('拒绝：目标不是测试站的 Supabase 项目。');
  }
  return STAGING_SUPABASE_URL;
}

function jwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Legacy service_role keys are JWTs that name their project; new sb_secret_ keys only work against
// the project that issued them, so sending one to the staging URL is itself the check.
export function assertStagingServiceKey(key) {
  if (typeof key !== 'string' || key.length < 20) {
    throw new RefusalError('没有拿到可用的测试站管理密钥。');
  }
  if (key.startsWith('sb_secret_')) return key;
  if (key.startsWith('sb_publishable_')) {
    throw new RefusalError('拿到的是公开密钥，不是管理密钥。');
  }
  const payload = jwtPayload(key);
  if (!payload) throw new RefusalError('管理密钥格式无法识别。');
  if (payload.ref === PRODUCTION_PROJECT_REF) {
    throw new RefusalError('拒绝：这是正式环境的密钥。本工具只允许测试站。');
  }
  if (payload.ref !== STAGING_PROJECT_REF) {
    throw new RefusalError('拒绝：这个密钥不属于测试站项目。');
  }
  if (payload.role !== 'service_role') {
    throw new RefusalError('拿到的不是管理（service_role）密钥。');
  }
  return key;
}

export function parseAccounts(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RefusalError('账号名单不是合法的 JSON。');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RefusalError('账号名单格式应为 { "角色": "测试邮箱" }。');
  }
  const accounts = new Map();
  for (const [role, email] of Object.entries(data)) {
    if (role.startsWith('_')) continue; // comment keys such as "_note"
    assertValidRole(role);
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
      throw new RefusalError(`账号名单里角色 ${role} 的邮箱格式不对。`);
    }
    accounts.set(role, email.trim().toLowerCase());
  }
  return accounts;
}

export async function loadAccounts(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new RefusalError(`找不到账号名单 ${path}，请按 scripts/staging-login/accounts.example.json 填写。`);
  }
  return parseAccounts(text);
}

export function emailForRole(accounts, role) {
  assertValidRole(role);
  const email = accounts.get(role);
  if (!email) {
    throw new RefusalError(`账号名单里没有角色 ${role}。可用角色：${[...accounts.keys()].join('、') || '（空）'}`);
  }
  return email;
}

// The user record returned by the admin API must be exactly the listed address, already confirmed,
// so signing in neither creates nor confirms anyone.
export function assertListedExistingUser(user, email) {
  if (!user || typeof user.email !== 'string' || user.email.toLowerCase() !== email) {
    throw new RefusalError('测试站里没有这个名单邮箱对应的账号。本工具不创建账号，请先手动注册。');
  }
  if (!user.email_confirmed_at) {
    throw new RefusalError('这个测试账号的邮箱还没验证。本工具不替账号做验证，请先手动完成。');
  }
  if (user.banned_until && Date.parse(user.banned_until) > Date.now()) {
    throw new RefusalError('这个测试账号已被封禁。');
  }
  return user;
}
