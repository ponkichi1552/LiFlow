import {
  AndroidImportance,
  cancelScheduledNotificationAsync,
  getPermissionsAsync,
  getAllScheduledNotificationsAsync,
  requestPermissionsAsync,
  scheduleNotificationAsync,
  setNotificationChannelAsync,
  SchedulableTriggerInputTypes,
} from 'expo-notifications';
import { Platform } from 'react-native';
import { ExpiredNotificationRequestError } from '../../features/notifications/expired-request';

import type {
  LocalNotificationGateway,
  LocalNotificationRequest,
} from '@/features/notifications/contracts';

export class ExpoLocalNotificationGateway implements LocalNotificationGateway {
  readonly maximumScheduledRequests = Platform.OS === 'ios' ? 60 : undefined;
  private permissionRequest: Promise<boolean> | null = null;
  async schedulingDeadline(): Promise<number> { return (await import('../subscription/runtime')).subscriptionAccessDeadline(); }

  async requestPermission(): Promise<boolean> {
    if (this.permissionRequest) return this.permissionRequest;
    const request = this.requestPermissionOnce();
    this.permissionRequest = request;
    try {
      return await request;
    } finally {
      if (this.permissionRequest === request) this.permissionRequest = null;
    }
  }

  private async requestPermissionOnce(): Promise<boolean> {
    if (Platform.OS === 'android') {
      await setNotificationChannelAsync('housework-reminders', {
        name: '家事のお知らせ',
        importance: AndroidImportance.DEFAULT,
      });
    }
    const current = await getPermissionsAsync();
    if (current.granted) {
      return true;
    }
    if (!current.canAskAgain) {
      return false;
    }

    const requested = await requestPermissionsAsync();
    return requested.granted;
  }

  async hasPermission(): Promise<boolean> {
    return (await getPermissionsAsync()).granted;
  }

  async getScheduledRequests(): Promise<readonly LocalNotificationRequest[]> {
    return (await getAllScheduledNotificationsAsync()).map((notification) => {
      const { __houseworkFireAt, ...data } = notification.content.data ?? {};
      return {
        key: notification.identifier,
        title: notification.content.title ?? '',
        body: notification.content.body ?? '',
        ...(notification.content.subtitle ? { subtitle: notification.content.subtitle } : {}),
        fireAt: typeof __houseworkFireAt === 'string' ? __houseworkFireAt : '',
        data: data as LocalNotificationRequest['data'],
      };
    });
  }

  async schedule(request: LocalNotificationRequest): Promise<string> {
    const fireAt = new Date(request.fireAt);
    if (Number.isNaN(fireAt.getTime())) {
      throw new RangeError(`Invalid notification date: ${request.fireAt}`);
    }
    if (fireAt.getTime() >= await this.schedulingDeadline()) throw new ExpiredNotificationRequestError('access');
    if (fireAt.getTime() <= Date.now()) throw new ExpiredNotificationRequestError();

    return scheduleNotificationAsync({
      identifier: request.key,
      content: {
        title: request.title,
        ...(request.subtitle ? { subtitle: request.subtitle } : {}),
        body: request.body,
        data: { ...request.data, __houseworkFireAt: request.fireAt },
        color: '#4AADE0',
      },
      trigger: {
        type: SchedulableTriggerInputTypes.DATE,
        date: fireAt,
        channelId: 'housework-reminders',
      },
    });
  }

  async cancel(notificationId: string): Promise<void> {
    await cancelScheduledNotificationAsync(notificationId);
  }
}

export const expoLocalNotificationGateway = new ExpoLocalNotificationGateway();
