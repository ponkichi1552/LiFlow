# 個人CalendarのAndroid実サービス往復検査

2026年11月5日。Sony I4293、Android10/API29、通常Release v13。開発サーバーを使わず、既存のGoogle接続・共有グループ加入状態で検査した。iPhoneの実機操作は、利用者の取り外し指示に従って後回しにした。

## 実際に確認した操作

1. 通常の予定追加で、個人の保存先を使い、他と衝突しない検査用予定を1件作った。
2. Android標準の時刻選択で開始09:00を19:00へ変更。終了10:00も20:00へ追従した。
3. 保存して開き直し、同じ検査用予定・19:00〜20:00・本人のみの保存先を確認した。
4. 端末内の読取専用照合では、Google ID・ETagあり、保存した版と同期済みの版が一致、競合・未送信状態・エラーなしだった。
5. 別の検査用APKが端末内の既存権限だけを使って、対応するGoogleの予定をGETした。200と19:00〜20:00を確認した。
6. その1件だけを、取得したETagを条件に19:15〜20:15へPATCHした。200と、独立したGETによる変更後の時刻を確認した。
7. 通常アプリへ戻り、一覧に19:15が表示され、編集画面を開き直すと19:15〜20:15だった。
8. 通常の編集画面から、その検査用予定だけを削除した。Googleの再GETは200・status cancelledだった。端末の削除済み版と同期済み版はともに3で、競合・未送信状態なしだった。

Google側の検査は、[Events.get](https://developers.google.com/workspace/calendar/api/v3/reference/events/get)と[Events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)の形式に従った。新しい権限付与、アカウントの変更、既存の実予定への書込みは行っていない。

## 入力中の画面と検査補助コード

Googleからの受信が済む前に編集画面を開いた1回は、編集中の元の値を保った。その後、一覧は19:15に更新され、閉じて開き直すと新しい終了時刻も表示された。この結果を受信失敗や、入力中の値を勝手に書き換えるべき根拠とは扱わない。

最初の保存前チェックは、EditTextのcontent-descを優先したため、実際の入力値を読めず失敗した。その後も別行の保存コマンドが実行された点は操作スクリプトの誤りである。実際に作られた検査用予定を開き直し、対象と保存値を確認したうえで検査と後片付けを完了した。以後の操作は、前の結果を確認してから別のツール呼出しで進め、画面の端にわずかしか見えないボタンも押さないよう補助コードを修正した。

端末内照合の初回は、Android標準SQLiteにJSON1を仮定した補助SQLが失敗した。Expo SQLiteの製品処理の失敗ではない。検査用文字列で絞り込み、端末内でJSONのタイトルを厳密照合する方式へ直し、同じ通常Releaseで確認した。失敗ログも保持した。

## 証拠と範囲

証拠は `/tmp/liflow-resume-20261104/`。

- `calendar-v13-android-owned-event.json`：検査対象の限定、再表示・逆方向取込・後片付けの結果。
- `calendar-v13-provider-patch.log`：既存権限、GET200、元時刻一致、PATCH200、読戻しPASS。
- `calendar-v13-provider-deleted.log`：Google側の削除状態PASS。
- `calendar-v13-native-state-before.json`、`calendar-v13-native-state-after-delete.json`：読み取り専用の版・同期状態。OAuthトークン、アカウントID、Google ID、他の予定本文は出力していない。
- `calendar-v13-android-google-change-final-editor-ui.xml`：同じ検査用予定の19:15〜20:15・個人保存先。

補助APKだけを検査後に削除し、LiFlow本体と保存データを保持した。検査用予定の削除は通常の同期可能な削除状態として残る。この検査は1件の実サービス往復であり、異種OSの同時編集、全種類の繰り返し、自然なOS背景同期、反応速度全体の合格を意味しない。既存の大量・競合・繰り返し・権限の自動検査とは区別する。
