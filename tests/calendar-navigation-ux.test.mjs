import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { selectCalendarView, scrollCalendarToDate } from './helpers/calendar-ui.mjs';
import { newEventDraft } from '../src/features/calendar/events.ts';

for (const platform of ['ios', 'android']) {
  const make = (extra = {}) => screenHarness('src/features/calendar/planner-calendar.tsx', { platform, exportName: 'PlannerCalendar', layoutEffect: effect => effect(), props: {
    today: '2026-10-31', selectedDate: '2026-12-10', timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, pending: 0, total: 0 }), renderChores: () => null, ...extra,
  } });
  test(`${platform} Today remains available and preserves each calendar view while moving to the current date`, async () => {
    for (const [button, id] of [['1日表示', 'calendar-timeline'], ['2日表示', 'calendar-timeline'], ['リスト表示', 'calendar-agenda']]) {
      const screen = make(); await selectCalendarView(screen, button); await screen.press('今日'); await screen.flush();
      assert.equal(screen.button('カレンダーの表示を選択').props.accessibilityValue.text, button.replace('表示', ''));
      assert.ok(screen.nodes().some(node => node.props.testID === id)); assert.match(screen.text(), /10月31日/u);
      if (button === '2日表示') assert.match(screen.text(), /11月1日/u);
    }
    const year = make(); await year.press('年表示に戻る');
    const list = year.nodes().find(node => node.props.testID === 'calendar-year'); let jump;
    list.props.ref.current = { scrollToIndex: value => { jump = value; } };
    const nextYearIndex = list.props.data.findIndex(row => row.year === 2027 && row.quarter === null);
    list.props.onScrollBeginDrag(); list.props.onScroll({ nativeEvent: { contentOffset: { y: list.props.getItemLayout(list.props.data, nextYearIndex).offset } } }); await year.flush();
    assert.equal(year.button('表示する年と月を選択').props.accessibilityValue.text, '2027年');
    await year.press('今日'); await year.flush();
    assert.ok(year.nodes().some(node => node.props.testID === 'calendar-year'));
    assert.equal(list.props.data[jump.index].year, 2026); assert.equal(list.props.data[jump.index].quarter, 3);
    assert.equal(jump.animated, false, 'Today jumps directly to the current year without scrolling through the intervening years');
    assert.equal(year.button('表示する年と月を選択').props.accessibilityValue.text, '2026年');
    assert.equal(year.nodes().some(node => ['前の年', '次の年'].includes(node.props.accessibilityLabel)), false);
    const root = year.nodes().find(node => typeof node.props.onMoveShouldSetPanResponderCapture === 'function'); const swipe = { x0: 160, dx: -100, dy: 2, numberActiveTouches: 1 };
    assert.equal(root.props.onMoveShouldSetPanResponderCapture(null, swipe), false);
  });
  test(`${platform} year header changes only as the year boundary reaches the top in either direction`, () => {
    const changed = [];
    const screen = screenHarness('src/features/calendar/calendar-year.tsx', { platform, exportName: 'CalendarYear', layoutEffect: effect => effect(), props: {
      initialYear: 2026, today: '2026-11-12', onMonth() {}, onYear: year => changed.push(year), onReady() {},
    } });
    const list = screen.nodes().find(node => node.props.testID === 'calendar-year');
    const heading = list.props.data.findIndex(row => row.year === 2027 && row.quarter === null);
    const boundary = list.props.getItemLayout(list.props.data, heading).offset;
    const scrollTo = y => list.props.onScroll({ nativeEvent: { contentOffset: { y } } });
    scrollTo(0); assert.deepEqual(changed, [], 'mount-time positioning does not replace the requested year');
    const initialHeading = list.props.data.findIndex(row => row.year === 2026 && row.quarter === null);
    scrollTo(list.props.getItemLayout(list.props.data, initialHeading).offset);
    scrollTo(boundary - 1); assert.deepEqual(changed, [], 'a year heading below the upper header does not change it early');
    scrollTo(boundary); assert.deepEqual(changed, [2027]);
    scrollTo(boundary + 1); assert.deepEqual(changed, [2027], 'scrolling within one year does not repeatedly update the header');
    scrollTo(boundary - 1); assert.deepEqual(changed, [2027, 2026]);
    scrollTo(Number.NaN); assert.deepEqual(changed, [2027, 2026]);
  });
  test(`${platform} adding from year view uses the displayed year and resumes the saved personal draft when present`, async () => {
    const opened = [];
    const local = { database: {}, snapshot: { events: [], exceptions: [], categories: [], drafts: [] } };
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { platform, exportName: 'PlannerCalendar', props: {
      today: '2026-10-31', selectedDate: '2026-12-10', timeZone: 'Asia/Tokyo', local,
      dayInfo: () => ({ loaded: true, pending: 0, total: 0 }), renderChores: () => null,
    }, mocks: { '@/features/calendar/calendar-editor': { CalendarEditor: props => { opened.push(props.initial); return null; } } } });
    try {
      await screen.press('年表示に戻る');
      const yearList = screen.nodes().find(node => node.props.testID === 'calendar-year');
      const nextYearIndex = yearList.props.data.findIndex(row => row.year === 2027 && row.quarter === null);
      yearList.props.onScrollBeginDrag();
      yearList.props.onScroll({ nativeEvent: { contentOffset: { y: yearList.props.getItemLayout(yearList.props.data, nextYearIndex).offset } } });
      await screen.flush(); await screen.press('予定を追加');
      assert.equal(opened.at(-1).value.startDate, '2027-12-10');

      const groupDraft = { eventId: null, anchorDate: null, revision: 1, exceptionRevision: 0, scope: 'series', audience: 'group', value: { ...newEventDraft('2026-10-31', 'Asia/Tokyo'), title: '共有の入力中' } };
      const personalDraft = { eventId: null, anchorDate: null, revision: 2, exceptionRevision: 0, scope: 'series', audience: 'personal', value: { ...newEventDraft('2026-11-01', 'Asia/Tokyo'), title: '個人の入力中' } };
      local.snapshot.drafts = [groupDraft, personalDraft]; screen.render(); await screen.press('予定を追加');
      assert.equal(opened.at(-1).value.title, '個人の入力中', 'the existing personal draft still takes precedence over a group draft when adding');
    } finally { screen.unmount(); }
  });
  test(`${platform} closing the calendar editor preserves the browsed year despite a native zero offset`, async () => {
    let closeEditor;
    const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { platform, exportName: 'PlannerCalendar', effectDependencies: true,
      layoutEffect: callback => callback(), props: {
        today: '2026-10-31', timeZone: 'Asia/Tokyo', local: { database: {}, snapshot: { events: [], exceptions: [], categories: [], drafts: [] } },
        dayInfo: () => ({ loaded: true, pending: 0, total: 0 }), renderChores: () => null,
      }, mocks: { '@/features/calendar/calendar-editor': { CalendarEditor: props => { closeEditor = props.onClose; return null; } } } });
    const list = () => screen.nodes().find(node => node.props.testID === 'calendar-year').props;
    const scrollTo = y => list().onScroll({ nativeEvent: { contentOffset: { y } } });
    const label = () => screen.button('表示する年と月を選択').props.accessibilityValue.text;
    try {
      await screen.press('年表示に戻る');
      const restorations = [];
      list().ref.current = { scrollToOffset: value => restorations.push(value) };
      const index = list().data.findIndex(row => row.year === 2033 && row.quarter === 1);
      const offset = list().getItemLayout(list().data, index).offset + 28;
      list().onScrollBeginDrag(); scrollTo(offset); await screen.flush();
      assert.equal(label(), '2033年');
      await screen.press('予定を追加');
      assert.equal(list().scrollEnabled, false);
      scrollTo(0); await screen.flush(); assert.equal(label(), '2033年');
      closeEditor(); await screen.flush();
      scrollTo(0); await screen.flush();
      assert.deepEqual(restorations.at(-1), { offset, animated: false });
      assert.equal(label(), '2033年');
      list().onScrollBeginDrag(); scrollTo(0); await screen.flush();
      assert.equal(label(), '1900年', 'explicit scrolling can still reach the first year');
    } finally { screen.unmount(); }
  });
  test(`${platform} swiping the mode strip changes views without moving the selected date`, async () => {
    const selected = []; const screen = make({ onSelectDate: date => selected.push(date) }); await selectCalendarView(screen, '1日表示');
    const swipe = { dx: -80, dy: 2, x0: 200, moveX: 120, numberActiveTouches: 1 };
    const strip = () => screen.nodes().find(node => node.props.testID === 'calendar-view-modes');
    strip().props.onTouchStart();
    assert.equal(strip().props.onMoveShouldSetPanResponderCapture(null, swipe), true);
    strip().props.onPanResponderRelease(null, swipe); screen.render(); assert.equal(screen.button('カレンダーの表示を選択').props.accessibilityValue.text, '2日');
    for (const label of ['3日', '7日', 'リスト']) { strip().props.onPanResponderRelease(null, swipe); screen.render(); assert.equal(screen.button('カレンダーの表示を選択').props.accessibilityValue.text, label); }
    assert.deepEqual(selected, [], 'a view choice does not silently select a different civil date');
  });
  test(`${platform} native horizontal swipes shift one day in each detailed view and ignore cancelled diagonal and multi-touch gestures`, async () => {
    for (const [mode, next] of [['1日表示', '2026-12-11'], ['2日表示', '2026-12-11'], ['3日表示', '2026-12-11']]) {
      const selected = []; const screen = make({ onSelectDate: date => selected.push(date) });
      try {
        await selectCalendarView(screen, mode);
        const gesture = () => screen.nodes().find(node => node.type === 'NativeGestureDetector').props.gesture;
        const activate = () => gesture().onActivate({ x: 184, translationX: -16, numberOfPointers: 1 });
        const finish = (patch = {}) => gesture().onDeactivate({ x: 100, translationX: -100, translationY: 2, numberOfPointers: 1, canceled: false, ...patch });
        activate(); finish({ canceled: true }); assert.deepEqual(selected, []);
        activate(); finish({ translationY: 150 }); assert.deepEqual(selected, []);
        activate(); gesture().onUpdate({ numberOfPointers: 2 }); finish(); assert.deepEqual(selected, []);
        activate(); finish(); finish(); await screen.flush(); assert.deepEqual(selected, [next]);
        gesture().onActivate({ x: 216, translationX: 16, numberOfPointers: 1 });
        finish({ translationX: 100 }); await screen.flush(); assert.deepEqual(selected, [next, '2026-12-10']);
        activate(); finish({ translationX: -10 }); assert.equal(selected.length, 2);
      } finally { screen.unmount(); }
    }
  });
  test(`${platform} detail calendars omit known empty chores while preserving unavailable and partial states`, async () => {
    let info = { loaded: true, total: 0, pending: 0 };
    const screen = make({ dayInfo: () => info, renderWaste: () => null, renderChores: () => '家事の取得操作' });
    try {
      for (const mode of ['1日表示', '2日表示', 'リスト表示']) {
        info = { loaded: true, total: 0, pending: 0 }; await selectCalendarView(screen, mode);
        assert.ok(!screen.text().includes('家事なし'));
        assert.ok(!screen.text().includes('家事を確認中'), 'a loaded zero is not presented as still loading when waste uses a custom renderer');
        assert.ok(!screen.nodes().some(node => node.props.accessibilityLabel?.includes('の家事を開く')));
        info = { loaded: false }; screen.render();
        assert.ok(screen.text().includes('未取得'));
        assert.ok(!screen.text().includes('家事 0件'));
        const unavailable = screen.nodes().find(node => node.props.accessibilityRole === 'button' && node.props.accessibilityValue?.text === '未取得');
        assert.ok(unavailable, 'an unavailable day keeps its accessible chore retrieval action');
        await screen.press(unavailable.props.accessibilityLabel);
        assert.ok(screen.text().includes('家事の取得操作'));
        info = { loaded: true, total: 0, pending: 0, partial: true }; screen.render();
        assert.ok(screen.text().includes('一部未取得'));
        assert.ok(!screen.text().includes('家事 0件'));
        assert.ok(screen.nodes().some(node => node.props.accessibilityValue?.text === '一部未取得' && node.props.accessibilityState?.expanded));
        info = { loaded: true, total: 2, pending: 1, partial: true }; screen.render();
        assert.ok(screen.text().includes('一部未取得'));
        assert.ok(screen.text().includes('家事 2件'));
        assert.ok(screen.text().includes('家事の取得操作'), 'receiving partial counts does not close the open chore list');
        info = { loaded: true, total: 2, pending: 1 }; screen.render();
        assert.ok(screen.text().includes('家事 2件'));
        assert.ok(!screen.text().includes('未取得'));
        await screen.press(unavailable.props.accessibilityLabel.replace('開く', '閉じる'));
      }
    } finally { screen.unmount(); }
  });
  test(`${platform} month cells distinguish unavailable partial and zero while total and pending remain separate`, async () => {
    const screen = make({ selectedDate: '2026-10-31', dayInfo: date => date === '2026-10-31' ? { loaded: true, total: 3, pending: 1 }
      : date === '2026-10-30' ? { loaded: true, total: 2, pending: 2, partial: true }
        : date === '2026-10-29' ? { loaded: true, total: 0, pending: 0 }
          : date === '2026-10-28' ? { loaded: true, total: 0, pending: 0, partial: true } : { loaded: false } });
    await scrollCalendarToDate(screen, '2026-10-31');
    const labels = screen.nodes().map(node => node.props.accessibilityLabel ?? '').filter(label => label.includes('2026年10月'));
    assert.ok(labels.some(label => label.includes('31日') && label.includes('家事3件') && label.includes('未完了1件')));
    assert.ok(labels.some(label => label.includes('30日') && label.includes('一部は未取得')));
    assert.ok(labels.some(label => label.includes('29日') && label.includes('家事0件') && label.includes('未完了0件')));
    assert.ok(labels.some(label => label.includes('28日') && label.includes('一部は未取得')));
    assert.ok(screen.text().includes('一部未取得'));
    assert.ok(screen.text().includes('未取得'));
  });
}
