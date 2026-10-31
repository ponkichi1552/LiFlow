import { useGroupCalendar } from '../../src/features/sharing/v2-ui/use-group-calendar';

export function CalendarSourceHost({ local, model, actions, capture }: {
  local: Parameters<typeof useGroupCalendar>[0]; model: Parameters<typeof useGroupCalendar>[1];
  actions: Parameters<typeof useGroupCalendar>[2]; capture: (value: ReturnType<typeof useGroupCalendar>) => void;
}) {
  capture(useGroupCalendar(local, model, actions, undefined, 'Test group'));
  return null;
}
