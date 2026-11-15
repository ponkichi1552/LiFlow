# 8時15分の作業区切り

利用者の追加指示により、全ページのUI/UX監査と1,000件目標の洗い出しは対象から外した。現在判明している修正を統合・反映し、2026年11月16日8時15分ごろで作業を区切る。216候補すべての実機検証が終わったとは扱わない。

## 反映した変更

- 共有グループの更新と受信listenerの競合を排他。正常時の要求数と原署名履歴を維持した。`d88f083`。
- 複数週の複数曜日予定で、位相を保持できない全体／今後移動を保存前に拒否する。
- 受領済み復旧データの削除を、古い未受領要求が塞がない独立した小さなキューへ分けた。
- Google Tasksの初回作成返信が失われた後、再POSTせず同じTaskへ復旧する。別scope・新しい予約の証拠を流用しない。

追加3件のコードは`ef07838a6fecb9933d80888ed0e529b731f2d553`へ統合し、GitHubのmainへ反映済み。追加境界26件、関連検査、lint・型検査、716の機能契約と136の必須Cloud回帰の登録確認を通過した。最終CIは[アプリとCloud](https://github.com/ponkichi1552/LiFlow/actions/runs/43772497602)、[Native configuration](https://github.com/ponkichi1552/LiFlow/actions/runs/43772497601)を参照する。結果の観測時刻・状態は機械可読記録へ残す。

## 実機と保存内容

最終コードをiPhone・iPad・Androidへ署名を保って上書きした。iOSは既存native実行ファイル・assetsを維持し、公式Expoのbundle出力を同じiOS Hermes compilerでbytecodeへ変換し再署名した。署名、entitlements、profileを検査。AndroidもReleaseを再生成して署名証明書を照合した。Appleの保存ファイル129件・13件は停止中の導入前後ですべて一致。Androidのprivate DBをバイト照合したとは扱わない。

利用者の7文と概数の2文を実入力し、iPhone・iPadの原文・日時・繰り返しを照合した。概数の11:00候補を11:30へ修正し、その後の予定名編集でも手動時刻を維持して保存できた。Androidから別アカウントで追加した「LFQA-20261116-C12 明日18時頃夕食」もApple2台へ届き、原文・翌日18:00〜19:00・作成者が一致した。

共通ドラッグツールで350ms長押しし、繰り返しの3択表示と今回だけの移動を実機確認した。検証用「LFQA-20261116-C10 毎週火曜日18時から食事」の11月17日の回は18:00から19:00へ移動した状態で残している。「元に戻す」の表示は確認したが、画面確認中に8秒の期限が切れ、復元の実機確認には至らなかった。最終の両Apple端末は受理117・未送信0・拒否0、投影一致。予定170回のうち、この意図した1回以外の169回は移動前と一致した。検証データを片付けていない。

[最終導入・保存・起動・CIの記録](../qa-assets/physical-2026-11-15/final-fixes-native-2026-11-16.json)と[発見一覧](../qa-assets/physical-2026-11-15/findings.jsonl)を残した。iPhoneとAndroidの正常起動を確認後、実機の操作は終了し、利用者へ返した。

## サーバーと未確認範囲

配備済みaccount-device API、weather API、weather workerの到達ソース・package・lock・Dockerfileは、それぞれの配備元と一致した。今回の変更8ファイルは3サービスのentryから到達しないため、この差分による再配備は不要。これは既存配備記録とソースの照合であり、live healthを取り直した結果ではない。

配送削除workerは未配備の独立entryで、配送切り替えフラグは0のまま。実Cloudの既存データを削除する切り替えは行っていない。有料OpenAI実API検証の保留も維持した。

省略名のGoogleへの実送信、今回のTasks返信喪失の実機再現、複数週境界の実機ドラッグ、Undoの実保存復元、オフライン・権限・通知を含む216候補の残りは未確認として引き継ぐ。自動検査・新しいnativeへの導入と、これらの実機条件の確認を分けている。

## End-of-session CI observation

Observed at 2026-11-15T23:15:10.023959+00:00. Code commit `ef07838`: sharing-security: success; check (android): success; check (ios): in_progress. Native configuration: success. macOS-only widget journal: 1 passed, 0 failed, 0 skipped. The final documentation commit changes no app or server code; its automatic CI may continue after the requested stop.
