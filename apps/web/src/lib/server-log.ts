type ServerLogLevel = 'info' | 'warn' | 'error';
type ServerLogCategory = 'auth' | 'billing' | 'security' | 'system' | 'api';

type ServerLogContext = Record<string, unknown>;

function writeServerLog(
  level: ServerLogLevel,
  category: ServerLogCategory,
  message: string,
  context: ServerLogContext = {},
) {
  const payload = {
    level,
    time: new Date().toISOString(),
    env: process.env.NODE_ENV,
    category,
    ...context,
    msg: message,
  };

  const sink =
    level === 'info' ? console.info :
    level === 'warn' ? console.warn :
    console.error;

  sink(JSON.stringify(payload));
}

export function logServerInfo(
  category: ServerLogCategory,
  message: string,
  context?: ServerLogContext,
) {
  writeServerLog('info', category, message, context);
}

export function logServerWarn(
  category: ServerLogCategory,
  message: string,
  context?: ServerLogContext,
) {
  writeServerLog('warn', category, message, context);
}

export function logServerError(
  category: ServerLogCategory,
  message: string,
  context?: ServerLogContext,
) {
  writeServerLog('error', category, message, context);
}
