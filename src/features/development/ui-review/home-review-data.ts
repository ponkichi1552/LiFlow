import type { ChoreDefinition, ChoreScheduleEntry } from '../../../domain/chores/types';
import { createPersonalChoreDefinitions } from '../../../domain/chores/personal-catalog.ts';
import { DEFAULT_CALENDAR_COUNT_COLORS } from '../../../domain/calendar/count-colors.ts';
import { addDays } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types';
import type { PlannerSnapshot } from '../../../platform/storage/repository';
import { commonChoreLinks } from '../../planner/common-chore-links.ts';
import { projectV2PrivateTasks, type V2PrivateOverlayState } from '../../sharing/v2-ui/private-overlay.ts';
import type { V2GroupScreenModel } from '../../sharing/v2/controller';
import type { V2FormalDate, V2PlannedOccurrence, V2SubjectPlan } from '../../sharing/v2/common-plan';
import type { V2CompletionRecord } from '../../sharing/v2/completion-history';
import { showExpiredOnHome } from '../../sharing/v2/completion-state.ts';
import { chorePolicyFromPreset, createGroupPolicy } from '../../sharing/v2/model.ts';
import { buildV2PersonalPlan } from '../../sharing/v2/personal-plan.ts';

export const homeReviewScenarios = [
  { id: 'mixed', label: '個人・共有が混在する日' },
  { id: 'personal', label: '個人の家事と収集日' },
  { id: 'overdue', label: '期限間近・期限切れ' },
  { id: 'upcoming', label: '今週の残り・来週' },
  { id: 'completed', label: 'すべて完了した日' },
  { id: 'assignments', label: '担当者・日時指定' },
  { id: 'conditions', label: '承認待ち・実施条件・競合' },
  { id: 'empty', label: '家事がない日' },
  { id: 'empty-shared', label: '共有家事なし・個人の初期設定前' },
  { id: 'private-unavailable', label: '個人家事を取得できない日' },
  { id: 'time-zones', label: '個人・共有で日付が違う日' },
  { id: 'overflow', label: '長い名前・多数の家事' },
  { id: 'birthday', label: '誕生日と家事' },
  { id: 'weather', label: '天気で洗濯予定を調整した日' },
  { id: 'weather-unavailable', label: '天気予報を取得できない日' },
] as const;
type Scenario = typeof homeReviewScenarios[number]['id'];

// A Wednesday spanning New Year's Day gives both week tabs stable dates on every device.
export const homeReviewToday: LocalDate = '2026-12-30';
export const homeReviewGroup = 'ひより荘（サンプル）';
export const homeReviewViewer = 'review-aoi';
const groupId = 'home-review-group';
const privateHousehold = 'local-household';
const zone = 'Asia/Tokyo';
const members = [
  { userId: homeReviewViewer, displayName: 'あおい', active: true },
  { userId: 'review-minato', displayName: 'みなと', active: true },
  { userId: 'review-nagi', displayName: 'なぎ', active: true },
];
const range = { from: addDays(homeReviewToday, -7), through: addDays(homeReviewToday, 11), asOfDate: homeReviewToday };
const catalog = new Map(createPersonalChoreDefinitions(privateHousehold).map(chore => [chore.id, chore]));

