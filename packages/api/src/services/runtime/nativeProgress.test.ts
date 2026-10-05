/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {NativeMessageScanner} from './nativeMessageScanner';
import {NativeProgressProjection, NativeTextTransport} from './nativeProgress';

const frame = (args: string, name?: string, index = 0) => ({choices: [{delta: {
  tool_calls: [{index, function: {arguments: args, ...(name ? {name} : {})}}],
}}]});

describe('incremental public message scanner', () => {
  it('decodes every possible split without exposing private fields or half surrogate pairs', () => {
    const raw = '{"message":"  hello\\n\\"你好\\"\\uD83D\\uDE00🦊","private":"secret"}';
    for (let split = 0; split <= raw.length; split++) {
      const scanner = new NativeMessageScanner();
      const first = scanner.append(raw.slice(0, split));
      expect(first).not.toMatch(/[\uD800-\uDBFF]$/u);
      expect(first + scanner.append(raw.slice(split))).toBe('hello\n"你好"😀🦊');
      expect(scanner.messageFirst).toBe(true);
      expect(scanner.scannedUnits).toBe(raw.length);
    }
  });

  it('waits across individual escaped units and ignores later message-looking fields', () => {
    const scanner = new NativeMessageScanner(false);
    const raw = JSON.stringify({question: {message: 'secret'}, options: ['a,}\\"'], message: 'hello 😀'});
    let visible = '';
    for (const unit of raw.split('')) visible += scanner.append(unit);
    expect(visible).toBe('hello 😀');
    expect(scanner.scannedUnits).toBe(raw.length);
  });

  it('buffers non-leading T2 message, arrays, escaped property names, and malformed values', () => {
    for (const raw of ['{"private":0,"message":"later"}', '[{"message":"plan"}]',
      '{"mess\\u0061ge":"escaped key"}', '{"message":{"secret":"no"}}']) {
      const scanner = new NativeMessageScanner();
      expect(scanner.append(raw)).toBe('');
    }
  });

  it('reports the shared leading-property convention and stops invalid escapes', () => {
    const scanner = new NativeMessageScanner();
    expect(scanner.append(' \n{ "message" : "hi\\')).toBe('hi');
    expect(scanner.messageFirst).toBe(true);
    expect(scanner.append('zprivate')).toBe('');
    expect(scanner.append('"')).toBe('');
  });

  it('counts linear scan work across long one-unit fragments and bounds public code points', () => {
    const scanner = new NativeMessageScanner(true, 3);
    const raw = '{"message":"😀你好more"}';
    for (const unit of raw.split('')) scanner.append(unit);
    expect(scanner.text).toBe('😀你好');
    expect(scanner.scannedUnits).toBe(raw.length);
  });
});

describe('native host projection', () => {
  it('streams assistant text and keeps it until a nonempty first-card message arrives', () => {
    const projection = new NativeProgressProjection({mode: 'agent', toolMessage: true});
    expect(projection.appendText(' \n')).toBeNull();
    expect(projection.appendText('Assistant')).toMatchObject({text: 'Assistant', replace: false});
    expect(projection.appendToolFrame(frame('{"question":"private",', 'ask_question'))).toBeNull();
    expect(projection.text).toBe('Assistant');
    expect(projection.appendToolFrame(frame('"message":"  '))).toBeNull();
    expect(projection.appendToolFrame(frame('Card'))).toMatchObject({text: 'Card', replace: true});
    expect(projection.appendText('obsolete')).toBeNull();
    expect(projection.appendToolFrame(frame(' message"}'))).toMatchObject({delta: ' message', replace: false});
    expect(projection.finish('Card message')).toBeNull();
  });

  it('ignores nonzero calls and non-question tools without mutating frames', () => {
    const projection = new NativeProgressProjection({mode: 'agent', toolMessage: true});
    const input = frame('{"message":"private"}', 'ask_question', 1);
    const before = JSON.stringify(input);
    expect(projection.appendToolFrame(input)).toBeNull();
    expect(JSON.stringify(input)).toBe(before);
    expect(projection.appendToolFrame(frame('{"message":"private"}', 'other'))).toBeNull();
  });

  it('handles one-shot parameters and invalid-card authoritative correction', () => {
    const projection = new NativeProgressProjection({mode: 'agent', toolMessage: true});
    projection.appendText('old');
    expect(projection.appendToolFrame(JSON.stringify(frame('{"message":"new"}', 'ask_question'))))
      .toMatchObject({text: 'new', replace: true});
    expect(projection.finish('fixed notice')).toMatchObject({text: 'fixed notice', replace: true});
  });

  it('keeps plan/protocol content buffered and delivers authoritative fallback on finish', () => {
    const projection = new NativeProgressProjection({mode: 'message-first'});
    expect(projection.appendText('{"patches":[],"message":"final"}')).toBeNull();
    expect(projection.messageFirst).toBe(false);
    expect(projection.finish('final')).toMatchObject({replace: true, text: 'final'});
  });
});

