# 現行Android通常Releaseの自然な背景実行

2026年11月5日、Sony I4293／Android10、通常Release v13。**OSによるworkerの起動・終了を確認した。共有同期と個人Google Calendarはpendingであり、同期全体の完了は確認していない。**

## 観測

通常アプリを08:03:07.871180Zにホーム操作で背景へ移した。その後、通常LiFlowを開かず、OSのjobを強制しなかった。別IDの使い捨てSQLite検査アプリは起動したが、通常LiFlowのAPKとデータを変更せず、検査後にその別アプリだけを削除した。

固定タグのnativeログで、`BackgroundTaskWork`が08:42:32.591Zに開始し、同じパッケージの登録consumerを実行、08:43:05.294ZにWorkManagerのSUCCESSとなった。次のworkerを60分のdelayで予約した。予約を実行保証とは扱わない。

08:46Zの読取では、ランチャーが前景、対象jobの実行中件数0、次のjobは待機だった。workerの終了後にだけ、通常APKのhashと699個の製品入力の不変を確認し、MainApplicationを起動しない既存の読取専用補助APKでauditを取得した。補助APKは削除した。

Releaseの新しいaudit67は08:42:32.605Z〜08:43:05.208Z、32,603msでnativeログと一致した。以前のaudit66以下はv13導入前なので、この確認には使わない。

|項目|実測|
|---|---|
|audit全体のoutcome|success|
|個人Tasks|skipped|
|本人用Calendar|skipped|
|共有同期|pending|
|個人Google Calendar|pending|

frameworkのSUCCESSやaudit全体のsuccessだけで、両domainが同期済みとは判定しない。Google接続のエラー記録はなく、最終同期は08:00:26.914Zのままだった。pendingの原因は今回のメタデータだけでは特定できず、予算切れ・通信障害・権限障害などの原因を推測で確定しない。

## 範囲と次の確認

未送信の検査操作は追加していない。そのため、今回のworker実行を、実変更・取り消しの送受信、同一Googleアカウントの2実機収束、iOS背景同期の成功とは扱わない。iPhoneは利用者の指示に従い、読取も操作も行っていない。追加の起動最適化も保留のままである。

pending domainの継続・完了条件は別の調査として残る。製品コードや利用者データをこの観測に合わせて変更せず、全作業の完了・GitHub反映も宣言しない。

証拠は `/tmp/liflow-resume-20261104/` の`background-v13-android-result.json`、`background-v13-filtered-native.log`、`background-v13-native-state-after-natural-run.json`、`background-v13-native-audit-after-natural-run.log`。観測用の固定タグloggerはPIDと実行コマンドを照合して終了した。この観測結果の取得により、対応するフォローアップを削除する。


## 後続の自然実行と表示の修正

同日のaudit68（09:46:44.884Z〜09:47:38.059Z）とaudit69（10:47:41.397Z〜10:48:35.751Z）では、共有同期がsuccessになった。個人Google Calendarはpendingのままである。対象jobの実行中0を再確認してから、通常アプリを開かずに読み取り専用の補助照合を行い、補助APKだけを削除した。

追加の件数照合は、未完了のカレンダー1つ・page cursorあり1つ・確定sync cursorあり2つ、inbox ready/waiting0、展開待ち0、未送信write0、競合0だった。この初回の件数照合はDB内のsubject全体の集計である。カレンダー1つは予定1件の意味ではない。この1回のメタデータから、現在の本人のcursorが停止しているか、次に必ず完了するかは断定しない。

実際の画面コードでは、framework相当のoutcomeがsuccessだと各domainのpendingを無視して「完了」と表示していた。両OSの画面テストで再現し、全domainの結果から「完了」「処理待ち」「同期対象なし」などを選ぶよう修正した。同期処理や既存のaudit行は変更していない。関連36件、lint、型検査、契約登録が通過。修正は端末のv13より後なので、端末への反映はまだである。

利用者がiPhoneを再接続したため、以降のiPhone検査は再開した。最初の観測中にiPhoneを操作しなかったという上記の範囲は変わらない。

## audit70で有効な2domainが完了

後続の自然実行は11:49:24.935Z〜11:50:16.758Z、51,823msのRelease audit70だった。固定nativeタグでも11:49:22.088Zのworker開始、同パッケージの登録consumer、11:50:16.820ZのWorkManager SUCCESSを確認した。通常アプリを開かず、強制実行もしていない。

audit70では共有同期・個人Google Calendarがともにsuccess、未使用の個人Tasksと本人用Calendarはskipped。worker終了・実行中job0と通常v13 APKのhashを確認してから、MainApplicationを起動しない読取専用補助APKで照合した。補助APKは削除済みである。

今回は保存済みcontrolのsubjectだけに絞った件数を取得した。3つのカレンダーにsync cursorがあり、page cursor0、残りカレンダー0、dirty/waiting inbox0、展開待ち0、未送信write0、競合0。最終同期時刻は11:49:35.691Zへ進んだ。共有・Calendarの完了記録と、同時点に受信待ちがないことを確認できた。

この観測には新しい検査操作を入れていない。したがって実変更・取り消しの送受信や同一アカウント2実機収束、iOS自然背景同期の検証ではない。またv13で自然に完了したため、後から行ったCalendar API中断処理の修正がこの完了を引き起こしたという扱いにはしない。

証拠は`background-v13-progress-owner-native-audit.json`、`background-v13-final-filtered-native.log`、`background-v13-progress-owner-preflight-jobs.txt`。
