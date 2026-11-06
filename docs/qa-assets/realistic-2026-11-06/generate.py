#!/usr/bin/env python3
"""Deterministic synthetic scenario fixtures. Not an app implementation or population model."""
import json, random, hashlib, gzip, csv, calendar
from pathlib import Path
from datetime import datetime, timedelta
ROOT=Path(__file__).resolve().parent
SEED=20261104
SOURCES={
 'JILPT227': {'url':'https://www.jil.go.jp/institute/research/2023/227.html','scope':'非正規労働者調査。固定・シフト・呼出しなど勤務の異質性をケース軸へ利用。人口重みには使わない。'},
 'MYVOICE31107': {'url':'https://www.myvoice.co.jp/biz/surveys/31107/index.html','scope':'2024年洗濯調査。実施頻度・時間帯・本人以外による実施のケース軸。任意参加パネルで全国代表ではない。'},
 'USER_DESIGN': {'url':'https://chatgpt.com/space/page_19196f7c50bc81919a53099f824f7018','scope':'設計Pageと2026-11-04の追加指示。今日明日の移動禁止などの契約。最新指示が旧文書に優先。'},
}
SOURCES.update({
 'PLANET247':{'url':'https://www.planet-van.co.jp/pdf/fromplanet/fromplanet_247.pdf','scope':'2026年インターネット4000人。世帯人数と洗濯頻度の多様性。本人の担当率ではない。'},
 'DUSKIN21':{'url':'https://www.duskin.co.jp/news/2025/pdf/251022_01.pdf','scope':'2024年末の大掃除を調べた2025年4160人調査。日常分散・未実施・外注。正確な日付は人工例。'},
 'MLIT25':{'url':'https://www.mlit.go.jp/report/press/toshikankyoteleworkr7.html','scope':'2025年度テレワーク調査。経験率と毎日在宅率を混同しない。'},
 'STUDENT61':{'url':'https://www.univcoop.or.jp/vision/vision_1896.html','scope':'第61回学生生活実態調査。大学生一般の長期行動ログではない。'},
 'CARE2022':{'url':'https://www.stat.go.jp/data/shugyou/2022/gaiyou.html','scope':'2022年就業構造基本調査。就労と介護の併存の根拠。急変率は不明。'},
 'SOCIAL2021':{'url':'https://www.stat.go.jp/data/shakai/2021/gaiyou.html','scope':'2021年社会生活基本調査。家事分担・世帯多様性。性別の自動設定には使わない。'}
})
# Each schedule below is an explicit engineering example, not a survey-derived joint distribution.
PROFILES=[
 ('fixed_early','固定勤務・早朝に家事','regular','early',['JILPT227','MYVOICE31107']),
 ('fixed_evening','固定勤務・夜に家事','regular','evening',['JILPT227','MYVOICE31107']),
 ('long_commute','通勤が長く平日の空きが短い','commute','evening',['JILPT227']),
 ('weekend_work','土日勤務・平日休み','weekend','day',['JILPT227']),
 ('rotating_shift','週ごとに早番と遅番が変わる','rotating','flex',['JILPT227']),
 ('night_shift','夜勤・日跨ぎの勤務','night','afternoon',['JILPT227']),
 ('overnight_chore','家事可能時間が日付をまたぐ','regular','overnight',['USER_DESIGN']),
 ('on_call','勤務直前に呼出しが入る','oncall','flex',['JILPT227']),
 ('split_shift','一日の勤務が二つに分かれる','split','day',['JILPT227']),
 ('variable_days_off','休日が曜日で固定されない','rotating','flex',['JILPT227']),
 ('remote_meetings','在宅で短い予定が点在する','remote','day',['MLIT25','CARE2022']),
 ('student_timetable','授業曜日と課題集中週がある','student','evening',['STUDENT61']),
 ('two_adults_assigned','二人暮らし・共有担当が決まっている','regular','evening',['MYVOICE31107','USER_DESIGN']),
 ('two_adults_unassigned','二人暮らし・共有担当が未定','regular','evening',['USER_DESIGN']),
 ('mixed_shift_household','同居人と勤務時間が異なる','night','afternoon',['JILPT227','USER_DESIGN']),
 ('dependant_appointments','通院・送迎等の短い予定が多い','remote','day',['MLIT25','CARE2022']),
 ('regular_daytime','昼間にまとまった家事時間がある','none','day',['MYVOICE31107']),
 ('fragmented_capacity','10分の空きが複数あるが長い空きは少ない','fragmented','day',['USER_DESIGN']),
 ('frequent_travel','短期の不在が繰り返す','regular','evening',['USER_DESIGN']),
 ('long_absence','連続した長期不在がある','regular','evening',['USER_DESIGN']),
 ('household_delegation','普段は同居人、本人は時々実施','regular','evening',['MYVOICE31107','USER_DESIGN']),
 ('sparse_recording','実施しても記録しない回がある','regular','evening',['USER_DESIGN']),
 ('seasonal_items','季節固定家事を利用する','regular','evening',['USER_DESIGN']),
 ('no_seasonal_items','季節家事を無効にしている','regular','evening',['USER_DESIGN']),
 ('annual_cleaning','年末にまとめて掃除する','regular','evening',['DUSKIN21']),
 ('distributed_cleaning','普段分散して年末大掃除はしない','regular','evening',['DUSKIN21']),
 ('outsourced_care','専門の機器手入れを外注する','regular','evening',['DUSKIN21']),
 ('hybrid_work','出社と在宅勤務が混在する','hybrid','day',['MLIT25']),
]
PATTERNS=['stable','jitter','permanent_longer','temporary_longer','alternating','gradual','missing_records','recommendation_following','calendar_rule','change_settings']
INVARIANTS={
 'LOCK_NEAR':'今日・明日の既存家事を自動移動せず、他日の家事の移動先にも選ばない。',
 'NEXT_GENERATION':'完了に伴う翌日分の新規生成は自動移動とは区別し、毎日の家事を成立させる。',
 'DAILY_FIXED':'毎日の家事を空きの都合で勝手に前後へ動かさない。',
 'NEXT_AFTER_COMPLETION':'日数型の次回おすすめ日は直前の完了日より後。',
 'COMPLETED_LOAD_ONCE':'当日の完了済み負荷を一回だけ計上。',
 'SAME_EVENT_ONCE':'Googleとローカルの同一イベント・同一家事を二重計上しない。',
 'CONTIGUOUS':'30分作業を離れた10分枠三つへ詰めない。日付をまたぐ連続30分は認める。',
 'SHARED_NO_LEARN':'共有家事の周期を個人の完了履歴で学習しない。',
 'UNASSIGNED_LOAD':'未担当共有家事を各人の予定負荷へ一回反映し、共有実体を増やさない。',
 'SEASONAL_FIXED':'季節家事は固定暦の回を識別し、完了日から日数周期を推定しない。',
 'FIXED_OVERRIDE':'個別固定の周期・幅・休日設定を自動学習や移行で上書きしない。',
 'NO_INTERVAL_CAP':'学習周期をメーカー初期値などの上限へ戻さない。',
 'MIN_THREE':'3有効間隔未満は初期周期を維持。',
 'INSIDE_WINDOW':'その時表示されていた拡張後の期間内完了では方式・周期を変更しない。',
 'UNDO_LOCAL':'取消対象の完了の影響だけを除き、後の無関係な操作を残す。',
 'WEATHER_FAILURE_STABLE':'天気が取得できないだけで既存の予定を動かさない。',
 'NO_EXTRA_INPUT':'汚れ評価・生活確認などの追加入力を要求しない。',
 'NO_FAKE_HISTORY':'未記録・未完了から架空の完了や家全体の未実施を推測しない。',
 'MODE_BOUNDARY':'モードをまたぐ間隔を保存するが学習対象から除外する。',
 'FALLBACK_LOCK':'元の基準日へ戻す処理も今日明日の移動禁止を破らない。'
}

