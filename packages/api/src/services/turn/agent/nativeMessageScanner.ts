/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Keep an unfinished surrogate off the wire so offsets always count Unicode code points. */
export class NativeTextAccumulator {
  text = '';
  private high = '';
  private trailing = '';
  private started = false;
  private count = 0;

  constructor(private readonly maxCodePoints = 262144) {}

  append(input: string): string {
    let added = '';
    for (const unit of input.split('')) {
      const code = unit.charCodeAt(0);
      if (this.high) {
        if (code >= 0xdc00 && code <= 0xdfff) {
          added += this.accept(this.high + unit);
          this.high = '';
          continue;
        }
        // Lone surrogates are not complete public Unicode characters.
        added += this.accept('\ufffd');
        this.high = '';
      }
      if (code >= 0xd800 && code <= 0xdbff) this.high = unit;
      else added += this.accept(code >= 0xdc00 && code <= 0xdfff ? '\ufffd' : unit);
    }
    // Final envelopes trim their message. Keep a whitespace suffix off the wire
    // until another public character proves it belongs inside the saved prose.
    const pending = this.trailing + added;
    const visible = pending.trimEnd();
    this.trailing = pending.slice(visible.length);
    this.text += visible;
    return visible;
  }

  private accept(point: string): string {
    if (!this.started && !point.trimStart()) return '';
    this.started = true;
    if (this.count >= this.maxCodePoints) return '';
    this.count++;
    return point;
  }
}

type State = 'start' | 'key' | 'key-string' | 'colon' | 'value' | 'skip' | 'after' | 'message' | 'done' | 'invalid';
/** Scans each newly received UTF-16 unit once. Only a top-level message string is public. */
export class NativeMessageScanner {
  private state: State = 'start';
  private key = '';
  private keyRaw = '';
  private escaped = false;
  private escape = '';
  private skipDepth = 0;
  private skipString = false;
  private first = true;
  private readonly output: NativeTextAccumulator;
  messageFirst = false;
  scannedUnits = 0;

  constructor(private readonly leadingOnly = true, maxCodePoints = 262144) {
    this.output = new NativeTextAccumulator(maxCodePoints);
  }

  get text(): string { return this.output.text; }

  append(fragment: string): string {
    let decoded = '';
    for (const unit of fragment) {
      // for-of preserves raw surrogate pairs; syntax transitions only inspect ASCII.
      this.scannedUnits += unit.length;
      if (this.state === 'done' || this.state === 'invalid') continue;
      if (this.state === 'message') {
        decoded += this.messageUnit(unit);
        continue;
      }
      if (this.state === 'key-string') {
        this.keyRaw += unit;
        if (this.escaped) { this.escaped = false; continue; }
        if (unit === '\\') { this.escaped = true; continue; }
        if (unit !== '"') continue;
        try { this.key = JSON.parse(this.keyRaw) as string; }
        catch { this.state = 'invalid'; continue; }
        if (this.leadingOnly && this.keyRaw !== '"message"') { this.state = 'invalid'; continue; }
        this.state = 'colon';
        continue;
      }
      if (this.state === 'skip') {
        if (this.skipString) {
          if (this.escaped) this.escaped = false;
          else if (unit === '\\') this.escaped = true;
          else if (unit === '"') this.skipString = false;
          continue;
        }
        if (unit === '"') { this.skipString = true; continue; }
        if (unit === '{' || unit === '[') { this.skipDepth++; continue; }
        if (unit === '}' || unit === ']') {
          if (this.skipDepth) { this.skipDepth--; continue; }
          this.state = unit === '}' ? 'done' : 'invalid';
          continue;
        }
        if (unit === ',' && !this.skipDepth) this.state = 'key';
        continue;
      }
      if (/\s/.test(unit)) continue;
      if (this.state === 'start') this.state = unit === '{' ? 'key' : 'invalid';
      else if (this.state === 'key') {
        if (unit !== '"') { this.state = unit === '}' ? 'done' : 'invalid'; continue; }
        this.keyRaw = '"';
        this.state = 'key-string';
      } else if (this.state === 'colon') {
        this.state = unit === ':' ? 'value' : 'invalid';
        if (unit === ':' && this.first && this.keyRaw === '"message"') this.messageFirst = true;
      } else if (this.state === 'value') {
        if (this.key === 'message') {
          this.state = unit === '"' ? 'message' : 'invalid';
        } else {
          this.first = false;
          this.state = 'skip';
          this.skipString = unit === '"';
          this.skipDepth = unit === '{' || unit === '[' ? 1 : 0;
          if (unit === ',' || unit === '}' || unit === ']') this.state = 'invalid';
        }
      }
    }
    return this.output.append(decoded);
  }

  private messageUnit(unit: string): string {
    if (this.escape) {
      this.escape += unit;
      if (this.escape === '\\u') return '';
      if (this.escape.startsWith('\\u') && this.escape.length < 6) {
        if (!/^[0-9a-f]$/i.test(unit)) this.state = 'invalid';
        return '';
      }
      try {
        const decoded = JSON.parse('"' + this.escape + '"') as string;
        this.escape = '';
        return decoded;
      } catch { this.state = 'invalid'; return ''; }
    }
    if (unit === '\\') { this.escape = '\\'; return ''; }
    if (unit === '"') { this.state = 'done'; return ''; }
    if (unit.charCodeAt(0) < 32) { this.state = 'invalid'; return ''; }
    return unit;
  }
}
