# 生活ケース評価の最終結果

## 既存実行後の限定追補 (2026-11-06)

- development/holdoutの各840件、135回の多段ループ、元ZIP、歴史的な実行fingerprintと19ソースのfreeze記録は再実行・書換えしていない。下記の結果は別の小規模回帰で、main corpusのNOT TESTED件数をPASSへ加算しない。
- 元の`development.json`と`holdout.json`にあるD01/D02の`extra_confirmation_count: 0`は、当時の評価コードがfixtureの仮定として固定出力した値で、画面から測定した値ではない。歴史的raw JSONは変更せず、追補監査ではこの項目を`null`/`NOT_TESTED`へ再分類し、日付固定の観測だけを`partial`として残す。
- D16の歴史的directed結果はforecastのない同一planner入力比較で、provider失敗経路を含まない。追補監査ではこの未検査境界を`partial`に分け、実providerクライアントとRepositoryを通す限定回帰を別に記録する。
- `runner-freeze.json`と凍結19ソースのSHAは変更していない。追補後も`tests/helpers/realistic-lifestyle-cases.mjs`は凍結時SHAへ復元し、追補回帰のソースSHAは`focused-contract-audit.json`とevidence indexに別記する。
- post-runの機能回帰は7件PASS。別に実行した3件は既知値の監査JSON整合チェックで、アプリ動作を検査する回帰や必須feature testではない。検査補助ソースはSHA検証して私的追補へ保全し、作業コピーから除いた。歴史的な合計10チェックの実行記録は維持し、種類別に分けて記録する。

| 境界 | 限定検査の実測 | 結果と範囲 |
|---|---|---|
| NO_EXTRA_INPUT | `tests/completion-intents-ui.test.mjs`のiOS/Android Home画面ハーネスで通常の完了操作 | PASS。Alert 0件、TextInput増加0、表示中Modal増加0。保存待ち操作は完了1件に集約し、`setPersonalDateTaskCompletedIntent`経由で表示中entry ID・`inApp`の完了とintent 1件を保存。物理端末や他画面の入力要求は検査していない。 |
| DAILY_FIXED | `tests/google-calendar-scheduler.test.mjs`の既存ケース。毎日家事4件に15日分を生成し、4日に24時間busyを与えて保存済みscheduleも入力 | PASS。再生成結果はbusyなしの基準scheduleと完全一致し、各家事の15日付を維持。適応placement側のtoday/tomorrow/overdue/fixed-daily保護回帰もPASS。 |
| NEXT_GENERATION | D04の実SQLite完了操作と`tests/personal-adaptive-repository.test.mjs`のrepository完了契約 | PASS。2026-11-04完了から2026-11-05の新planを発行し、完了action 1件を保存、同じround IDを再表示しない。画面保存経路は上記NO_EXTRA_INPUT検査で確認。 |
| FALLBACK_LOCK | D05と`tests/adaptive-placement.test.mjs`の既存自動置換境界 | PASS。候補枠なしで元基準日2026-11-05へ戻さずfallback日2026-11-08を維持し、予約slotは作らない。既存のtoday/tomorrow/overdue保護もPASS。 |
| WEATHER_FAILURE_STABLE | `tests/met-adaptive-weather.test.mjs`のモバイルMET provider実装・Repository経路の回帰(fetcher注入)と`tests/weather-calendar-audit.test.mjs`の既存復元検査 | PASS。最初の通信例外では73時間経過cacheを`unavailable`扱いとし、cache・日付・adaptive plan・DB write数を維持。1分後の成功retryは新forecastを保存してrepository planning geometryへ渡し、source revisionの更新を確認。失敗応答自体ではplan更新せず、retryで具体的な日付が変わったとは主張しない。実ネットワークや物理端末は使っていない。optimizer失敗時に基準planへ戻す既存repository回帰もPASS。 |

追加のdirected実測は`focused-contract-audit.json`に記録する。これらは限定ケースの結果であり、840件分のcorpus invariant結果とは別に扱う。

## 評価範囲

