import { SettingsAction } from '../../../components/settings-controls';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { BackButton, Card, ChoiceChip, Page, ScreenHeading, SectionHeading, palette, typography } from '../../../components/planner-ui';
import { NumberInputField } from '../../../components/number-input-field';
import type { Weekday } from '../../../domain/shared/types';
import { useV2DraftLifecycle } from '../v2-ui/use-draft-lifecycle';
import { createPrivatePreferenceEditor } from './preference-editor';
import type { PrivatePlannerPreferences, SavedPrivatePlannerPreferences } from './preferences';
import { snapshotPrivatePlannerPreferences } from './preferences';
import type { PrivatePlannerPreferenceStore } from './preference-store';
import type { ReactNode } from 'react';
import { v2RegionChoices } from '../v2-ui/group-settings-fields';
import { V2Choices, V2TextField } from '../v2-ui/form-controls';
import type { PrivatePreferenceSync } from './preference-sync';
import { useAccountOperation } from '../../settings/account-operation';

type Session = { store: PrivatePlannerPreferenceStore; defaults: PrivatePlannerPreferences;
  sync?: { engine: PrivatePreferenceSync; synchronize(): Promise<unknown>; onConfigure?(): void } };
const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
export function PrivatePreferenceScreen({ load, onBack, notice, footer, syncOnly = false, embedded = false }: { load(): Promise<Session>; onBack(): void; notice?: ReactNode; footer?: ReactNode; syncOnly?: boolean; embedded?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  return <PrivatePreferenceLoader key={attempt} load={load} onBack={onBack} onReload={() => setAttempt(n => n + 1)} notice={notice} footer={footer} syncOnly={syncOnly} embedded={embedded} />;
}
function PrivatePreferenceLoader({ load, onBack, onReload, notice, footer, syncOnly, embedded }: { load(): Promise<Session>; onBack(): void; onReload(): void; notice?: ReactNode; footer?: ReactNode; syncOnly?: boolean; embedded: boolean }) {
  const [value, setValue] = useState<{ session: Session; saved: SavedPrivatePlannerPreferences | null } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    void load().then(async session => {
      if (!current) return; const saved = await session.store.read();
      const defaults = saved ? session.defaults : snapshotPrivatePlannerPreferences(session.defaults);
      if (current) setValue({ session: { ...session, defaults }, saved });
    })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [load]);
  if (value) return <PrivatePreferenceEditor {...value} onBack={onBack} onReload={onReload} notice={notice} footer={footer} syncOnly={syncOnly} embedded={embedded} />;
  if (embedded) return <View style={{ gap: 8 }}>{error ? <><Text accessibilityRole="alert" style={styles.error}>端末間同期の設定を読み込めませんでした。</Text>
    <SettingsAction placement={embedded ? 'panel' : 'page'} title="本人の設定を再読込" compact onPress={onReload} /></> : <ActivityIndicator accessibilityLabel="端末間同期の設定を確認中" color={palette.accent} />}</View>;
  return <Page header={<BackButton onPress={onBack} />}>{notice}<ScreenHeading title="本人の生活リズム" />
    {error ? <Card><Text accessibilityRole="alert" style={typography.body}>本人の保存済み設定を読み込めませんでした。データは保持しています。</Text>
      <SettingsAction placement={embedded ? 'panel' : 'page'} title="本人の設定を再読込" onPress={onReload} /></Card> : <ActivityIndicator color={palette.accent} />}</Page>;
}

