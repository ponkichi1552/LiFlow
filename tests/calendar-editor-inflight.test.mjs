import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';

for (const platform of ['ios', 'android']) test(`${platform} an in-flight calendar save cannot navigate through an existing chore suggestion`, async () => {
  let release; let entered; let opened = 0; let closed = 0; let saved = 0;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const screen = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: {
    initial: { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: { ...newEventDraft('2026-11-07', 'Asia/Tokyo'), title: '床掃除' } },
    local: { database: {}, snapshot: { events: [], exceptions: [], categories: [], drafts: [] }, refresh: async () => {},
      saveEvent: async () => { entered(); await gate; } },
    chores: [{ id: 'floor', name: '床掃除', onOpen: () => { opened++; } }], onClose: () => { closed++; }, onSaved: () => { saved++; },
  } });
  try {
    screen.button('予定を保存').props.onPress(); await started; screen.render();
    const suggestion = screen.button('床掃除の既存の予定を開く');
    if (!suggestion.props.disabled) await suggestion.props.onPress();
    assert.equal(opened, 0, 'a second action cannot move away while the first save still owns its completion callback');
    assert.equal(closed, 0); release(); await screen.flush(); assert.equal(saved, 1);
  } finally { release(); await screen.flush(); screen.unmount(); }
});