- 生活ケースはdevelopment 840件とholdout 840件、計1,680件を各1回実行。サンプリングなし。
- 元のraw結果ではD01–D21が各splitで21件passと記録された。追補監査の再分類ではD01/D02/D16が未検査項目を含む`partial`、残り18件が`pass`。D01/D02の日付推奨とD16のforecastなし比較は測定済みだが、各not-tested項目はPASSへ読み替えない。各splitの0/50/100%一歩感度分析は84元ケース×3=252観測。これは多段安定性の証拠として数えない。
- 独立した多段ループは日次・週次・月末×0/50/100%の9シナリオ、15回ずつ、合計135実SQLite操作。元の1,680件や一歩252観測へ加算しない。
- SQLite適用操作数はdevelopment 137,777、holdout 140,077。
- 共通実行fingerprint: `904387d423e56b28857a92015c14dc9b7f9be1b5013e9ba34675617ed60fcd86`（19実行ソース）。集計スクリプトSHA-256: `a9780419f84e2dcada3b674b34e86d2f8ce0c974d5f4f3124026b5d609cd0e66`。入力ZIP SHA-256: `df5a7481859bd9d77a55903084355ceae9ca3457be80a5235dfab95d481e743b`。元資材12件は保持。

## 学習・予測

| 値 | Development | Holdout |
|---|---:|---:|
| 観測日数合計 | 331,800 | 331,800 |
| 期間内の記録済み完了 | 139,775 | 142,075 |
| 対象家事の有効間隔 | 12,304 | 12,442 |
| 3間隔へ到達した対象履歴 | 1547/3114 (49.68%) | 1570/3142 (49.97%) |
| 学習可能な完了 / 適用完了 | 104,846 / 135,425 (77.42%) | 106,342 / 137,725 (77.21%) |
| 採点済み予測 | 2,926 | 2,954 |
| 未採点のまま残った予測 | 188 | 188 |
| MAE（採点済みだけ） | 7.6538日 | 7.1574日 |

未採点予測は誤差0として扱っていない。raw reportの全体`learning_eligible_fraction=0`は時系列SQLite評価用ではない値として無効と明示し、raw reportは変更せず、ケース別結果と実SQLite traceから再集計した値を併記した。

## 20 invariantの件数

列の順は`PASS/FAIL/NOT APPLICABLE/NOT TESTED`。NOT APPLICABLEとNOT TESTEDは成功件数へ加えていない。

| Invariant | Development | Holdout |
|---|---:|---:|
| LOCK_NEAR | 840/0/0/0 | 840/0/0/0 |
| NEXT_GENERATION | 0/0/0/840 | 0/0/0/840 |
| DAILY_FIXED | 0/0/0/840 | 0/0/0/840 |
| NEXT_AFTER_COMPLETION | 840/0/0/0 | 840/0/0/0 |
| COMPLETED_LOAD_ONCE | 840/0/0/0 | 840/0/0/0 |
| SAME_EVENT_ONCE | 840/0/0/0 | 840/0/0/0 |
| CONTIGUOUS | 840/0/0/0 | 840/0/0/0 |
| SHARED_NO_LEARN | 840/0/0/0 | 840/0/0/0 |
| UNASSIGNED_LOAD | 30/0/810/0 | 30/0/810/0 |
| SEASONAL_FIXED | 810/0/30/0 | 810/0/30/0 |
| FIXED_OVERRIDE | 840/0/0/0 | 840/0/0/0 |
| NO_INTERVAL_CAP | 484/0/0/356 | 486/0/0/354 |
| MIN_THREE | 840/0/0/0 | 840/0/0/0 |
| INSIDE_WINDOW | 827/0/13/0 | 824/0/16/0 |
| UNDO_LOCAL | 840/0/0/0 | 840/0/0/0 |
| WEATHER_FAILURE_STABLE | 0/0/0/840 | 0/0/0/840 |
| NO_EXTRA_INPUT | 0/0/0/840 | 0/0/0/840 |
| NO_FAKE_HISTORY | 840/0/0/0 | 840/0/0/0 |
| MODE_BOUNDARY | 83/0/756/1 | 83/0/756/1 |
| FALLBACK_LOCK | 0/0/0/840 | 0/0/0/840 |