def busy_rules(kind):
 rules=[]
 def r(i,days,start,end): rules.append({'id':i,'weekdays':days,'start_local':start,'end_local':end,'end_day_offset':1 if end<start else 0,'busy':True})
 if kind in ('regular','oncall'): r('work',[0,1,2,3,4],'09:00','18:00')
 if kind=='commute': r('work_commute',[0,1,2,3,4],'07:00','21:00')
 if kind=='weekend': r('work',[2,3,4,5,6],'09:00','18:00')
 if kind=='night': r('shift_A',[0,2,4],'22:00','08:00')
 if kind=='rotating':
  r('shift_early',[0,1,2,3,4],'06:00','15:00'); rules[-1]['active_week_modulo']={'modulus':2,'remainder':0}
  r('shift_late',[0,1,2,3,4],'14:00','23:00'); rules[-1]['active_week_modulo']={'modulus':2,'remainder':1}
 if kind=='split': r('morning',[0,1,2,3,4],'07:00','11:00'); r('late',[0,1,2,3,4],'16:00','21:00')
 if kind in ('remote','fragmented'):
  for i,(s,e) in enumerate([('09:00','09:50'),('10:00','10:50'),('11:00','11:50'),('12:00','13:00'),('13:10','14:00'),('14:10','15:00'),('15:10','16:00'),('16:10','17:00')]):r('meeting'+str(i),[0,1,2,3,4],s,e)
 if kind=='hybrid':
  r('office',[0,2,4],'08:00','19:00'); r('home_meetings',[1,3],'09:00','12:00'); r('home_meetings_pm',[1,3],'14:00','17:00')
 if kind=='student': r('classes',[0,2,4],'09:00','16:30'); r('classes2',[1,3],'13:00','18:00')
 return rules

