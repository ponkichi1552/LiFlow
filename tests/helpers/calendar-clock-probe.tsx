import { subscribeCalendarClock, useCalendarClock } from '../../src/features/calendar/use-calendar-clock';

export default function CalendarClockProbe({ inspect }: { inspect: (subscribe: typeof subscribeCalendarClock) => void }) {
  useCalendarClock(false);
  inspect(subscribeCalendarClock);
  return null;
}
