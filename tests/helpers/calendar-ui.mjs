import assert from 'node:assert/strict';
import { addDays, formatJapaneseDate } from '../../src/domain/scheduling/local-date.ts';

/** Model an actual native scroll, date tap and optional expansion on the real screen. */
export async function scrollCalendarToDate(screen, date) {
  let list = screen.nodes().find(node => node.props.testID === 'calendar-weeks');
  if (!list) { await screen.press('月表示に戻る'); list = screen.nodes().find(node => node.props.testID === 'calendar-weeks'); }
  assert.ok(list, 'the month must have its native virtualized week list');
  const index = list.props.data.findIndex(start => start <= date && date < addDays(start, 7)); assert.ok(index >= 0, `date outside native test window: ${date}`);
  list.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: list.props.getItemLayout(list.props.data, index).offset } } }); screen.render();
}
export async function openCalendarDay(screen, date, { chores = true } = {}) {
  await scrollCalendarToDate(screen, date);
  const day = screen.nodes().find(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.startsWith(`${formatJapaneseDate(date, { year: true })}、`));
  assert.ok(day, `missing visible calendar date ${date}`); await day.props.onPress(); await screen.flush();
  const expand = `${formatJapaneseDate(date, { year: true })}の家事を開く`;
  if (chores && screen.nodes().some(node => node.props.accessibilityLabel === expand)) await screen.press(expand);
}
export async function moveCalendarMonth(screen, direction) {
  const list = screen.nodes().find(node => node.props.testID === 'calendar-weeks'); assert.ok(list);
  list.props.onAccessibilityAction({ nativeEvent: { actionName: direction > 0 ? 'increment' : 'decrement' } }); await screen.flush();
}