describe('native delta transport', () => {
  it('uses code point offsets, snapshots and revisions while discarding unsent old deltas', () => {
    const projection = new NativeProgressProjection({mode: 'agent', toolMessage: true});
    const transport = new NativeTextTransport();
    transport.push(projection.appendText('😀a')!);
    expect(transport.flush()).toEqual({type: 'textDelta', offset: 0, text: '😀a', rev: 0, source: 'assistant'});
    transport.push(projection.appendText('b')!);
    expect(transport.flush()).toEqual({type: 'textDelta', offset: 2, text: 'b', rev: 0});
    transport.push(projection.appendText('discard')!);
    transport.push(projection.appendToolFrame(frame('{"message":"card', 'ask_question'))!);
    transport.push(projection.appendToolFrame(frame(' 😀"}'))!);
    expect(transport.flush()).toEqual({type: 'textDelta', offset: 0, text: 'card 😀', rev: 1, source: 'message'});
    expect(transport.flush()).toBeNull();
    transport.push(projection.finish('invalid notice')!);
    expect(transport.flush()).toEqual({type: 'textDelta', offset: 0, text: 'invalid notice', rev: 2, source: 'final'});
  });

  it('uses initial revision zero when a switch precedes the first emitted event', () => {
    const projection = new NativeProgressProjection({mode: 'agent', toolMessage: true});
    const transport = new NativeTextTransport();
    transport.push(projection.appendText('discard')!);
    transport.push(projection.finish('authoritative')!);
    expect(transport.flush()).toEqual({type: 'textDelta', offset: 0, text: 'authoritative', rev: 0, source: 'final'});
  });

  it('sends bytes proportional to answer length under batched flushing', () => {
    const projection = new NativeProgressProjection({mode: 'message-first'});
    const transport = new NativeTextTransport();
    projection.appendText('{"message":"');
    const size = 20000;
    let bytes = 0;
    let rendered = '';
    for (let index = 0; index < size; index++) {
      transport.push(projection.appendText('中')!);
      if (index % 100 === 99) {
        const event = transport.flush()!;
        bytes += Buffer.byteLength(JSON.stringify(event));
        expect(event.offset).toBe(Array.from(rendered).length);
        rendered += event.text;
      }
    }
    expect(rendered).toBe('中'.repeat(size));
    expect(bytes).toBeLessThan(size * 4);
  });

  it('can clear an already visible bubble with an empty terminal snapshot', () => {
    const projection = new NativeProgressProjection({mode: 'agent'});
    const transport = new NativeTextTransport();
    transport.push(projection.appendText('old')!);
    transport.flush();
    transport.push(projection.finish('')!);
    expect(transport.flush()).toEqual({type: 'textDelta', offset: 0, text: '', rev: 1, source: 'final'});
  });
});


it('source survives batching, while two provider exchanges can share the same source category', () => {
  const first = new NativeProgressProjection({mode: 'message-first'});
  const second = new NativeProgressProjection({mode: 'message-first'});
  const transport = new NativeTextTransport();
  transport.push({...first.appendText('{"message":"before search"}')!, replace: true});
  const displayed = transport.flush();
  // execute.ts resets the projection for each primary SDK exchange. The next
  // exchange may already be dispatched before its first public message arrives.
  transport.push({...second.appendText('{"message":"after search"}')!, replace: true});
  const later = transport.flush();
  expect(displayed).toMatchObject({source: 'message', rev: 0, text: 'before search'});
  expect(later).toMatchObject({source: 'message', rev: 1, text: 'after search'});
  expect(displayed!.source).toBe(later!.source);
  expect(displayed!.text).not.toBe(later!.text);
});
