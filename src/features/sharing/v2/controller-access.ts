import type { V2GroupController } from './controller.ts';
import { captureV2Input } from './input-capture.ts';

/** Keep the command API intact while checking the live workspace before each user action. */
export function guardV2GroupController(controller: V2GroupController, authorize: (editing: boolean) => Promise<void>): V2GroupController {
  const actions = Object.fromEntries(Object.entries(controller.actions).map(([name, command]) => [name, async (...args: unknown[]) => {
    const input = captureV2Input(args);
    await authorize(true); return Reflect.apply(command, undefined, input);
  }])) as V2GroupController['actions'];
  return { ...controller, actions, readCalendar: async () => {
    await authorize(false); return controller.readCalendar();
  }, readModel: async (range, readOptions) => {
    const input = typeof range === 'function' ? range : captureV2Input(range); const options = captureV2Input(readOptions);
    await authorize(false); return controller.readModel(input, options);
  } };
}