type Assignment = 'open' | 'self' | 'other' | 'pair' | 'each' | 'rotation';
type Condition = 'cooldown' | 'approval' | 'strict' | 'claimConflict' | 'assignmentConflict' | 'assignmentMapping' | 'dateReview';
interface Sample {
  recipe: number; shared?: Assignment; day?: number; window?: [number, number]; done?: boolean;
  named?: string; once?: boolean; minutes?: number | null; load?: ChoreDefinition['load']; seasonal?: ChoreScheduleEntry['seasonalWork'];
  manual?: 'day' | 'deadline' | 'fixed' | 'foreign'; condition?: Condition; afterRecipe?: number;
}
const mixed: Sample[] = [
  { recipe: 4, once: true }, { recipe: 4, shared: 'self' },
  { recipe: 2, shared: 'open', day: -1, window: [-2, 0] },
  { recipe: 7, done: true }, { recipe: 34, shared: 'other', day: 1 },
  { recipe: 6, day: -2 }, { recipe: 8, day: 6 },
];
const samples: Record<Scenario, readonly Sample[]> = {
  mixed, personal: [{ recipe: 1 }, { recipe: 7, done: true }, { recipe: 27, seasonal: 'summerStorage' }, { recipe: 75, day: 2 }],
  overdue: [{ recipe: 2, shared: 'self', day: -1, window: [-3, 0] }, { recipe: 12, day: -2, window: [-3, 1] },
    { recipe: 7 }, { recipe: 31, day: -6 }, { recipe: 11, shared: 'self', day: -3, window: [-4, -2] }],
  upcoming: [{ recipe: 1, day: 1 }, { recipe: 24, shared: 'other', day: 2 }, { recipe: 7, day: 4 },
    { recipe: 1, day: 5 }, { recipe: 29, shared: 'each', day: 7, window: [6, 8] }, { recipe: 27, day: 10, seasonal: 'winterStorage' }],
  completed: [{ recipe: 7, done: true }, { recipe: 6, shared: 'self', done: true }, { recipe: 10, shared: 'other', done: true }],
  assignments: [{ recipe: 6, shared: 'open' }, { recipe: 64, shared: 'each' }, { recipe: 12, shared: 'pair', manual: 'fixed' },
    { recipe: 2, shared: 'other', manual: 'deadline' }, { recipe: 4, shared: 'rotation', manual: 'day' }, { recipe: 65, shared: 'self', manual: 'foreign' }],
  conditions: [{ recipe: 34, shared: 'self' }, { recipe: 35, shared: 'self', afterRecipe: 34 },
    { recipe: 4, shared: 'self', manual: 'day', condition: 'cooldown' }, { recipe: 61, shared: 'self', condition: 'approval' },
    { recipe: 65, shared: 'self', condition: 'strict', manual: 'fixed', done: true }, { recipe: 62, shared: 'open', condition: 'claimConflict' },
    { recipe: 11, shared: 'pair', condition: 'assignmentConflict' }, { recipe: 12, shared: 'pair', condition: 'assignmentMapping' },
    { recipe: 13, shared: 'self', condition: 'dateReview' }],
  empty: [], 'empty-shared': [], 'private-unavailable': [],
  'time-zones': [{ recipe: 1 }, { recipe: 31, shared: 'self', manual: 'foreign' }],
  overflow: [{ recipe: 60, shared: 'pair', manual: 'deadline', window: [-2, 0], load: 'heavy',
    named: '共用ワークスペースの電源タップと充電ケーブル（リビング・書斎・窓側デスク）の清掃と点検', minutes: 125 },
    { recipe: 41, named: '加湿器HiyoriSampleAirCareLivingRoomEditionのタンクとトレーを洗う', day: -1, window: [-2, 2], load: 'heavy', minutes: null },
    ...Array.from({ length: 36 }, (_, index): Sample => ({
      recipe: 10 + index, ...(index % 2 ? { shared: 'each' } : {}), done: index % 6 === 0,
    }))],
  birthday: [{ recipe: 6, shared: 'open' }, { recipe: 24, done: true }],
  weather: [{ recipe: 7, day: 1 }, { recipe: 8, day: 2 }, { recipe: 24 }],
  'weather-unavailable': [{ recipe: 7 }, { recipe: 24 }],
};

export interface HomeReviewEdits {
  completed: ReadonlyMap<string, boolean>;
  assignees: ReadonlyMap<string, readonly string[]>;
}
const noEdits: HomeReviewEdits = { completed: new Map(), assignees: new Map() };

function definition(sample: Sample, privateDate: LocalDate) {
  const recipeId = `liflow-catalog-6.${String(sample.recipe).padStart(3, '0')}`;
  const recipe = catalog.get(recipeId);
  if (!recipe) throw new Error(`ホームの確認用カタログに家事がありません（${recipeId}）。`);
  const id = sample.named ? `review-custom-${sample.recipe}` : recipeId;
  return { ...recipe, id: sample.shared ? `${groupId}.${id}` : id,
    householdId: sample.shared ? groupId : privateHousehold, enabled: true, name: sample.named ?? recipe.name, load: sample.load ?? recipe.load,
    ...(sample.once ? { personalSchedule: { startDate: privateDate, once: true } } : {}),
    ...(sample.minutes !== undefined ? { estimatedMinutes: sample.minutes ?? undefined } : {}) } satisfies ChoreDefinition;
}

