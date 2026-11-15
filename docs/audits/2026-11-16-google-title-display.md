# Google予定名の日時省略と原文保護

## 実装前の検討

2026-11-16 05:28:33 JSTに既存コードの読取と境界の検討を開始。親の監査 `2026-11-16-title-periods-and-display.md` に従い、製品コードを変更する前に2分以上検討する。

Googleへ送る `summary` だけを、端末の「予定名の日時表現を省略」で整形する。LiFlowのイベント定義・編集・検索には原文を保持し、Google Tasksの家事名は変更しない。既同期の同じrevisionは設定の切替だけで再送しない。新規予定や実データを変更して送信するときに、その時点の設定を適用する。端末ごとに異なる設定があっても同じ予定名の再送を繰り返さない。

個人同期はGoogle送信済みwire内容とLiFlowのraw内容を別の基準値として保存する。Googleから既送信の省略名が戻っても原文を上書きしない。Googleで日時・場所など他の欄だけを変更した場合も、送信済み名と一致する限り原文を保持する。Googleで名前が明示的に変わった場合は、その変更を既存の競合保護に沿って採用する。

同アカウントの別端末が異なる省略設定で送る場合に備え、原文と送信名の組のSHA-256をprivate metadataへ一つだけ付ける。省略で名前が変わる時だけ付与し、原文自体は追加送信しない。受信名がこの組と一致する場合だけ、別端末が生成した表示名として原文を保持する。Googleの手動改名は一致しなくなる。原文送信へ戻る時は古いproofがあれば削除する。

送信開始前に保存するpendingには、設定を適用した送信内容と、その送信に対応するローカル原文の基準値を含める。途中の設定変更・ACK喪失・プロセス再生成でpendingの意味を変えない。再試行には元の安定ID・条件付きETag・payloadを使い、新しいGoogle予定を作らない。

共有Google表示は同じ整形を使い、共有原文・権限・署名済み履歴・接続先は変えない。別端末の正当な中間revisionを照合する既存の証明は、省略オン／オフのどちらで送られた表現も判別できるようにする。利用者がGoogleで独自に変更した名前を正当な履歴と誤認しない。

## 自己評価と検査範囲

原文とwireを一つの値にまとめる方法では、自己エコーで原文を失うため採用しない。設定変更時に全件を再送する方法も、別端末との往復更新や待機時間を増やすため採用しない。coreへの設定読取関数の注入でNode上の回帰を可能にし、端末KVへの依存は既存nativeアダプターに限定する。

検査対象は、省略オン／オフ、新規／編集、解析できない名前、同一revisionの無送信、Google自己エコー、他欄remote編集、明示remote改名、pending中の設定変更とローカル編集、ACK喪失後の再試行、個人／共有、別アカウント、同アカウント別端末、共有の履歴照合。自動検査は対象の挙動だけを証明し、実端末・本番Googleの観測とは分けて報告する。

05:32 JSTまで3分以上の検討後に製品コードの変更を開始した。

## 実装結果

Google用の本文生成に省略の引数を追加し、通常のローカル基準値には引き続き原文を使う。個人同期のpendingへ、その正確な送信が表すローカル基準値を保存する。受信の競合比較も同じraw表現へ戻してから比較するため、両端が同じ内容へ変更した場合に表示名だけで競合しない。

Google版を明示採用する場合も、送信済みrawとwireの組を保持したまま、審査したローカルrevisionだけを抑えて受信する。Googleの日時・場所だけが変わった競合で、元の名前が省略名へ置き換わらない。既存の競合審査と、審査後の追加編集を拒否する境界は維持する。

個人予定や例外を削除した場合、最後のraw名を端末内の `local_base_json` のtombstoneに保持する。削除の比較ではこの保持名を無視する。これにより、独自名を付けた例外を含め、Googleで削除を取り消した場合も元のraw名を復元できる。Googleへ保持名を追加送信せず、SQLiteの列・バージョン・権限を増やさない。

nativeの個人・共有アダプターは同じ設定読取関数を渡す。coreは端末KVを直接importせず、保存済みpendingのpayloadも設定変更で組み直さない。Google Tasks名、認証scope、既存server配備は変更していない。

## 自動検査の記録

2026-11-16 05:46 JSTのローカル状態で次を確認した。

- 個人Google同期・共有Google表示・共有private store・native設定注入の4ファイル: **131/131通過**。このうち今回追加した名前・原文保護の回帰は22件。
- Google event import、account switch、Calendar API、複数日繰り返し、native Tasks、private calendar nativeの周辺6ファイル: **53/53通過**。
- `npm run lint`、`npm run typecheck`、`git diff --check`: 通過。

同アカウント別端末の回帰は、別々のSQLiteデータベース2個と共通の模擬Google APIで確認した。これは本番Googleや実端末の観測ではない。この担当範囲では新しいGoogle書込、実機UI操作、server配備、commit、pushを行っていない。検証データも削除していない。

仕様確認にはExpo SDK 58の[参照トップ](https://docs.expo.dev/versions/v58.0.0/)、Google Calendarの[PATCH仕様](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)と[extended properties仕様](https://developers.google.com/workspace/calendar/api/guides/extended-properties)を利用した。古いproofはnullを指定して削除し、既存の他のprivate propertiesを維持する。