function PrivatePreferenceEditor({ session, saved, onBack, onReload, notice, footer, syncOnly, embedded }: { session: Session; saved: SavedPrivatePlannerPreferences | null; onBack(): void; onReload(): void; notice?: ReactNode; footer?: ReactNode; syncOnly?: boolean; embedded: boolean }) {
  const accountOperation = useAccountOperation();
  const [store] = useState(() => createPrivatePreferenceEditor({ store: session.store, saved, defaults: session.defaults }));
  const { snapshot: state, navigateAfterSave } = useV2DraftLifecycle(store); const [reloadReview, setReloadReview] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false); const [syncError, setSyncError] = useState(false);
  const [syncStatus, setSyncStatus] = useState<Awaited<ReturnType<PrivatePreferenceSync['readStatus']>> | null>(null);
  useEffect(() => {
    if (!session.sync) return;
    let live = true; let generation = 0; const engine = session.sync.engine;
    const read = () => { const attempt = ++generation; void engine.readStatus().then(value => { if (live && attempt === generation) setSyncStatus(value); })
      .catch(() => { if (live && attempt === generation) setSyncError(true); }); };
    const stop = session.store.subscribe(read); read(); return () => { live = false; stop(); };
  }, [session]);
  const syncAction = async (work: () => Promise<unknown>) => {
    if (syncBusy || accountOperation && !accountOperation.acquire()) return; setSyncBusy(true); setSyncError(false);
    try {
      // Freeze edits for the whole action; a late sync reply must not discard fresh input during reload.
      if (!await store.flush()) return;
      await work(); onReload();
    }
    catch { setSyncError(true); store.resumeNavigation(); }
    finally { accountOperation?.release(); setSyncBusy(false); }
  };
  const raw = state.raw; const [regionSearch, setRegionSearch] = useState(''); const regions = v2RegionChoices(regionSearch, raw.timeZone);
  const change = (patch: Partial<typeof raw>) => store.change(value => ({ ...value, ...patch }));
  const back = () => { void navigateAfterSave(onBack); };
  const disabled = syncBusy || accountOperation?.busy === true;
  const configure = session.sync?.onConfigure;
  const Container = embedded ? View : Card;
  const quietSync = embedded && syncOnly && !syncError && !syncStatus?.nextRetryAt
    && (!syncStatus || !syncStatus.configured || ['empty', 'synchronized'].includes(syncStatus.kind));
  const content = <>{notice}
    {!embedded ? <ScreenHeading title={syncOnly ? "設定の端末間同期" : "本人の生活リズム"} description={syncOnly ? "同じアカウントの承認済み端末へ反映します。" : "本人向けの推奨に使う設定です。他のメンバーには公開されません。"} /> : null}
    {!embedded || state.hasDraft || ['saving', 'pending'].includes(state.status.phase) ? <Text accessibilityLiveRegion="polite" style={typography.caption}>{state.status.phase === 'saving' ? 'この端末に保存中…' : state.status.phase === 'pending' ? '入力した変更を保存待ちです。'
      : state.hasDraft ? '未保存の入力があります。' : state.revision > 0 ? 'この端末に保存済み' : '入力した内容は自動で保存されます。'}</Text> : null}
    {state.validation ? <Text accessibilityRole="alert" style={styles.error}>{state.validation}</Text> : null}
    {state.status.error ? <Card><Text accessibilityRole="alert" style={styles.error}>{state.status.error}</Text>
      <SettingsAction placement={embedded ? 'panel' : 'page'} title="保存を再試行" onPress={() => { void store.flush(); }} /></Card> : null}

    {session.sync && !quietSync ? <Container style={{ gap: 10 }}>{!embedded ? <SectionHeading title="本人端末との同期" /> : null}
      <Text accessibilityLiveRegion="polite" style={typography.body}>{embedded ? !syncStatus ? '確認中…' : !syncStatus.configured ? '端末未設定' : syncStatus.kind === 'conflict' ? '設定が競合しています。両方を保持しています。'
        : syncStatus.kind === 'synchronized' ? '同期済み' : syncStatus.kind === 'pending' ? '同期待ち' : '同期する変更はありません。'
        : !syncStatus ? '同期状態を確認しています。' : syncStatus.kind === 'conflict' ? '別の本人端末と設定が異なります。両方を保持しています。'
        : syncStatus.kind === 'synchronized' ? '本人端末へ反映できる状態です。各端末の受信には通信が必要です。'
          : syncStatus.kind === 'pending' ? 'この端末に保存済み・本人端末への反映待ちです。' : '本人端末へ反映する設定はまだありません。'}</Text>
      {syncStatus && !syncStatus.configured && !embedded ? <><Text style={typography.caption}>別の端末へ暗号化した設定を送るには、その端末の確認が必要です。通常の家事管理には不要です。</Text>
        {!embedded && configure ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="本人端末を確認する" disabled={disabled} onPress={() => { void navigateAfterSave(configure); }} /> : null}</> : null}
      {syncError ? <Text accessibilityRole="alert" style={styles.error}>同期を確認できませんでした。保存済みの設定と送信待ちは保持しています。</Text> : null}
      {syncStatus?.nextRetryAt ? <Text accessibilityRole="alert" style={styles.error}>前回の同期を確認できませんでした。保存済みの設定を保ち、再試行します。</Text> : null}
      {syncStatus?.review && syncStatus.local ? <>
        <PreferenceSummary title="この端末の設定" value={syncStatus.local} />
        <PreferenceSummary title="別の本人端末の設定" value={syncStatus.review.preferences} />
        <SettingsAction placement={embedded ? 'panel' : 'page'} title="この端末の設定を使う" compact={embedded} disabled={disabled} onPress={() => { void syncAction(() => session.sync!.engine.resolve(syncStatus.local!.revision, syncStatus.review!.cursor, 'local')); }} />
        <SettingsAction placement={embedded ? 'panel' : 'page'} title="別の本人端末の設定を使う" compact={embedded} disabled={disabled} onPress={() => { void syncAction(() => session.sync!.engine.resolve(syncStatus.local!.revision, syncStatus.review!.cursor, 'remote')); }} />
      </> : !embedded || syncStatus?.configured ? <SettingsAction placement={embedded ? 'panel' : 'page'} title={syncBusy ? '本人設定を同期中…' : embedded ? '今すぐ同期' : '本人設定を今すぐ同期'} compact={embedded} disabled={disabled || !syncStatus?.configured}
        onPress={() => { void syncAction(session.sync!.synchronize); }} /> : null}
    </Container> : null}
    {!syncOnly ? <Card><SectionHeading title="本人の地域" />
      <Text style={typography.body}>現在の地域：{raw.timeZone}</Text>
      <V2TextField label="本人の地域を検索" value={regionSearch} onChangeText={setRegionSearch} placeholder="東京、ニューヨーク" editable={!syncBusy} />
      <V2Choices label="本人の地域" choices={regions.choices} value={raw.timeZone} onChange={timeZone => change({ timeZone })} disabled={syncBusy} />
      {!regions.total ? <Text style={typography.caption}>一致する地域がありません。都市名で検索してください。</Text> : regions.total > 8 ? <Text style={typography.caption}>入力を追加すると地域を絞り込めます。</Text> : null}
      <Text style={typography.caption}>時刻はここで選んだ地域を基準にします。</Text>
      <SectionHeading title="本人の休日" level="subsection" />
      <View style={styles.choices}>{weekdays.map((label, index) => {
        const day = index + 1 as Weekday;
        return <ChoiceChip key={day} label={label} selected={raw.restDays.includes(day)} disabled={syncBusy} onPress={() => store.change(value => ({ ...value,
          restDays: value.restDays.includes(day) ? value.restDays.filter(selected => selected !== day) : [...value.restDays, day] }))} />;
      })}</View>
      <SectionHeading title="本人の1日あたりの負荷上限" level="subsection" />
      <View style={styles.limits}><Text style={typography.label}>重い家事</Text><NumberInputField accessibilityLabel="本人の重い家事の上限" suffix="件" value={raw.heavy}
        onChangeText={text => change({ heavy: text })} onBlur={() => { void store.flush(); }} maxLength={2} editable={!syncBusy} /></View>
      <View style={styles.limits}><Text style={typography.label}>普通の家事</Text><NumberInputField accessibilityLabel="本人の普通の家事の上限" suffix="件" value={raw.normal}
        onChangeText={text => change({ normal: text })} onBlur={() => { void store.flush(); }} maxLength={2} editable={!syncBusy} /></View>
    </Card> : null}
    {!embedded ? <SettingsAction placement={embedded ? 'panel' : 'page'} title="保存済みの本人設定を再読込" disabled={disabled} onPress={() => state.hasDraft ? setReloadReview(true) : onReload()} /> : null}
    {reloadReview ? <Card><Text style={typography.body}>未保存の入力を破棄して、保存済みの設定を読み込みますか？</Text>
      <SettingsAction placement={embedded ? 'panel' : 'page'} title="未保存の入力を破棄して再読込" onPress={() => { store.discardDraft(); void store.flush().then(success => { if (success) onReload(); }); }} />
      <SettingsAction placement={embedded ? 'panel' : 'page'} title="編集を続ける" onPress={() => setReloadReview(false)} /></Card> : null}
    {footer}
  </>;
  return embedded ? <View style={{ gap: 10 }}>{content}</View> : <Page header={<BackButton onPress={back} />}>{content}</Page>;
}
function PreferenceSummary({ title, value }: { title: string; value: PrivatePlannerPreferences }) {
  return <View style={{ gap: 3 }}><Text style={typography.label}>{title}</Text>
    <Text style={typography.caption}>{value.timeZone} · 休日：{value.restDays.map(day => weekdays[day - 1]).join('・') || 'なし'} · 重い{value.loadLimits.heavyDailyLimit}件／普通{value.loadLimits.normalDailyLimit}件</Text>
  </View>;
}
const styles = StyleSheet.create({
  error: { ...typography.caption, color: palette.warning }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  limits: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
});
