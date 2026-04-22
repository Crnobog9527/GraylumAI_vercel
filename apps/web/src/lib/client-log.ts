function isDevEnvironment() {
  return process.env.NODE_ENV !== 'production';
}

export function logClientDevWarn(message: string, context?: Record<string, unknown>) {
  if (!isDevEnvironment()) {
    return;
  }

  console.warn(message, context ?? {});
}

export function logClientDevError(message: string, context?: Record<string, unknown>) {
  if (!isDevEnvironment()) {
    return;
  }

  console.error(message, context ?? {});
}
