import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { selectCalendarView } from './helpers/calendar-ui.mjs';
import { newEventDraft } from '../src/domain/calendar/events.ts';
import { isOwnBirthdayOn, OWN_BIRTHDAY_EVENT_ID } from '../src/domain/calendar/own-birthday.ts';
import { plannerLightColors, plannerDarkColors } from '../src/components/planner-theme.ts';
import { contrastRatio } from './helpers/color-contrast.mjs';

const date = '2026-11-14';
const birthday = (id = OWN_BIRTHDAY_EVENT_ID, day = '2000-11-14') => ({ ...newEventDraft(day, 'Asia/Tokyo', true), id, title: id === OWN_BIRTHDAY_EVENT_ID ? '誕生日' : '友人の誕生日', revision: 1 });
const descendants = node => [node, ...(node.children ?? []).filter(child => typeof child === 'object').flatMap(descendants)];
const content = node => typeof node === 'string' ? node : (node.children ?? []).map(content).join('');

test('birthday celebration belongs only to the registered person and follows existing recurrence exceptions', () => {
  assert.equal(isOwnBirthdayOn(date, []), false);
  assert.equal(isOwnBirthdayOn(date, [birthday('someone-else')]), false);
  const events = [birthday(), birthday('someone-else')]; const original = structuredClone(events);
  assert.equal(isOwnBirthdayOn(date, events), true);
  assert.equal(isOwnBirthdayOn('2026-11-15', events), false);
  assert.equal(isOwnBirthdayOn(date, events, [{ eventId: OWN_BIRTHDAY_EVENT_ID, anchorDate: date, override: null, revision: 1 }]), false);
  assert.deepEqual(events, original);
});

test('birthday celebration does not move February 29 to a different civil date', () => {
  const events = [birthday(OWN_BIRTHDAY_EVENT_ID, '2000-02-29')];
  assert.equal(isOwnBirthdayOn('2028-02-29', events), true);
  assert.equal(isOwnBirthdayOn('2027-02-28', events), false);
  assert.equal(isOwnBirthdayOn('2027-03-01', events), false);
});

test('home birthday observes the startup cache without reading storage or requesting sync', () => {
  let provided = null; let reads = 0;
  const forbidden = () => { reads++; throw new Error('birthday display must reuse the cache'); };
  const { useOwnBirthday } = loadNativeModule('src/features/calendar/use-local-calendar.tsx', {
    react: { createContext: () => ({}), useContext: () => provided, useMemo: callback => callback() },
    'react/jsx-runtime': {}, 'react-native': {}, 'expo-sqlite': {},
    '../../platform/storage/calendar-events': { EMPTY_LOCAL_CALENDAR: {}, readLocalCalendar: forbidden, subscribeLocalCalendar: forbidden },
    './observed-snapshot': {}, './use-personal-google-sync': { usePersonalGoogleSync: forbidden },
    '@/hooks/use-planner-data': { usePlannerData: forbidden }, './private-event-projection': {},
    '../../domain/calendar/own-birthday': { isOwnBirthdayOn },
    '@/contexts/workspace-context': { WorkspaceContext: {} },
    './reminder-preferences': { calendarReminderScope: forbidden }, './use-calendar-draft-access': {},
    '../../platform/storage/calendar-reminders': { recoverCalendarReminderUndos: forbidden },
    '../../platform/storage/calendar-event-rows': { CalendarHistoryLimitError: Error },
    '../../domain/scheduling/local-date': { localDateFromDate: forbidden, addDays: forbidden }, './events': { calendarMonth: forbidden },
  });
  assert.equal(useOwnBirthday(date), false);
  provided = { snapshot: { events: [birthday()], exceptions: [] } }; assert.equal(useOwnBirthday(date), true);
  provided = { snapshot: { events: [], exceptions: [] } }; assert.equal(useOwnBirthday(date), false);
  assert.equal(reads, 0);
});

test('birthday greeting and cake date keep readable contrast in both themes', () => {
  for (const colors of [plannerLightColors, plannerDarkColors]) {
    assert.ok(contrastRatio(colors.calendarToday, colors.warningSoft) >= 4.5);
    assert.ok(contrastRatio(colors.surface, colors.calendarToday) >= 4.5);
  }
});

for (const platform of ['ios', 'android']) for (const workspaceName of [undefined, '家族']) test(`${platform} ${workspaceName ? 'group' : 'personal'} home celebrates only the viewer birthday and restores normal header next day`, async t => {
  const events = [birthday()]; const props = { today: date, workspaceName }; const destinations = [];
  const screen = screenHarness('src/components/home-ui.tsx', { exportName: 'HomeHeader', platform, props, mocks: {
    '../features/calendar/use-local-calendar': { useOwnBirthday: day => isOwnBirthdayOn(day, events) },
    'expo-router': { router: { push: path => destinations.push(path) } },
  } }); t.after(() => screen.unmount());
  assert.match(screen.text(), /お誕生日おめでとう！/);
  await screen.press('設定を開く'); assert.deepEqual(destinations, ['/settings']);
  props.today = '2026-11-15'; screen.render(); assert.doesNotMatch(screen.text(), /お誕生日/);
  props.today = date; props.birthdayDate = '2026-11-15'; screen.render(); assert.doesNotMatch(screen.text(), /お誕生日/);
  props.birthdayDate = date; events.splice(0, 1, birthday('someone-else')); screen.render(); assert.doesNotMatch(screen.text(), /お誕生日/);
});

for (const platform of ['ios', 'android']) test(`${platform} birthday month marker preserves appointment slots and detail birthday editing`, async t => {
  const events = [birthday(), ...Array.from({ length: 3 }, (_, i) => ({ ...newEventDraft(date, 'Asia/Tokyo'), id: `event-${i}`, title: `予約${i + 1}`, revision: 1 }))];
  const original = structuredClone(events); let writes = 0;
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', { exportName: 'PlannerCalendar', platform, props: {
    today: date, timeZone: 'Asia/Tokyo', dayInfo: () => ({ loaded: true, total: 0, pending: 0 }), renderChores: () => null,
    local: { database: {}, snapshot: { events, exceptions: [], categories: [], drafts: [], draft: null }, refresh: async () => {}, saveEvent: async () => { writes++; } },
  } }); t.after(() => screen.unmount());
  const day = screen.nodes().find(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.endsWith('自分の誕生日'));
  assert.ok(day);
  const cell = screen.nodes().find(node => node.children?.includes(day));
  assert.ok(cell); assert.doesNotMatch(content(cell), /誕生日/);
  assert.ok(descendants(cell).some(node => node.type === 'Text' && content(node) === '14'));
  assert.match(content(cell), /予約1/); assert.match(content(cell), /予約2/); assert.match(content(cell), /予約3/);
  assert.equal(day.props.accessibilityState.selected, true);
  for (const mode of ['1日表示', '2日表示', 'リスト表示']) {
    await selectCalendarView(screen, mode); screen.button('誕生日を編集');
  }
  assert.equal(writes, 0); assert.deepEqual(events, original);
});
