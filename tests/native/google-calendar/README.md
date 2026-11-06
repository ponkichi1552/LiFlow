# 所有する合成予定のGET照合

`run-android-owned-audit.py`は、通常アプリの既存Google認可を同一署名・同一UIDの中だけで参照する。
通常APKを`--apk`へ指定し、端末のSHA-256一致・対象workerが非実行・補助IDが未使用であることを確認する。

対象は今回の`LiFlow-QA-20261106-`と10桁のhexを持つ合成予定名だけ。SQLiteは読取専用、Googleには該当する1予定のGETだけを行う。
新しい認可、SQLiteの更新、Google予定の作成・変更・削除は行わない。APIトークン・生のGoogle ID・他の予定は出力しない。
予定を追加するのは通常アプリの画面操作であり、この補助コードはその結果を観測するだけである。

`--series-instances`は今回の11/10開始・11/24終了の隔週合成予定に限定する。
該当する系列の[instances GET](https://developers.google.com/workspace/calendar/api/v3/reference/events/instances)を、11/9〜12/10・上限50件の1ページだけ追加で取得する。
終了日の回が含まれ、終了後の次回が含まれないこと、最終回だけの変更、保存版・ETag・未送信状態を照合する。
その系列以外の予定一覧、参加者、主催者は取得・出力しない。追加ページがあれば観測を未完了として停止する。

補助APKは終了後に削除する。instrumentationは通常processへ影響するため、自然workerや前景同期の実行中には使用しない。
出力の`probe=readonly_complete`と全照合項目を確認し、ビルド成功やinstrumentationの終了コードだけを合格としない。

今回の実行範囲・未完了事項は`docs/physical-convergence-2026-11-06.md`に記録する。
