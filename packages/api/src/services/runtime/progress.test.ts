/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,it,expect} from 'vitest';
import {publicMentorText} from './progress';
describe('public mentor progress boundary',()=>{
 it('reveals only actual incremental message content, before a complete JSON document',()=>{
  expect(publicMentorText('{"message":"先确认')).toBe('先确认');
  expect(publicMentorText('{"message":"先确认你的用途。","patches":[{"private":"secret"}]}')).toBe('先确认你的用途。');
 });
 it('waits for complete escapes and never renders protocol or reasoning fields',()=>{
  expect(publicMentorText('{"message":"hello\\')).toBe('hello');
  expect(publicMentorText('{"message":"hello\\u4f')).toBe('hello');
  expect(publicMentorText('{"message":"hello\\u4f60')).toBe('hello你');
  expect(publicMentorText('{"reasoning":"secret","message":"answer"}')).toBe('');
  expect(publicMentorText('{"message":{"reasoning":"secret"}}')).toBe('');
  expect(publicMentorText('secret <analysis>')).toBe('');
  expect(publicMentorText('{"message":"bad\\z')).toBe('');
 });
 it('matches the existing public mentor message length bound',()=>{expect(publicMentorText(JSON.stringify({message:'x'.repeat(5000)}))).toHaveLength(4000);});
 it('keeps escaped quotes and newlines within the public message',()=>{
  expect(publicMentorText('{"message":"他说\\"用途\\"\\n下一行","private":"secret"}')).toBe('他说"用途"\n下一行');
 });
});
