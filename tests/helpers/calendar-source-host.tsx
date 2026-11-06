import { useGroupCalendar } from '../../src/features/sharing/v2-ui/use-group-calendar';

export function CalendarSourceHost({ local, model, actions, capture, perform }: {
  local: Parameters<typeof useGroupCalendar>[0]; model: Parameters<typeof useGroupCalendar>[1];
  actions: Parameters<typeof useGroupCalendar>[2]; capture: (value: ReturnType<typeof useGroupCalendar>) => void;
  perform?: Parameters<typeof useGroupCalendar>[3];
}) {
  capture(useGroupCalendar(local, model, actions, perform, 'Test group'));
  return null;
}
