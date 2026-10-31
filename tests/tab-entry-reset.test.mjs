import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView, openCalendarDay } from './helpers/calendar-ui.mjs';

for (const platform of ['ios', 'android']) {
  test(`${platform} leaving either workspace resets calendar overview and guide route without treating a settings overlay as another tab`, () => {
    for (const joined of [false, true]) for (const view of ['calendar', 'chores']) {
      let state = { type: 'tab', index: view === 'calendar' ? 1 : 2, routes: ['index', 'explore', 'guide', 'manual'].map(name => ({ key: name, name })) };
      const params = { choreId: 'selected-chore', source: 'shared', returnTo: 'home' }; const changed = [];
      let listener; let resets = 0; let unsubscribed = false;
      const context = { _currentValue: joined ? { active: { protocol: 2 } } : null };
      const screen = screenHarness('src/components/workspace-tab.tsx', { platform, exportName: 'WorkspaceTab', props: { view, children: 'personal' }, params,
        effectDependencies: true, effect: callback => callback(), mocks: {
          '../contexts/workspace-context': { WorkspaceContext: context },
          '../hooks/use-calendar-display': { resetCalendarOverview: () => { resets++; } },
          'expo-router': { Tabs: { Screen: 'TabsScreen' }, useLocalSearchParams: () => params,
            useNavigation: () => ({ getState: () => state, addListener: (name, callback) => { assert.equal(name, 'state'); listener = callback; return () => { unsubscribed = true; }; },
              setParams: patch => { changed.push(patch); Object.assign(params, patch); } }) },
        } });
      listener({ data: { state: { type: 'stack', index: 1, routes: [{ name: '(tabs)' }, { name: 'settings' }] } } });
      assert.equal(resets, 0); assert.deepEqual(changed, []);
      state = { ...state, index: 0 }; listener({ data: { state } }); listener({ data: { state } });
      if (view === 'calendar') { assert.equal(resets, 1); assert.deepEqual(changed, []); }
      else { assert.deepEqual(changed, [{ choreId: undefined, source: undefined, returnTo: undefined }]); assert.equal(resets, 0); }
      screen.unmount(); assert.equal(unsubscribed, true);
    }
  });
  test(`${platform} month dates reopen the remembered day format and year overview distinguishes this month and today`, async () => {
    for (const mode of ['1日表示', '2日表示', 'リスト表示']) {
      const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { platform, exportName: 'PlannerCalendar', props: {
        today: '2026-11-01', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 1 }), renderChores: () => null,
      } });
      await selectCalendarView(screen, mode); await screen.press('月表示に戻る'); await openCalendarDay(screen, '2026-11-01', { chores: false });
      assert.equal(screen.button('カレンダーの表示を選択').props.accessibilityValue.text, mode.replace('表示', ''));
      assert.ok(screen.nodes().some(node => node.props.testID === (mode === 'リスト表示' ? 'calendar-agenda' : 'calendar-timeline')));
      await screen.press('月表示に戻る'); await screen.press('年表示に戻る');
      const current = screen.button('2026年11月を表示'); assert.match(current.props.accessibilityHint, /今月/u);
      assert.ok(current.props.style.some(part => part?.borderColor && part?.backgroundColor));
      const today = current.children.flatMap(node => node.children ?? []).find(node => node.key === '2026-11-01');
      assert.ok(today?.props.style.some(part => part?.backgroundColor && part?.borderRadius));
      const add = Object.assign({}, ...screen.button('予定を追加').props.style.filter(Boolean)); assert.ok(add.minWidth > add.minHeight);
    }
  });
}
