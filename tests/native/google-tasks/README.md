# Google Tasks実サービスの補助検査

`TasksConvergenceAudit.java` / `run-android-convergence-audit.py`はGETだけを行う観測用コード。
同一署名の補助APK内で既存の認可と対応表を読み、現在のアカウントで有効な共有連携の専用リストを100件以下のページで取得する。
同じ家事回の重複、対応表の欠落、完了数、Google IDとの対応のdigestを出力する。
トークン、アカウント名、家事名、Google ID、APIの生レスポンス、通常のDBファイルは出力しない。
操作済みの組み込み検査対象2種類だけは`laundry`・`washbasin`の固定識別名で、対応するIDのdigest・予定日・完了状態を照合する。
制御状態の試行時刻・成功時刻・再試行時刻も記録し、送信が始まっていない状態を成功と扱わない。
`--mapping-before`に検査操作前のUTC時刻を指定すると、既存対応だけの件数・digestと、それ以降に作られた対応の匿名digest・予定日を分けて照合できる。次回分の追加を重複作成と取り違えないための読み取りであり、対応表は変更しない。

実行には現在端末に入っている通常APKを`--apk`へ指定する。端末上のSHA-256一致、対象workerが非実行であること、補助IDが未使用であることを確認する。
終了後、導入した補助APKだけを削除する。instrumentationは通常processへ影響するため、背景実行の観測中や前景同期が処理中のときには使用しない。
`probe=readonly_complete`と対象の件数・digestの比較が必要であり、ビルドや終了コードだけを合格にしない。

既存の`TasksConditionalAudit.java` / `run-android-conditional-audit.py`は、別の明示実行型の試験である。
これは一意な検査リスト・タスクを作り、途中の完了を古いETagのDELETEが拒否するかを試して、所有する検査データだけを片付ける。
GETだけの観測と取り違えて実行しない。通常の家事タスクや検査と無関係なリストを削除しない。

実行範囲・未完了事項は`docs/physical-convergence-2026-11-06.md`に記録する。
