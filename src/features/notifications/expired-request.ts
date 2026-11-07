/** The OS must never receive an elapsed reminder as a new immediate request. */
export class ExpiredNotificationRequestError extends Error {
  constructor(reason: 'time' | 'access' = 'time') { super(reason === 'access' ? '契約の確認期限を過ぎるため予約しませんでした。' : '通知時刻を過ぎたため予約しませんでした。'); this.name='ExpiredNotificationRequestError'; }
}