function privateSnapshot(setupCompleted: boolean, today: LocalDate, timeZone: string, rows: readonly Sample[], edits: HomeReviewEdits): PlannerSnapshot {
  const chores = new Map<string, ChoreDefinition>();
  const entries: ChoreScheduleEntry[] = [];
  const completions: PlannerSnapshot['completions'] = [];
  for (const sample of rows) {
    if (sample.shared) continue;
    const chore = definition(sample, today); chores.set(chore.id, chore);
    const day = sample.day ?? 0;
    const suggestedDate = addDays(today, day);
    const windowStart = addDays(today, sample.window?.[0] ?? day);
    const windowEnd = addDays(today, sample.window?.[1] ?? day);
    const id = `${sample.seasonal ? 'seasonal' : 'personal'}-round.${chore.id}.${suggestedDate}`;
    entries.push({ id, choreId: chore.id, householdId: privateHousehold, cycleBaseDate: suggestedDate, suggestedDate, windowStart, windowEnd,
      status: windowEnd < today ? 'overdue' : windowStart > today ? 'scheduled' : 'inWindow', seasonalWork: sample.seasonal, assignedMemberIds: [] });
    if (edits.completed.get(id) ?? sample.done) completions.push({ id: `done.${id}`, householdId: privateHousehold, choreId: chore.id,
      scheduleEntryId: id, scheduledDate: suggestedDate, scheduledWindowStart: windowStart, scheduledWindowEnd: windowEnd,
      completedLocalDate: today, completedAt: `${today}T10:00:00.000Z`, completedTimeZone: timeZone, outcome: 'completed', seasonalWork: sample.seasonal });
  }
  return { today, timeZone, household: { id: privateHousehold, name: 'あおいの家（サンプル）', createdAt: '2026-01-01T00:00:00Z' },
    settings: { householdId: privateHousehold, setupCompleted, frequencyMode: 'balanced', restDays: [], heavyDailyLimit: 2, normalDailyLimit: 3,
      notificationHour: 8, notificationMinute: 0, notificationsEnabled: false, calendarCountColors: DEFAULT_CALENDAR_COUNT_COLORS, calendarCountDisplayMode: 'dots' },
    chores: [...chores.values()], scheduleEntries: entries, completions, states: [], appliances: [], members: [], assignments: [], dependencies: [],
    wasteSchedules: [], upcomingWasteDates: [], hiddenWasteDates: [], hiddenWasteOccurrenceKeys: [], weatherOutcome: 'disabled', weatherAdjustmentCount: 0 };
}

function formalDate(sample: Sample, date: LocalDate, id: string): V2FormalDate {
  if (sample.condition === 'dateReview') return { kind: 'conflict', ruleIds: [`${id}.a`, `${id}.b`] };
  if (!sample.manual) return { kind: 'automatic' };
  const fixed = sample.manual === 'fixed' || sample.manual === 'foreign';
  return { kind: 'manual', ruleId: id, equivalentRuleIds: [id], mode: fixed ? 'fixed' : sample.manual === 'deadline' ? 'deadline' : 'day',
    timeZone: sample.manual === 'foreign' ? 'Europe/London' : zone, strict: sample.condition === 'strict', allowDuringCooldown: false,
    target: fixed ? { precision: 'interval', start: `${date}T06:15:00Z`, end: `${date}T07:45:00Z` }
      : sample.manual === 'deadline' ? { precision: 'instant', at: `${date}T09:00:00Z` } : { precision: 'date', date } };
}

function sharedRecord(round: V2PlannedOccurrence, subject: V2SubjectPlan, pending: boolean): V2CompletionRecord {
  const author = pending || round.assigneeIds.includes('review-minato') && !round.assigneeIds.includes(homeReviewViewer) ? 'review-minato' : homeReviewViewer;
  const formal = subject.formalDate;
  return { operationId: (pending ? subject.pendingCompletionIds : subject.completionOperationIds)[0], occurrenceId: round.id,
    subjectOccurrenceId: subject.id, choreId: round.choreId, anchorDate: round.anchorDate, subjectUserId: subject.subjectUserId,
    originalAssigneeIds: subject.assigneeIds, performerUserId: author, recorderUserId: author,
    performedAt: `${homeReviewToday}T02:15:00Z`, recordedAt: `${homeReviewToday}T02:15:00Z`, active: true, outcome: 'completed',
    acceptance: pending ? 'pending' : 'accepted', approvalConflictIds: [], performedTimeConfirmed: false,
    instruction: formal.kind === 'manual' ? { kind: 'designated', ruleId: formal.ruleId, strict: formal.strict, mode: formal.mode, target: formal.target, timeZone: formal.timeZone }
      : { kind: 'automatic', timeZone: zone },
    schedule: { date: subject.suggestedDate, windowStart: subject.executionWindowStart, windowEnd: subject.executionWindowEnd,
      commonWindow: { start: round.windowStart, end: round.windowEnd } },
    fulfillment: subject.strictInstructionUnfulfilled ? 'earlier' : formal.kind === 'manual' ? 'fulfilled' : 'notApplicable',
    strictInstructionFulfilled: !subject.strictInstructionUnfulfilled };
}

