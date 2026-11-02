import type { NextChoreWidgetDisplayProps } from '@/features/widgets/contracts';

/** Keep the fallback extension aligned with native .tsx files so Metro selects native widgets first. */
const NextChoreWidget = {
  updateSnapshot(_snapshot: NextChoreWidgetDisplayProps): void {},
  updateTimeline(_entries: { date: Date; props: NextChoreWidgetDisplayProps }[]): void {},
  async getTimeline(): Promise<{ date: Date; props: NextChoreWidgetDisplayProps }[]> {
    return [];
  },
};

export default NextChoreWidget;