WINDOWS={'early':['06:00','08:00'],'evening':['19:00','22:00'],'day':['09:00','19:00'],'afternoon':['16:00','20:00'],'overnight':['23:00','02:00'],'flex':['07:00','22:00']}

def make_case(pi, variant, horizon, replica=0):
 key,label,schedule,window,refs=PROFILES[pi]; seed=SEED+pi*10000+variant*100+horizon+replica*10000000; rng=random.Random(seed)
 start=datetime(2026,1,1); now_day=min(40,horizon//2); pattern=PATTERNS[variant%len(PATTERNS)]
 shared=key in ('two_adults_assigned','two_adults_unassigned','mixed_shift_household')
 chores=[
  {'id':'daily','kind':'days','initial_days':1,'duration_minutes':10,'load':'light','fixed_daily':True},
  {'id':'laundry','kind':'days','initial_days':rng.choice([1,2,3,7]),'duration_minutes':20,'load':'normal'},
  {'id':'floor','kind':'days','initial_days':7,'duration_minutes':30,'load':'normal'},
  {'id':'filter','kind':'days','initial_days':14,'duration_minutes':30,'load':'heavy'},
  {'id':'long_care','kind':'days','initial_days':rng.choice([60,90,180,365]),'duration_minutes':45,'load':'heavy'},
  {'id':'manual','kind':'days','initial_days':20,'manual_fixed_days':20,'manual_half_width':3,'holiday_preference':False,'duration_minutes':20,'load':'normal'},
  {'id':'wardrobe','kind':'seasonal','seasonal_dates':[{'season':'spring','month':5,'day':15},{'season':'autumn','month':10,'day':15}],'enabled':key!='no_seasonal_items','duration_minutes':60,'load':'heavy','date_provenance':'engineering_fixture_not_region_recommendation'},
  {'id':'shared','kind':'shared','enabled':shared,'initial_days':14,'assignee':None if key=='two_adults_unassigned' else 'u1','duration_minutes':30,'load':'heavy'},
 ]
 if key=='outsourced_care': chores[4]['enabled']=False
 if key=='annual_cleaning': chores.append({'id':'year_end','kind':'seasonal','seasonal_dates':[{'season':'year_end','month':12,'day':20}],'enabled':True,'duration_minutes':90,'load':'heavy','date_provenance':'engineering_fixture_not_population_date'})
 observations=[]; hidden=[]
 for chore in chores:
  if not chore.get('enabled',True):continue
  if pattern=='calendar_rule' and chore['id']=='filter':
   days=[]
   for yr in (2026,2027,2028):
    for mo in range(1,13):
     d=(datetime(yr,mo,calendar.monthrange(yr,mo)[1])-start).days
     if 0<=d<=horizon:days.append(d)
  elif chore['kind']=='seasonal':
   days=[]
   for yr in (2026,2027,2028):
    for item in chore['seasonal_dates']:
     d=(datetime(yr,item['month'],item['day'])-start).days
     if 0<=d<=horizon:days.append(d+rng.choice([0,0,1,7]))
   days=[d for d in days if d<=horizon]
  else:
   cycle=chore['initial_days']; d=0; days=[]; count=0
   while d<=horizon:
    if count==0: step=0
    elif chore['id'] in ('manual','shared','daily'):step=cycle
    elif pattern=='jitter':step=max(1,cycle+rng.choice([-2,-1,0,1,2]))
    elif pattern=='permanent_longer':step=cycle*(2 if d>=horizon//3 else 1)
    elif pattern=='temporary_longer':step=cycle*(2 if 3<=count<=5 else 1)
    elif pattern=='alternating':step=max(1,cycle//2) if count%2 else cycle+cycle//2
    elif pattern=='gradual':step=max(1,cycle+count//3)
    elif key=='household_delegation' and chore['id']=='filter':step=60
    else:step=cycle
    if count:d+=step
    if d>horizon:break
    absent=(key=='long_absence' and 30<=d<90) or (key=='frequent_travel' and d%35 in range(14,21))
    omitted=chore['id'] not in ('manual','shared') and ((pattern=='missing_records' and count%4==2) or (key=='sparse_recording' and count%3==1))
    if not absent:
     if omitted:hidden.append({'chore_id':chore['id'],'day':d,'event':'synthetic_unrecorded_action'})
     else:days.append(d)
    count+=1
  observations.append({'chore_id':chore['id'],'completion_days':days,'completion_time_local':{'early':'07:00','evening':'20:00','day':'11:00','afternoon':'18:00','overnight':'01:00','flex':'18:00'}[window],'record_semantics':'only_user_observed_actions','occurrence_id_rule':'case/chore/season-year or case/chore/generated-sequence'})
 life=[
  {'day':0,'kind':'initialize','previous_history':[]},
  {'day':now_day,'kind':'external_event_added','event_id':'urgent','start_local':'18:00','end_local':'22:00','relative_to_clock':'today'},
  {'day':now_day,'kind':'external_event_added','event_id':'urgent_tomorrow','target_day':now_day+1,'start_local':'09:00','end_local':'19:00'},
  {'day':now_day,'kind':'weather_fetch_failed'},
  {'day':now_day+2,'kind':'sync_echo','canonical_id':'liflow-floor-1','remote_id':'gcal-synthetic-1','same_as_local':True},
  {'day':now_day+3,'kind':'complete','chore_id':'floor','operation_id':'completion-1','occurrence_id':'floor-special-1'},
  {'day':now_day+3,'kind':'duplicate_completion_delivery','operation_id':'completion-2','occurrence_id':'floor-special-1'},
  {'day':now_day+4,'kind':'setting_change','chore_id':'manual','fixed_days':20},
  {'day':now_day+5,'kind':'undo','target_operation_id':'completion-1','preserve_later_unrelated_operations':True},
 ]
 if pattern=='change_settings':life.extend([{'day':horizon//2,'kind':'mode_change','from':'standard','to':'minimal'},{'day':horizon//2+5,'kind':'disable','chore_id':'filter'},{'day':horizon//2+20,'kind':'enable','chore_id':'filter'}])
 if shared:life.append({'day':now_day+6,'kind':'shared_completed_by_other','chore_id':'shared','actor':'u2'})
 if key=='long_absence':life.append({'day':30,'kind':'calendar_absence','start_day':30,'end_day_exclusive':min(90,horizon+1),'busy':True})
 if key=='frequent_travel':
  life.extend({'day':d,'kind':'calendar_absence','start_day':d,'end_day_exclusive':min(d+7,horizon+1),'busy':True} for d in range(14,horizon+1,35))
 if key=='student_timetable':life.append({'day':min(60,horizon),'kind':'calendar_exam_period','start_day':min(60,horizon),'end_day_exclusive':min(74,horizon+1),'busy_time_local':['09:00','22:00']})
 if key=='annual_cleaning' and horizon>=355:life.append({'day':355,'kind':'annual_fixed_occurrence_available','chore_id':'year_end'})
 life=sorted([x for x in life if x['day']<=horizon],key=lambda x:x['day'])
 holidays={'weekly':[0,1] if schedule=='weekend' else ([] if schedule in ('rotating','night','oncall') else [5,6]),'date_overrides':[{'day':d,'is_holiday':d%9 in (0,1)} for d in range(0,horizon+1) if schedule in ('rotating','night') and d%9 in (0,1)]}
 return {'schema_version':1,'case_id':f'{key}-v{variant:02d}-h{horizon}-r{replica}','random_seed':seed,'split':'holdout' if replica else 'development','population_weight':None,'profile':{'id':key,'label':label,'evidence_ids':refs,'schedule_values_are_synthetic':True},'clock':{'start':'2026-01-01','timezone':'Asia/Tokyo','evaluation_horizon_days':horizon,'initial_now_day':now_day,'future_data_not_visible_to_app':True},'settings':{'mode':'standard','chore_windows':WINDOWS[window],'holiday_default':['09:00','19:00'],'holidays':holidays,'additional_input_required':False},'calendar':{'recurring_busy_rules':busy_rules(schedule),'overrides':[e for e in life if e['kind'].startswith('calendar_') or e['kind']=='external_event_added'],'same_event_identity_strategy':'canonical_source_id'},'chores':chores,'observed_history':observations,'lifecycle_events':life,'behavior_model':{'id':pattern,'status':'synthetic_hypothesis_not_measured_prevalence','recommendation_following':{'evaluate_separately':True,'rates':[0,0.5,1]} if pattern=='recommendation_following' else None},'evaluation_only_hidden_events':hidden,'expected_invariants':list(INVARIANTS),'evaluation_metrics':['calendar_time_observed','valid_intervals','learning_eligible_fraction','scored_predictions','unresolved_predictions','prediction_error_before_after_change','unrequested_move_count','extra_input_count','double_counted_load','synthetic_case_coverage'],'limitations':['not_real_user_data','not_population_representative','not_app_test','unknown_work_has_no_input_visibility','schedule_and_lifestyle_association_is_constructed']}

def validate(c):
 h=c['clock']['evaluation_horizon_days']; assert h in (90,365,730)
 assert c['population_weight'] is None
 assert c['settings']['additional_input_required'] is False
 ids={x['id'] for x in c['chores']}; assert len(ids)==len(c['chores'])
 for hist in c['observed_history']:
  assert hist['chore_id'] in ids
  ds=hist['completion_days']; assert ds==sorted(set(ds)); assert all(0<=d<=h for d in ds)
 assert all(0<=e['day']<=h for e in c['lifecycle_events'])
 assert all(x in INVARIANTS for x in c['expected_invariants'])
 for ch in c['chores']:
  assert ch['duration_minutes']>0
  if ch['kind']=='seasonal': assert 'initial_days' not in ch
 assert all(x in SOURCES for x in c['profile']['evidence_ids'])

def main():
 cases=[make_case(p,v,h,replica) for p in range(len(PROFILES)) for v in range(10) for h in (90,365,730) for replica in (0,1)]
 for c in cases:validate(c)
 path=ROOT/'cases.jsonl.gz'
 with open(path,'wb') as f:
  with gzip.GzipFile(fileobj=f,mode='wb',mtime=0) as g:
   for c in cases:g.write((json.dumps(c,ensure_ascii=False,separators=(',',':'))+'\n').encode())
 (ROOT/'examples.json').write_text(json.dumps([cases[i] for i in (0,73,162,396,600)],ensure_ascii=False,indent=2))
 (ROOT/'sources.json').write_text(json.dumps(SOURCES,ensure_ascii=False,indent=2))
 (ROOT/'invariants.json').write_text(json.dumps(INVARIANTS,ensure_ascii=False,indent=2))
 with open(ROOT/'case_index.csv','w') as f:
  w=csv.writer(f);w.writerow(['case_id','profile','pattern','horizon','split','completion_records','lifecycle_records'])
  for c in cases:w.writerow([c['case_id'],c['profile']['label'],c['behavior_model']['id'],c['clock']['evaluation_horizon_days'],c['split'],sum(len(x['completion_days']) for x in c['observed_history']),len(c['lifecycle_events'])])
 stats={'cases':len(cases),'profiles':len(PROFILES),'variations':10,'seed_replicas':2,'horizons':[90,365,730],'completion_records':sum(sum(len(x['completion_days']) for x in c['observed_history']) for c in cases),'lifecycle_events':sum(len(c['lifecycle_events']) for c in cases),'validated_cases':len(cases),'executed_app_tests':0,'invariants':len(INVARIANTS),'not_independent_real_users':True}
 (ROOT/'validation.json').write_text(json.dumps(stats,indent=2));print(json.dumps(stats))
if __name__=='__main__':main()
