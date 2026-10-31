import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { AppButton, BackButton, Card, Page, ScreenHeading, typography } from '../../components/planner-ui';
import { useRouter } from 'expo-router';
import { openGoogleCalendarReadAudit } from '../../platform/sharing/google-calendar-read-audit';

function failureCode(value: unknown) {
  const names = ['CalendarPermissionRequiredError', 'GoogleSignInRequiredError', 'GoogleAccountMismatchError', 'GoogleOAuthConfigurationError'];
  if (value instanceof Error && names.includes(value.name)) return value.name;
  const code = value && typeof value === 'object' && 'code' in value ? value.code : undefined;
  return typeof code === 'string' && ['calendar_permission_required', 'calendar_api_not_enabled', 'calendar_rate_limited', 'calendar_invalid_response', 'calendar_internal_error'].includes(code) ? code : 'not_complete';
}

export default function GoogleCalendarReadPreview() {
  if (!__DEV__) return <Page><Card><Text style={typography.body}>開発ビルド専用です。</Text></Card></Page>;
  return <Audit />;
}
function Audit() {
  const router = useRouter(); const value = useRef<ReturnType<typeof openGoogleCalendarReadAudit> | null>(null); const alive = useRef(true); const running = useRef(false);
  const [ready, setReady] = useState(false); const [checked, setChecked] = useState(false); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const [proof, setProof] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; value.current = null; }; }, []);
  async function run(work: (audit: ReturnType<typeof openGoogleCalendarReadAudit>) => Promise<void>) {
    if (!alive.current || running.current) return; running.current = true; setBusy(true); setFailed(false); setErrorCode(null); setProof(null);
    try { value.current ??= openGoogleCalendarReadAudit(); await work(value.current); }
    catch (error) { if (alive.current) { setFailed(true); setErrorCode(failureCode(error)); } }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <Page header={<BackButton onPress={() => router.back()} />}><ScreenHeading title="実Google Calendarの読取検査" />
    <Card><Text style={typography.body}>この端末で選択中の本人の時間帯だけを読み取ります。予定・Tasksを書き換えず、時間帯をSQLite・Firebase・共有グループへ保存しません。画面には検査の件数だけを表示します。</Text>
      <AppButton title="この端末のGoogleログインを確認" disabled={busy} onPress={() => run(async audit => { const result = await audit.checkAccount(); if (alive.current) { setReady(result.ready); setChecked(true); } })} />
      {checked ? <Text testID="google-read-session" style={typography.label}>{ready ? 'Googleログインを確認済み' : 'Googleログインが見つかりません'}</Text> : null}
      {checked && !ready ? <AppButton title="明示してGoogleログインを復帰" disabled={busy} onPress={() => run(async audit => { const result = await audit.restoreAccount(); if (alive.current) setReady(result.ready); })} /> : null}
    </Card>
    {ready ? <Card><AppButton title="実Googleの181日分を読取検査" disabled={busy} onPress={() => run(async audit => {
      const result = await audit.read(); if (alive.current) setProof(`実Google Calendar読取 PASS：${result.days}日・${result.requests}通信・${result.intervals}区間`);
    })} />
      {failed ? <AppButton title="明示して時間帯の読取権限を確認" disabled={busy} variant="secondary" onPress={() => run(async audit => { await audit.authorize(); })} /> : null}
    </Card> : null}
    {proof ? <Card><Text testID="google-read-proof" style={typography.label}>{proof}</Text></Card> : null}
    {failed ? <Card><Text style={typography.body}>検査は未完了です。ログイン・時間帯の読取権限・ネットワークを確認してください。データは変更していません。</Text>
      <Text testID="google-read-error" style={typography.caption}>検査コード：{errorCode}</Text></Card> : null}
  </Page>;
}
