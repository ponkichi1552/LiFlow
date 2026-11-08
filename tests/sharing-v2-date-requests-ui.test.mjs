import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { decisionFixture, range } from './helpers/sharing-v2-decision-fixture.mjs';
import { groupId, draft, seeds, receiptsFor, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { ref } from './helpers/sharing-v2-decision-fixture.mjs';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { v2TargetLabel } from '../src/features/sharing/v2-ui/target-form.ts';
import { listSharingOutbox, loadSharedFacts, applyReceivedSharedFacts } from '../src/platform/storage/sharing-ledger.ts';

const file = 'src/features/sharing/v2-ui/date-requests.tsx';
async function ui(f, who, platform, extra = {}) {
  const controller = who === 'owner' ? f.a : f.b;
  const props = { model: await controller.readModel(range), actions: controller.actions, busy: false,
    run: async (work) => { await work(); props.model = await controller.readModel(range); }, ...extra };
  const screen = screenHarness(file, { exportName: 'V2DateRequests', props, platform });
  return { props, screen, update: async () => { props.model = await controller.readModel(range); screen.render(); } };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 cancellation review shows its actual intent and keeps the manual date until receipt-backed removal`, async () => {
    const f = await decisionFixture({ cancellation: true });
    try {
      const { screen, update } = await ui(f, 'owner', platform); assert.ok(screen.text().includes('日時指定の解除申請'));
      assert.ok(screen.text().includes('解除後の期限計算の基準')); assert.ok(!screen.text().includes('申請した日時'));
      await screen.press('日時指定の解除を承認'); assert.ok(screen.text().includes('回答を端末に保存'));
      assert.equal((await f.a.readModel(range)).plan.occurrences[0].subjects[0].formalDate.kind, 'manual');
      await f.deliver(f.owner); await update(); await screen.press('最新の申請内容を表示');
      assert.ok(screen.text().includes('選択した範囲の日時指定を解除しました')); assert.ok(!screen.text().includes('確定した日時'));
      assert.equal((await f.b.readModel(range)).plan.occurrences[0].subjects[0].formalDate.kind, 'automatic');
    } finally { f.close(); }
  });
  for (const embedded of [false, true]) test(`${platform} v2 request approval is explicitly saved and remains awaiting until its server receipt arrives embedded=${embedded}`, async () => {
    const f = await decisionFixture();
    try {
      const { screen, update } = await ui(f, 'owner', platform, { embedded }); const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      assert.ok(screen.text().includes('正式な日時：2026年10月30日')); assert.ok(screen.text().includes('申請した日時：2026年10月31日'));
      assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      await screen.press('日時変更を承認'); assert.ok(screen.text().includes('回答を端末に保存しました'));
      assert.equal((await f.a.readModel(range)).requests[0].kind, 'awaiting');
      await screen.press('最新の申請内容を表示'); assert.ok(screen.text().includes('回答を端末に保存しています'));
      assert.equal(screen.nodes().some((node) => node.props.accessibilityLabel === '日時変更を承認'), false);
      await f.deliver(f.owner); await update(); await screen.press('最新の申請内容を表示');
      assert.ok(screen.text().includes('承認済み')); assert.ok(screen.text().includes('確定した日時：2026年10月31日'));
      assert.equal((await f.b.readModel(range)).requests[0].kind, 'approved');
    } finally { f.close(); }
  });
  test(`${platform} v2 administrator counteroffer and the actual members consent confirm without a second administrator approval`, async () => {
    const f = await decisionFixture();
    try {
      const owner = await ui(f, 'owner', platform);
      await owner.screen.press('代替日時を提案…'); await owner.screen.change('実施日', '2026-11-01');
      const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      await owner.screen.press('代替案を送らず戻る'); assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      await owner.screen.press('代替日時を提案…'); await owner.screen.press('この日時を代替案として送る'); await f.deliver(f.owner);
      let model = await f.a.readModel(range); assert.equal(model.requests[0].kind, 'counteroffered'); assert.deepEqual(model.requests[0].formal, { precision: 'date', date: '2026-10-30' });
      assert.equal(model.requestReviews[0].acceptableCounterofferIds.length, 0);
      const member = await ui(f, 'member', platform);
      assert.equal(member.screen.nodes().some((node) => node.props.accessibilityLabel === '日時変更を承認'), false);
      await member.screen.press('この代替日時を承諾（2026年11月1日）');
      assert.equal((await f.b.readModel(range)).requests[0].kind, 'counteroffered'); await f.deliver(f.member);
      model = await f.a.readModel(range); assert.equal(model.requests[0].kind, 'approved'); assert.deepEqual(model.requests[0].formal, { precision: 'date', date: '2026-11-01' });
      assert.equal((await f.owner.repository.readState()).assessment.view.ofType('requestDecision').length, 2);
    } finally { f.close(); }
  });
  test(`${platform} v2 request rejection retains the original formal date and its signed request history`, async () => {
    const f = await decisionFixture();
    try {
      const { screen } = await ui(f, 'owner', platform); await screen.press('日時変更を拒否'); await f.deliver(f.owner);
      const model = await f.b.readModel(range); assert.equal(model.requests[0].kind, 'rejected');
      assert.deepEqual(model.requests[0].formal, { precision: 'date', date: '2026-10-30' }); assert.equal(model.requests.length, 1);
      assert.equal(model.plan.history.length, 0); assert.equal(model.requestReviews[0].canCounteroffer, false);
    } finally { f.close(); }
  });
  test(`${platform} v2 an incoming answer disables the old request editor and retains its input until explicit review`, async () => {
    const f = await decisionFixture();
    try {
      const { screen, update } = await ui(f, 'owner', platform); await screen.press('代替日時を提案…'); await screen.change('実施日', '2026-11-01');
      await f.a.actions.decide(f.request.operationId, 'counteroffer', { precision: 'date', date: '2026-11-02' }); await update();
      assert.ok(screen.text().includes('入力は保持しています'));
      assert.equal(screen.nodes().find((node) => node.props.accessibilityLabel === '実施日').props.value, '2026-11-01');
      assert.equal(screen.button('この日時を代替案として送る').props.disabled, true);
      await screen.press('最新の申請内容を表示'); assert.ok(screen.text().includes('回答を端末に保存しています'));
      assert.equal(screen.nodes().some((node) => node.type === 'TextInput'), false);
    } finally { f.close(); }
  });
  test(`${platform} v2 a counteroffer saves the latest typed date before another render without autosaving input`, async () => {
    const f = await decisionFixture();
    try {
      const { screen } = await ui(f, 'owner', platform); await screen.press('代替日時を提案…');
      const field = screen.nodes().find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === '実施日');
      field.props.onChangeText('2026-11-01'); await screen.button('この日時を代替案として送る').props.onPress(); await screen.flush();
      const decision = (await f.owner.repository.readState()).assessment.view.ofType('requestDecision')[0];
      assert.deepEqual(decision.payload.target, { precision: 'date', date: '2026-11-01' });
      assert.equal(Object.hasOwn(decision.payload, 'expectedReviewRevision'), false);
    } finally { f.close(); }
  });
  test(`${platform} v2 counteroffer inputs require an explicit repeated-clock choice and preserve its exact instant`, async () => {
    const f = await decisionFixture({ fixed: true, timeZone: 'America/New_York' });
    try {
      const { screen } = await ui(f, 'owner', platform); await screen.press('代替日時を提案…');
      for (const [label, value] of [['実施日', '2026-11-01'], ['開始時刻', '01:30'], ['終了日', '2026-11-01'], ['終了時刻', '01:45']]) await screen.change(label, value);
      const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      await screen.press('この日時を代替案として送る'); assert.ok(screen.text().includes('どの時刻か')); assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      const choices = screen.nodes().filter((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '2回目（UTC-05:00）'); assert.equal(choices.length, 2);
      choices[0].props.onPress(); choices[1].props.onPress(); await screen.flush(); await screen.press('この日時を代替案として送る');
      const answer = (await f.owner.repository.readState()).assessment.view.ofType('requestDecision')[0];
      assert.deepEqual(answer.payload.target, { precision: 'interval', start: '2026-11-01T06:30:00.000Z', end: '2026-11-01T06:45:00.000Z' });
    } finally { f.close(); }
  });
  test(`${platform} v2 conflicting answers remain visible and require explicit review before a causal resolution`, async () => {
    const f = await decisionFixture({ secondOwner: true });
    try {
      await f.a.actions.decide(f.request.operationId, 'approve'); await f.c.actions.decide(f.request.operationId, 'reject');
      await f.deliver(f.owner, [f.owner, f.member, f.owner2]); await f.deliver(f.owner2, [f.owner, f.member, f.owner2]);
      const { screen } = await ui(f, 'owner', platform); assert.ok(screen.text().includes('回答が競合しています'));
      assert.ok(screen.text().includes('：承認')); assert.ok(screen.text().includes('：拒否'));
      assert.equal(screen.button('日時変更を承認').props.disabled, true);
      const flag = screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === '競合している回答を確認した'); flag.props.onPress(); await screen.flush();
      await screen.press('日時変更を承認'); await f.deliver(f.owner, [f.owner, f.member, f.owner2]);
      for (const controller of [f.a, f.b, f.c]) assert.equal((await controller.readModel(range)).requests[0].kind, 'approved');
      assert.equal((await f.owner.repository.readState()).assessment.view.ofType('requestDecision').length, 3);
    } finally { f.close(); }
  });
  test(`${platform} v2 an invalid date approval shows a usable error and never claims the request was saved or approved`, async () => {
    const f = await decisionFixture({ fixed: true });
    try {
      const configuration = seeds()[3].payload.configuration; configuration.policy = chorePolicyFromPreset('assigned', ['member']);
      await f.owner.repository.commit([draft('mop', 'chore', 'mop', { name: '水拭き', enabled: true }), draft('mop-cfg', 'chorePolicy', 'mop', { configuration })]);
      await f.a.actions.changeDate({ ...ref, choreId: 'mop' }, { mode: 'fixed', target: f.request.payload.proposed, confirmHighLoad: true });
      const { screen } = await ui(f, 'owner', platform); const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      await screen.press('日時変更を承認'); assert.ok(screen.text().includes('現在の家事回を確認し'));
      assert.equal(screen.text().includes('回答を端末に保存しました'), false); assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      assert.equal((await f.a.readModel(range)).requests[0].kind, 'awaiting');
    } finally { f.close(); }
  });
  test(`${platform} v2 D9 old-region requests remain answerable in their original region and an uninitialized group cannot answer`, async () => {
    const f = await decisionFixture();
    try {
      await f.owner.repository.commit([draft('updated-zone', 'settings', 'settings', { timeZone: 'America/New_York' })]);
      const { screen, props } = await ui(f, 'owner', platform);
      assert.ok(screen.text().includes('申請時の地域（Asia/Tokyo）を維持')); assert.equal(screen.button('日時変更を承認').props.disabled, false);
      props.model.plan.initialized = false; screen.render(); assert.ok(screen.text().includes('地域・共通設定を確認してから'));
      assert.equal(screen.button('日時変更を拒否').props.disabled, true);
    } finally { f.close(); }
  });
  for (const cancellation of [false, true]) test(`${platform} v2 D9 ${cancellation ? 'removal' : 'date'} approval keeps its original receipt deadline after a live region change and explicit review`, async () => {
    const f = await decisionFixture({ cancellation });
    try {
      const { screen, props, update } = await ui(f, 'owner', platform); const before = structuredClone(props.model.requests[0].deadline);
      await f.owner.repository.commit([draft('changed-region-during-review', 'settings', 'settings', { timeZone: 'America/New_York' })]);
      await update(); const button = cancellation ? '日時指定の解除を承認' : '日時変更を承認';
      assert.equal(screen.button(button).props.disabled, true, 'a changed group context must first be reviewed');
      await screen.press('最新の申請内容を表示'); assert.equal(screen.button(button).props.disabled, false);
      assert.deepEqual(props.model.requests[0].deadline, before); await screen.press(button); assert.ok(screen.text().includes('回答を端末に保存'));
      await f.deliver(f.owner); await update(); assert.equal(props.model.requests[0].kind, 'approved'); assert.deepEqual(props.model.requests[0].deadline, before);
      assert.equal(props.model.requests[0].timeZone, 'Asia/Tokyo');
      const round = props.model.plan.occurrences.find((entry) => entry.anchorDate === ref.anchorDate);
      assert.equal(round.subjects[0].formalDate.kind, cancellation ? 'automatic' : 'manual');
      if (!cancellation) assert.equal(round.subjects[0].formalDate.timeZone, 'Asia/Tokyo');
    } finally { f.close(); }
  });
  test(`${platform} v2 an expired request keeps an offline answer visibly unconfirmed and cannot offer approval controls`, async () => {
    const f = await decisionFixture();
    try {
      await f.a.actions.decide(f.request.operationId, 'approve');
      const [witness] = await f.b.actions.addChore('受信時刻の検査'); const facts = await loadSharedFacts(f.member.database, groupId);
      const receipts = receiptsFor(facts).map((receipt) => receipt.operationId === witness.operationId ? { ...receipt, receivedAtMs: Date.parse('2026-11-02T00:00:00Z') } : receipt);
      await applyReceivedSharedFacts(f.owner.database, groupId, facts, 'expiry-witness', f.owner.repository.project, undefined,
        now().getTime(), f.owner.repository.evidenceForServerReceipts(receipts));
      const { screen, props } = await ui(f, 'owner', platform); assert.equal(props.model.requests[0].kind, 'expired');
      assert.equal(props.model.requestReviews[0].pendingAnswer, true); assert.ok(screen.text().includes('この申請を自動で承認済みに戻しません'));
      assert.equal(screen.nodes().some((node) => node.props.accessibilityLabel === '日時変更を承認'), false);
      assert.deepEqual(props.model.requests[0].formal, { precision: 'date', date: '2026-10-30' }); assert.equal(props.model.plan.history.length, 0);
    } finally { f.close(); }
  });
  test(`${platform} v2 a new counteroffer warns about recent work and keeps the exception explicit through member consent`, async () => {
    const f = await decisionFixture({ intervalDays: 3, anchorDate: '2026-10-24' });
    try {
      await f.a.actions.complete({ ...ref, anchorDate: '2026-10-24' }); await f.deliver(f.owner);
      const { screen } = await ui(f, 'owner', platform); await screen.press('代替日時を提案…'); await screen.change('実施日', '2026-10-28');
      const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      await screen.press('この日時を代替案として送る'); assert.ok(screen.text().includes('最近実施されています'));
      assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      await screen.press('確認して回答を保存'); await f.deliver(f.owner);
      const member = await ui(f, 'member', platform); assert.ok(member.screen.text().includes('最近の実施があっても再指定'));
      await member.screen.press('この代替日時を承諾（2026年10月28日）'); assert.ok(member.screen.text().includes('最近実施されています'));
      await member.screen.press('確認して回答を保存'); await f.deliver(f.member);
      assert.equal((await f.a.readModel(range)).requests[0].formalOptions.allowDuringCooldown, true);
    } finally { f.close(); }
  });
  test(`${platform} v2 consent checks only the viewers Calendar and needs confirmation for its exact target`, async () => {
    const f = await decisionFixture({ fixed: true }); let reads = 0;
    try {
      const owner = await ui(f, 'owner', platform, { readOwnCalendar: async () => { throw new Error('Other assignees cannot use the owners calendar'); } });
      await owner.screen.press('代替日時を提案…'); await owner.screen.press('この日時を代替案として送る'); await f.deliver(f.owner);
      const member = await ui(f, 'member', platform, { readOwnCalendar: async () => { reads++; return { kind: 'conflict' }; } });
      const title = `この代替日時を承諾（${v2TargetLabel(f.request.payload.proposed, 'Asia/Tokyo', { includeYear: true })}）`;
      const before = (await listSharingOutbox(f.member.database, groupId)).length;
      await member.screen.press(title); assert.ok(member.screen.text().includes('指定する時間帯にはカレンダーに予定が入っています'));
      assert.equal((await listSharingOutbox(f.member.database, groupId)).length, before);
      await member.screen.press('確認して回答を保存'); await f.deliver(f.member);
      assert.equal(reads, 1); assert.equal((await f.a.readModel(range)).requests[0].kind, 'approved');
      const all = await loadSharedFacts(f.member.database, groupId); assert.equal(JSON.stringify(all).includes('calendarBinding'), false);
    } finally { f.close(); }
  });
  test(`${platform} v2 counteroffer warning acknowledgements cannot be reused after changing its input`, async () => {
    const f = await decisionFixture({ intervalDays: 3, anchorDate: '2026-10-24' });
    try {
      await f.a.actions.complete({ ...ref, anchorDate: '2026-10-24' }); await f.deliver(f.owner);
      const { screen } = await ui(f, 'owner', platform); await screen.press('代替日時を提案…'); await screen.change('実施日', '2026-10-28');
      await screen.press('この日時を代替案として送る'); const confirm = screen.button('確認して回答を保存');
      const input = screen.nodes().find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === '実施日');
      input.props.onChangeText('2026-10-29'); await confirm.props.onPress(); await screen.flush();
      assert.equal((await f.owner.repository.readState()).assessment.view.ofType('requestDecision').length, 0);
      await screen.press('この日時を代替案として送る'); assert.ok(screen.text().includes('最近実施されています'));
      await screen.press('確認して回答を保存');
      assert.deepEqual((await f.owner.repository.readState()).assessment.view.ofType('requestDecision')[0].payload.target, { precision: 'date', date: '2026-10-29' });
    } finally { f.close(); }
  });
  test(`${platform} v2 approval load warnings can be cancelled and a later scheduling change invalidates their old confirmation`, async () => {
    const f = await decisionFixture();
    try {
      await f.owner.repository.commit([draft('limit', 'settings', 'settings', { heavyDailyLimit: 1 }),
        draft('floor-load', 'chore', 'floor', { load: 'heavy' }), draft('mop', 'chore', 'mop', { name: '水拭き', load: 'heavy', enabled: true }),
        draft('mop-cfg', 'chorePolicy', 'mop', { configuration: seeds()[3].payload.configuration })]);
      await f.a.actions.changeDate({ ...ref, choreId: 'mop' }, { mode: 'day', target: { precision: 'date', date: '2026-10-31' }, confirmHighLoad: true });
      const { screen, update } = await ui(f, 'owner', platform);
      await screen.press('日時変更を承認'); assert.ok(screen.text().includes('家事の負荷が高く'));
      await screen.press('取り消す'); assert.equal((await f.owner.repository.readState()).assessment.view.ofType('requestDecision').length, 0);
      await screen.press('日時変更を承認'); const previous = screen.button('確認して回答を保存');
      await f.a.actions.complete({ ...ref, choreId: 'mop' }); const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      await previous.props.onPress(); await screen.flush(); await update();
      assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      assert.ok(screen.text().includes('入力は保持しています')); assert.equal(screen.button('日時変更を承認').props.disabled, true);
      assert.throws(() => screen.button('確認して回答を保存'), /missing button/);
    } finally { f.close(); }
  });
  test(`${platform} v2 stale own Calendar remains unknown instead of claiming that an accepted fixed target is free`, async () => {
    const f = await decisionFixture({ fixed: true });
    try {
      const [offer] = await f.a.actions.decide(f.request.operationId, 'counteroffer', f.request.payload.proposed); await f.deliver(f.owner);
      const { screen } = await ui(f, 'member', platform, { readOwnCalendar: async () => ({ kind: 'unknown', reason: 'stale' }) });
      await screen.press(`この代替日時を承諾（${v2TargetLabel(f.request.payload.proposed, 'Asia/Tokyo', { includeYear: true })}）`);
      assert.ok(screen.text().includes('最新の予定を確認できません')); assert.equal(screen.text().includes('重複なし'), false);
      const decision = (await f.member.repository.readState()).assessment.view.ofType('requestDecision').find((op) => op.authorUserId === 'member');
      assert.equal(decision.payload.referenceDecisionId, offer.operationId); assert.equal(Object.hasOwn(decision.payload, 'calendar'), false);
    } finally { f.close(); }
  });
}
