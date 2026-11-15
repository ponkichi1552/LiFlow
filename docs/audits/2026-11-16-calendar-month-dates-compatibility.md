# 毎月の複数日付と共有互換性

## 実装前のレビュー

2026-11-16 05:50:58 JSTに互換性の追加調査・方針検討を開始。製品コードを変更する前に2分以上レビューする。

新しい月指定 `{ unit: 'month', interval, on: 'dates', days: [...] }` は旧版の `validateCustomRecurrence` が受理しない。既存の `supportsSharedCalendar` は共有予定全体のゲートであり、この新規則の互換境界にはならない。旧epochのまま署名・送信すると、旧版のoperation shape検証が失敗してその受信batch・snapshotを適用できなくなる。

受信は全operationを検証してからSQLiteの原子transactionでcursorを最後に保存する。したがって既存ローカル履歴を削除する動作ではないが、新規則を含むbatch以降の同期が止まる。署名済み原文を書き換えたり、受信済みの正常履歴を消したりして回避してはいけない。

最小の対応は、v2 schedulerを次のdraftへ進め、旧draftを引き続き読めるようにした上で、月複数日付だけを新しいowner承認epochへ結び付けること。通常の旧規則・既存の旧groupはそのまま使える。新規則のauthor時と、original/receipt両epochのreceiver authorityで検証する。旧groupへの新規則保存は「グループ管理」の既存「共有グループを互換更新」操作へ案内する明確なエラーで止め、Outbox・intent・履歴を増やさない。groupを自動更新しない。

versionの文字列だけを変更しても、既存groupは旧epochを保持するのでauthor/receiverの新規則ゲートが必要。逆にsource fingerprintだけを変更して同じversionを名乗ることも禁止する。`src/domain/calendar/recurrence.ts` は既存v2 scheduler fingerprintの対象であり、最終source bytesを確認してcontract digestを再計算する。

## 本人用経路の調査境界

本人用private-calendar cacheは現行schema 1のbusy intervals・取得範囲・接続証明を運び、予定名や `EventDraft` の繰り返し規則を運ばない。この経路へ不要なschemaやserver変更を加えない。個人Google同期では新規則を標準RRULEのBYMONTHDAYへ送り、旧版が未対応のGoogle繰り返しをread-only各回展開する既存経路へ入ることを確認する。未対応の規則でローカルデータやGoogle原本を上書きしない。

## 自己評価と検査予定

既存groupへの新規則の署名をそのまま許す案は旧版の受信を止めるため採用しない。毎月11日・12日を二つの別予定へ分割する案も、単一seriesと個別編集の意味を変えるため採用しない。既存のowner署名・鍵更新・snapshotの原子commitを使う互換更新が最小で、既存の信頼境界を維持できる。

旧groupで通常規則は保存可能、新規則はauthor前に拒否、低レベル署名を経た新規則もoriginal/receipt両epochで拒否、owner互換更新後は新規則を保存・別SQLiteへ復元、旧履歴と署名が保持されること、旧clientは新versionのmetadataで更新案内となりpayloadを開かないこと、private busy cacheの内容を確認する。nativeのgroup互換更新・server配備・commit・pushは親担当が行い、旧group Aを変更しない。

## 実装と互換性の結果

05:53:45 JST時点まで2分47秒以上レビューし、その後に製品コードの変更を開始した。v2を `liflow-shared-2-draft-58` に進め、draft57を既存機能の対応一覧に明記した。`supportsCalendarMonthDates` だけを新規則の能力境界とし、従来の毎月単日・曜日指定・他の旧規則は旧groupで使用できる。

通常保存、当日だけの復元、これ以降の分割、分割の取り消しのauthor経路で新規則のversionを確認する。拒否メッセージは既存画面の操作名を示す。低レベルcommitでauthor経路を迂回してもreceiverがoriginalとreceiptの両epochを確認し、元のtransactionをrollbackする。互換更新前に署名された新規則は、更新後の遅延送信でも後付けで正当化しない。

既存の「グループ管理」画面は現在のgroup versionと最新versionが異なる場合に「共有グループを互換更新」を表示するため、画面を増やさずこの経路に接続する。管理者以外の更新、membership変更、downgradeは既存の署名検証で拒否する。自動互換更新は追加していない。

最終fingerprintは `e64907a510fe40ca4dc19e131b912ed02b4aa2fa7a81c4fb0c1b616af92dbe25`。新しい `calendar-compatibility.ts` を既存contractの対象へ加えた。HEADとの差分はこのhelper、payload-schema、receiver-authority、calendar-actions、calendar-future-actions、domain/calendar/recurrenceの6ソースで確認した。

## 本人用同期とサーバーの依存

private busy cacheは `calendar-capture.ts` と `v2/private-availability.ts` が本文の全キーを限定している。予定名・EventDraft・新しいcustomRecurrenceは送れないので、schema 1・暗号suite・serverは変更していない。旧個人Google importerはBYMONTHDAYを未対応として `GoogleEventExpansionRequired` に入り、Googleの各回を通常の単発表示として読める。GoogleのRRULEを近似変換したり、Google原本を変更して互換性を作らない。

旧版の根拠はcommit `82b2d8da99e270392a03474807951d9c8cb1cc36` から取得したrecurrence、Google importer、payload-schemaの完全なソースを `tests/fixtures/calendar-draft57/` に凍結し、各SHA-256と出典をprovenance.jsonに保存した。回帰はこの実ソースを検証して実行し、現在の実装を旧版として扱わない。

Firestore Rulesの `validGroup` とmembership更新条件にはschedulerVersionのwhitelistが無く、schema 1/2・keyVersion・公開rosterJson文字列・新epoch snapshotの原子整合を検証する。今回のdraft58追加だけを理由とするRules変更は不要。

ただしaccount-device APIは `server/account-device-api/src/service.mjs` が共通の `verifySharedRosterTransition`、`verifySharedSnapshotManifest` を実行し、Dockerfileがrepositoryのsrcを取り込む。親が配備済みと報告したcommit `e0ec346` の共通validatorはdraft57までで、58を未対応とする。既存のgroup ownerによる直接Firestore互換更新は可能でも、新epochを含む同本人端末の復元では `history_changed` または `snapshot_changed` となる。そのため**account-device APIにはdraft58対応共通コードを含む再配備が必要**。この担当ではserverを変更・配備していない。

weatherとweather-workerは `weather.Dockerfile` が独立したweather・rate-limit・HTTPファイルだけを取り込み、共有roster/schedulerに依存しない。今回のversion変更によるweather系の再配備は不要。配備済み版の実稼働状態は、この静的依存確認から推定しない。

## 自動検査

- 新規 `tests/calendar-month-dates-compatibility.test.mjs`: **8/8通過**。
- 上記と共有互換contract、owner更新、workspace protocol、共有予定、future scope、private capture/cache、同本人rosterの9ファイル: **75/75通過**。
- `npm run lint`、`npm run typecheck`: 通過。
- 最終contract verifierはdraft58のsource fingerprint一致と、旧versionからの前進を確認した。

旧groupのauthor拒否ではfacts・Outbox・intentの数が変わらない。owner更新後の2つ目のSQLiteでは、既存署名をそのまま保持し、毎月11日・12日を一つのseriesとして復元できた。これはローカル回帰の結果であり、実機・本番groupの互換更新は親の別検証として扱う。元データや検証資材は削除していない。
