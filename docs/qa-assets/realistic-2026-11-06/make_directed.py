import json
from pathlib import Path
P=Path(__file__).resolve().parent
D=[
('D01','今日の急用',{'today':'2026-11-04','existing_chore_day':'2026-11-04','event':'new_busy_event_same_day'},{'recommended_day':'2026-11-04','extra_confirmation_count':0}),
('D02','明日の急用',{'today':'2026-11-04','existing_chore_day':'2026-11-05','event':'new_busy_event_tomorrow'},{'recommended_day':'2026-11-05','extra_confirmation_count':0}),
('D03','今日に空きができる',{'today':'2026-11-04','other_chore_day':'2026-11-10','event':'busy_event_cancelled_today'},{'move_other_chore_to_today':False}),
('D04','毎日家事完了',{'completed_day':'2026-11-04','interval_days':1},{'next_day':'2026-11-05','same_day_reappearance':False}),
('D05','フォールバックと固定',{'today':'2026-11-04','current_recommended_day':'2026-11-08','original_base_day':'2026-11-05','search_result':'none'},{'recommended_day':'2026-11-08'}),
('D06','完了後の初回追加',{'completed_today_minutes':30,'new_chore_minutes':30,'daily_capacity_minutes':45},{'existing_completed_load':30,'new_chore_fit_today':False}),
('D07','同期コピー',{'local_event':{'canonical_id':'A','start':'10:00','end':'10:30'},'google_event':{'canonical_id':'A','start':'10:00','end':'10:30'}},{'event_count':1,'occupied_minutes':30}),
('D08','細切れ空き',{'available_intervals':[['10:00','10:10'],['11:00','11:10'],['12:00','12:10']],'duration_minutes':30},{'fits_contiguously':False}),
('D09','日跨ぎ空き',{'available_interval':['2026-11-04T23:50:00+09:00','2026-11-05T00:20:00+09:00'],'duration_minutes':30},{'fits_contiguously':True}),
('D10','共有未担当',{'member_ids':['u1','u2'],'shared_chore_duration_minutes':30,'assignee':None},{'shared_entity_count':1,'member_loads':{'u1':30,'u2':30},'learn_shared_cycle':False}),
('D11','別ID二重完了',{'operations':[{'operation_id':'a','occurrence_id':'same'},{'operation_id':'b','occurrence_id':'same'}]},{'effective_completions':1,'phase_advances':1}),
('D12','取消後の後続設定',{'events':['complete_A','set_B_20_days','undo_complete_A']},{'B_fixed_days':20,'A_effective_completion_count':0}),
('D13','季節の遅い完了',{'spring_fixed_day':'2026-05-15','spring_completed_day':'2026-08-01','autumn_fixed_day':'2026-10-15'},{'autumn_fixed_day':'2026-10-15','infer_day_interval':False,'mark_autumn_complete':False}),
('D14','長周期の履歴不足',{'recorded_completion_days':[0,180,360],'initial_days':180,'horizon_days':365},{'valid_intervals':2,'learning_started':False,'cycle_days':180}),
('D15','本人の担当だけ長周期',{'observed_completion_days':[0,60,120,180],'initial_days':14,'hidden_other_household_work':'not_provided_to_app'},{'hard_cap_to_14_days':False,'assume_no_household_care':False}),
('D16','天気取得失敗',{'existing_day':'2026-11-10','event':'weather_unavailable'},{'recommended_day':'2026-11-10'}),
('D17','モード境界',{'complete_day_0':0,'mode_change_day':10,'complete_day_1':20},{'raw_record_kept':True,'cross_mode_interval_used_for_learning':False}),
('D18','拡張期間端の完了',{'learned_days':14,'displayed_window_days':[14,20],'completion_day':20},{'cycle_days':14,'relearn':False}),
('D19','夜勤と休日初期値',{'personal_available':['16:00','20:00'],'default_holiday_window':['09:00','19:00'],'date_marked_holiday':True},{'overwrite_personal_window':False}),
('D20','ゴミ収集表示',{'collection_days':['2026-11-05'],'kind':'garbage_display'},{'requires_completion':False,'learns_interval':False}),
('D21','候補が狭い順',{'chores':[{'id':'flex','candidate_slots':['A','B']},{'id':'tight','candidate_slots':['A']}]},{'one_valid_solution':{'tight':'A','flex':'B'},'note':'これは唯一の最適性一般証明ではない'}),
]
(P/'directed_cases.json').write_text(json.dumps([{'id':i,'label':label,'input':a,'expected':b,'status':'specified_not_executed_against_app','origin':'user_design_contract'} for i,label,a,b in D],ensure_ascii=False,indent=2))
