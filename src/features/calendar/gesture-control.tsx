import { PanResponder } from 'react-native';
import type { PanResponderGestureState } from 'react-native';

/** Native invokes these after a gesture; committed handlers are installed in a layout effect. */
export function createCalendarGesture() {
  let canStart = (_gesture: PanResponderGestureState) => false;
  let release = (_gesture: PanResponderGestureState) => {};
  const control = PanResponder.create({ onMoveShouldSetPanResponderCapture: (_event, gesture) => canStart(gesture),
    onPanResponderRelease: (_event, gesture) => release(gesture), onPanResponderTerminationRequest: () => true });
  return { panHandlers: control.panHandlers, update: (handlers: { canStart: typeof canStart; release: typeof release }) => { canStart = handlers.canStart; release = handlers.release; } };
}