両splitともFAILは0。全文字列は`development-final-aggregate.json`と`holdout-final-aggregate.json`にある。全体として未検査の5項目はNEXT_GENERATION, DAILY_FIXED, WEATHER_FAILURE_STABLE, NO_EXTRA_INPUT, FALLBACK_LOCKで、両splitの840件は引き続き`NOT TESTED`。D01/D02の旧raw値`0`は未計測の固定値として訂正し、D01/D02は日付確認のみ、D16はforecastなし確認のみとした。追補した通常完了UIとprovider失敗の検査は限定ケースであり、840件分へは加算しない。

MODE_BOUNDARYは各splitでPASS83、NOT APPLICABLE756、NOT TESTED1。未検査の1件はモード変更後に対象家事の記録完了が存在しないため、PASSへ置き換えていない。NO_INTERVAL_CAPはdevelopment 484 PASS/356 NOT TESTED、holdout 486 PASS/354 NOT TESTED。

## 閉ループ

一歩感度分析は各splitで0/50/100%追従の84ケース。FAILは0。Developmentの0%に1件、提案後の記録完了がないNOT APPLICABLEがある。Holdoutは各84件が適用可能。予測次回日の変化率はすべて1だが、これは一回の完了後に別の次回日が出たことだけを表し、長期安定性とは呼ばない。

多段の135操作では、各完了がSQLiteへ保存された実plan ID/revisionを使い、storeが次planを再発行した。実表示窓内の学習周期パラメータ変更は0。週次・月末の位相anchorは窓内完了で進むため別集計し、元ruleDate保持と次planの曜日/月末位相を確認した。9シナリオはすべてPASS。固定fixture以外の将来完了やhidden truthは入力していない。

| Profile | 追従率 | 実完了操作 | 提案追従数 | 窓内の周期変更 | 窓内phase更新 | 結果 |
|---|---:|---:|---:|---:|---:|---|
| daily | 0% | 15 | 0 | 0 | 0 | pass |
| daily | 50% | 15 | 8 | 0 | 0 | pass |
| daily | 100% | 15 | 15 | 0 | 0 | pass |
| weekly | 0% | 15 | 0 | 0 | 0 | pass |
| weekly | 50% | 15 | 8 | 0 | 4 | pass |
| weekly | 100% | 15 | 15 | 0 | 15 | pass |
| monthEnd | 0% | 15 | 0 | 0 | 0 | pass |
| monthEnd | 50% | 15 | 8 | 0 | 5 | pass |
| monthEnd | 100% | 15 | 15 | 0 | 15 | pass |

## 配置と再現

- SQLite chronology traceから計数: development calendar replan 14,880回・fallback/no-candidate plan 1,726件、holdout 14,880回・1,684件。
- Development trace SHA-256: `ec7120e69e5e026167b13897cefde8dc7e5a4c1280adb75ad09b4a3e30de100a`; Holdout trace SHA-256: `7cce3e4153a74be83600a7bdd1d038b2754572fb76d3693a52ba30befa6fb7db`。両方を外部保存先へコピーし、各ファイルサイズとSHA-256を照合した。
- 外部索引・manifest・全ファイルSHA: `evidence-index.json`。入力ZIP原本と12のテスト資材は外部移動・削除していない。
- 集計再実行例: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/realistic-lifestyle-aggregate.mjs --split=development --trace-path=/Volumes/DockerExternal/LiFlowBuildCache/realistic-20261106/lifestyle-traces/final-development-20261106/results/development.operations.jsonl.gz`。Holdoutも`--split=holdout --trace-path=.../final-holdout-20261106/results/holdout.operations.jsonl.gz`で同じ集計コードを使う。
- 元のaggregate/trace runに対するNode回帰: 7件PASS（eligibility/window一致、欠落/重複ケース拒否、Directed/closed-loop失敗の隠蔽拒否、trace fallback/replan集計、多段実SQLiteループ）。post-runの機能回帰7件と監査JSON整合チェック3件は別集計。

## 制約

合成データの結果であり、実ユーザー人口の代表性や実機UI操作の受入を証明しない。天気providerの実ネットワーク通信と時刻/端末を跨ぐ同期は未検査。追加確認の非表示はHome画面ハーネスで限定確認したが、実機UIでは未検査。未採点予測は期限内に次の観測完了がないため残した。