function sharedModel(rows: readonly Sample[], edits: HomeReviewEdits) {
  const model: V2GroupScreenModel = { viewerUserId: homeReviewViewer, adminUserId: 'review-nagi', calendar: [], calendarSupported: true,
    manualStorageSupported: false, pendingChanges: 0, receiptPending: 0, quarantinedChanges: 0, choreDetails: [], configurations: [], requests: [],
    requestReviews: [], assignmentReviews: [], assignmentRequests: [], assignmentRules: [], dateRules: [], dateRuleSources: [],
    plan: { groupId, algorithm: 'ui-review', initialized: true, range, timeZone: zone, sourceHash: 'ui-review', planHash: 'ui-review',
      commonSettings: { name: homeReviewGroup }, policy: { ...createGroupPolicy('roommates'), allowSubstitution: false },
      members, history: [], occurrences: [], issues: [], chores: [], dependencies: [] } };
  for (const sample of rows) {
    const assignment = sample.shared; if (!assignment) continue;
    const chore = definition(sample, homeReviewToday);
    if (!model.plan.chores.some(item => item.id === chore.id)) model.plan.chores.push(chore);
    const day = sample.day ?? 0;
    const anchorDate = addDays(homeReviewToday, day);
    const id = `review-round.${chore.id}.${anchorDate}`;
    const windowStart = addDays(homeReviewToday, sample.window?.[0] ?? day);
    const windowEnd = addDays(homeReviewToday, sample.window?.[1] ?? day);
    const condition = sample.condition;
    const each = assignment === 'each';
    const candidates = assignment === 'pair' || assignment === 'rotation' ? [homeReviewViewer, 'review-minato']
      : assignment === 'other' ? ['review-minato'] : assignment === 'open' ? [] : [homeReviewViewer];
    const policy = assignment === 'open' ? chorePolicyFromPreset('common') : each ? chorePolicyFromPreset('eachMember')
      : chorePolicyFromPreset(assignment === 'rotation' ? 'rotation' : 'assigned', candidates);
    const assigneeIds = [...(edits.assignees.get(id) ?? (condition === 'claimConflict' ? [homeReviewViewer, 'review-minato']
      : assignment === 'rotation' ? [homeReviewViewer] : each ? members.map(member => member.userId) : candidates))];
    const completed = edits.completed.get(id) ?? Boolean(sample.done);
    const reportId = `review-report.${id}`;
    const dependency = model.plan.occurrences.find(round => sample.afterRecipe && round.choreId.endsWith(`.${String(sample.afterRecipe).padStart(3, '0')}`));
    const subject: V2SubjectPlan = { id: each ? `${id}.${homeReviewViewer}` : id, subjectUserId: each ? homeReviewViewer : null,
      required: true, assigneeIds: each ? [homeReviewViewer] : assigneeIds, suggestedDate: anchorDate, formalDate: formalDate(sample, anchorDate, id),
      executionWindowStart: windowStart, executionWindowEnd: windowEnd, completed, completionOperationIds: completed ? [reportId] : [],
      pendingCompletionIds: condition === 'approval' ? [reportId] : [], minimumNextExecutionDay: condition === 'cooldown' ? addDays(homeReviewToday, 2) : null,
      cooldownSuppressed: condition === 'cooldown' && !completed, virtuallyConsumed: !completed && windowEnd < homeReviewToday,
      strictInstructionUnfulfilled: condition === 'strict' && completed, showExpiredOnHome: !completed && showExpiredOnHome(windowEnd, homeReviewToday),
      requestReviewIds: [], dependencyAwaitingCompletion: Boolean(dependency && !dependency.completed && !completed),
      dependencyBlocked: false, dependencyNotBefore: null, dependencyNotBeforeInstant: null };
    const subjects = each ? members.map(member => member.userId === homeReviewViewer ? subject : { ...subject, id: `${id}.${member.userId}`,
      subjectUserId: member.userId, assigneeIds: [member.userId], completed: false, completionOperationIds: [] }) : [subject];
    const round: V2PlannedOccurrence = { id, choreId: chore.id, anchorDate, ruleVersion: 1, windowStart, windowEnd, completed: subjects.every(slot => slot.completed),
      configuration: { policy, anchorDate, intervalDays: condition === 'cooldown' ? 3 : 7, ruleVersion: 1, windowBeforeDays: day - (sample.window?.[0] ?? day), windowAfterDays: (sample.window?.[1] ?? day) - day },
      assigneeIds, subjectUserIds: each ? assigneeIds : [], claimState: condition === 'claimConflict' ? 'provisional' : assignment === 'open' ? assigneeIds.length ? 'claimed' : 'unassigned' : 'notApplicable',
      claimantUserIds: condition === 'claimConflict' ? [homeReviewViewer, 'review-minato'] : assignment === 'open' ? assigneeIds : [],
      subjects, historical: false, activeInPeriod: true, needsAssignment: condition === 'assignmentConflict' || condition === 'assignmentMapping', assignmentFixed: assignment !== 'open',
      assignmentConflictIds: condition === 'assignmentConflict' || condition === 'assignmentMapping' ? [`${id}.a`, `${id}.b`] : [],
      assignmentMappingReviewIds: condition === 'assignmentMapping' ? [`${id}.old`] : [], assignmentOperationIds: [], extensionRequestIds: [], claimOperationIds: [] };
    model.plan.occurrences.push(round);
    if (completed || condition === 'approval') model.plan.history.push(sharedRecord(round, subject, condition === 'approval'));
  }
  return model;
}

