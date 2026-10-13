import { describe, expect, it } from 'vitest';
import { FREE_REPLY, demoInformation, demoReducer, initialDemoState, openQuestion, QUESTION_ONE, QUESTION_TWO, REPORT_BODY } from './demo-script';

describe('landing demo script', () => {
  it('walks the first step: two answers, a summary, then a confirmed step that unlocks the report', () => {
    let state = initialDemoState();
    expect(openQuestion(state)).toBe(QUESTION_ONE);
    state = demoReducer(state, { type: 'answer', option: QUESTION_ONE.recommended! });
    expect(state.values.experience.value).toBe(QUESTION_ONE.options[2]);
    expect(state.liveId).toBe(state.messages.at(-1)!.id);
    state = demoReducer(state, { type: 'settled' });
    expect(openQuestion(state)).toBe(QUESTION_TWO);
    expect(demoReducer(state, { type: 'confirm' }).valid).toBe(false); // 想帮的人 is still missing
    state = demoReducer(state, { type: 'answer', option: 0 });
    expect(state.phase).toBe('summary');
    expect(state.messages.at(-1)!.summary).toBe(true);
    expect(openQuestion(state)).toBeNull();
    state = demoReducer(state, { type: 'confirm' });
    expect(state.valid).toBe(true);
    expect(Object.values(state.values).every(value => value.status === 'confirmed')).toBe(true);
    state = demoReducer(state, { type: 'report', open: true });
    expect(state.reportOpen).toBe(true);
    expect(demoReducer(state, { type: 'reset' })).toEqual(initialDemoState());
  });

  it('says it straight when the visitor picks a crowded topic', () => {
    const state = demoReducer(initialDemoState(), { type: 'answer', option: 0 });
    expect(state.messages.at(-1)!.text).toContain('说句实话');
  });

  it('lets an edited checklist field count toward confirming', () => {
    let state = demoReducer(initialDemoState(), { type: 'edit', fieldId: 'experience', text: '入行经历' });
    state = demoReducer(state, { type: 'edit', fieldId: 'audience', text: '新移民' });
    expect(demoReducer(state, { type: 'confirm' }).valid).toBe(true);
    expect(demoInformation(state).you.schema.map(field => field.id)).toEqual(['experience', 'time', 'audience']);
  });

  it('marks the checklist as updated on narrow screens until it is opened, and the report keeps the panel', () => {
    let state = demoReducer(initialDemoState(), { type: 'answer', option: 2 });
    expect(state.checklistUpdated).toBe(true);
    state = demoReducer(state, { type: 'panel', panel: 'checklist' });
    expect(state.checklistUpdated).toBe(false);
    state = demoReducer(demoReducer(state, { type: 'report', open: true }), { type: 'report', open: false });
    expect(state.panel).toBe('checklist');
  });

  it('answers free text honestly and keeps the open question', () => {
    const state = demoReducer(initialDemoState(), { type: 'free', text: '我其实想拍 vlog' });
    expect(state.messages.at(-2)!.text).toBe('我其实想拍 vlog');
    expect(state.messages.at(-1)!.text).toBe(FREE_REPLY);
    expect(openQuestion(demoReducer(state, { type: 'settled' }))).toBe(QUESTION_ONE);
    expect(demoReducer(state, { type: 'free', text: '  ' })).toBe(state);
  });

  it('invents no follower, income or growth numbers', () => {
    const text = [REPORT_BODY, ...initialDemoState().messages.map(message => message.text),
      ...QUESTION_ONE.options, ...QUESTION_TWO.options].join('\n');
    expect(text).not.toMatch(/粉丝|收入|涨粉|万|\$|%|美元/);
  });
});
