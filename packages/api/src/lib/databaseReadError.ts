/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Preserve a diagnostic code without retaining database messages, SQL or data. */
export class DatabaseReadError extends Error {
  readonly databaseCode?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.databaseCode = code && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(code) ? code : undefined;
  }
}
