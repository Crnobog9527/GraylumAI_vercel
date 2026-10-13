/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// node scripts/staging-login <role>
// Writes ~/.graylum/staging-sessions/<role>.json (mode 600). Logs only the role, expiry and file path.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emailForRole, loadAccounts, RefusalError, STAGING_APP_ORIGIN } from './guards.mjs';
import { loadServiceKey } from './service-key.mjs';
import { buildStorageState, createSession, writeStorageState } from './session.mjs';

export function defaultPaths(home = homedir()) {
  return {
    accountsFile: join(home, '.graylum', 'secrets', 'staging-test-accounts.json'),
    envFile: join(home, '.graylum', 'secrets', 'supabase-staging.env'),
    sessionsDir: join(home, '.graylum', 'staging-sessions'),
  };
}

const USAGE = '用法：node scripts/staging-login <角色>   例如 node scripts/staging-login user';

export async function run(argv, { paths = defaultPaths(), fetchImpl = fetch, runCommand, log = console.log } = {}) {
  const role = argv.find(arg => !arg.startsWith('-'));
  if (!role || argv.includes('--help') || argv.includes('-h')) {
    log(USAGE);
    return role || argv.length ? 0 : 1;
  }
  const accounts = await loadAccounts(paths.accountsFile);
  const email = emailForRole(accounts, role);
  const { key, source } = await loadServiceKey({ envFile: paths.envFile, run: runCommand });
  const session = await createSession({ fetchImpl, key, email });
  const outFile = join(paths.sessionsDir, `${role}.json`);
  await writeStorageState(outFile, buildStorageState(session));
  log(`已生成测试站登录状态：角色 ${role}（密钥来源 ${source}）`);
  log(`访问令牌过期时间 ${new Date(session.expires_at * 1000).toISOString()}；网站会用刷新令牌自动续期，失效后重跑即可。`);
  log(`storageState 文件：${outFile}（仅本机，权限 600）；打开 ${STAGING_APP_ORIGIN}`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    process.exitCode = await run(argv);
  } catch (error) {
    // RefusalError messages are written by this tool and carry no secrets; anything else is reduced
    // to its type so an unexpected error object can never echo a token.
    const message = error instanceof RefusalError ? error.message : `意外错误（${error?.name ?? 'Error'}）。`;
    console.error(`staging-login 未完成：${message}`);
    process.exitCode = 2;
  }
}