export function homeReviewData(id: string, edits: HomeReviewEdits = noEdits) {
  const scenario = homeReviewScenarios.find(item => item.id === id)?.id ?? 'mixed';
  const rows = samples[scenario];
  const shared = !(['personal', 'empty', 'weather', 'weather-unavailable'] as readonly Scenario[]).includes(scenario);
  const differentZone = scenario === 'time-zones';
  const privateDate = differentZone ? addDays(homeReviewToday, -1) : homeReviewToday;
  const privateZone = differentZone ? 'America/Los_Angeles' : zone;
  const snapshot = privateSnapshot(scenario !== 'empty-shared', privateDate, privateZone, rows, edits);
  const model = sharedModel(rows, edits);
  if (scenario === 'overflow') model.plan.members = members.map(member => member.userId === 'review-minato'
    ? { ...member, displayName: 'みなと（ひより荘の共用スペース・備品管理担当）' } : member);
  const common = new Set(commonChoreLinks(snapshot.chores, model.plan.chores).map(link => link.personalChoreId));
  const overlay: V2PrivateOverlayState = scenario === 'private-unavailable' ? { status: 'unavailable', message: '個人の家事を読み込めませんでした。保存したデータは保持しています。' }
    : projectV2PrivateTasks({ ownerUserId: homeReviewViewer, today: privateDate, timeZone: privateZone,
      snapshot: { ...snapshot, chores: snapshot.chores.filter(chore => !common.has(chore.id)) } }, homeReviewViewer, range);
  const personal = buildV2PersonalPlan(model.plan, { viewerUserId: homeReviewViewer, settings: { frequencyMode: 'balanced', restDays: [],
    loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } }, now: Date.parse(`${homeReviewToday}T02:15:00Z`) });
  const waste = (scenario === 'mixed' ? ['燃やすごみ'] : scenario === 'personal' ? ['古紙', 'びん・缶'] : []).map((label, index) => ({
    date: homeReviewToday, label, householdId: shared ? groupId : privateHousehold, scheduleId: `review-waste-${index}`,
  }));
  if (shared && waste.length) model.waste = { range, rows: [], schedules: [], hiddenKeys: [], occurrences: waste.map(occurrence => ({
    key: occurrence.scheduleId, occurrence, hidden: false, selection: { groupId, scheduleId: occurrence.scheduleId, date: occurrence.date,
      scheduleRevision: 'review', visibilityRevision: 'review' } })) };
  snapshot.upcomingWasteDates = shared ? [] : waste;
  if (scenario === 'weather') { snapshot.weatherOutcome = 'adjusted'; snapshot.weatherAdjustmentCount = 2; }
  if (scenario === 'weather-unavailable') snapshot.weatherOutcome = 'unavailable';
  return { scenario, model, overlay, personal, snapshot, shared, waste, birthday: scenario === 'birthday' };
}
