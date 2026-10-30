# カレンダー・共有・Android依存関係の追加検査

2026-10-31。既存の個人データを保持し、非公開リポジトリの `main` で検査した。これは開発工程内のレビューであり、第三者による独立監査や、全MASVS項目への適合判定ではない。Firebaseの攻撃検査は隔離したローカルEmulatorだけで行った。

## 発見して修正した問題

| 問題 | 対応と確認 |
| --- | --- |
| グループ参加中、アプリ内の個人予定が本人向け家事の推奨計算へ届かない | 個人SQLiteの予定・繰り返し・例外を、本人だけの空き状況へ変換。画面、共有通知、個人のGoogle Tasks連携が同じ入力を使う。隔週の終了日、1回だけの移動・削除、全体削除による再配分を実SQLiteと署名済みの共有家事で再現・検査した |
| Googleとアプリ内の重なる予定を単純加算すると忙しさが増える | 両方に正確な区間がある場合は和集合。日単位集計しかない入力は大きい方を使い、厳密な和集合とは区別する。取得範囲外・古い情報・夏時間の曖昧な回を空き時間と断定しない |
| 共有ホームを開いたまま翌日復帰すると日付が古い | 前景復帰時に再読込。連続50回の通知は1回へ集約し、保存中の日付更新も取りこぼさない。入力途中の日時は保持する |
| AndroidのWidget receiverを外部アプリから呼べる | `android:exported=false` に変更。更新メタデータと自アプリのPendingIntent経路を残す。Android 10実機で無関係な存在しないIDを使い、修正前の受付と修正後のOSによる配信拒否を照合した |
| SDK58の生成テーマがAPI24の基本リソースにAPI27/33専用属性を含む | Config pluginで、完全なstyleを対応するAPIのリソースへ分離。Lintのエラー2件を解消。抑制設定・baselineは加えていない |
| npmの検査だけでは見えない古いAndroid実行時ライブラリ | 実際のRelease依存関係からSBOMを作りOSVで検査。3ライブラリ・5件の既知advisoryを検出し、下表の公式修正版を最低バージョンとして指定。将来の上位版を拒否する `force` / `strictly` は使わない |
| 通信エラーの案内などで月表示の高さが変わると、見出しが表示中の日付と異なる月になる | 古いスクロール量を新しい行高で割る処理を廃止し、実際に見えている週から月を決定する。iOS・Androidの回帰検査と更新後の実機で照合。新規予定の初期日も誤った月へ移らないことを検査した |
| 「1日」から「リスト」へ切り替えると、時間軸のスクロール位置が残り、選択日の家事が隠れる | 実機で再現し、表示方式・選択日ごとにリストの状態を分離。スクロール後の切替・日付移動・表示の往復を回帰検査へ追加した。検査側でも、画面を離れた部品の状態をReactと同じように破棄するよう修正した |
| Commons IOの修正版がAndroid API26以降のNIOを使い、API24/25との互換性を損なう可能性 | Googleの `desugar_jdk_libs_nio:2.1.5` を設定。最低OSとJavaの指定を変えず、通常の言語desugaringだけでは不足するNIOを補う。Releaseビルドと実APKの `j$.nio.file` の収録を確認した。API24/25上での実行確認とは区別する |

| Androidの依存元 | 修正前 → 修正後 | 対象advisory |
| --- | --- | --- |
| Expo FileSystem → Commons IO | 1.4 → 2.14.0 | GHSA-gwrp-pvrq-jmwv。2.7への更新だけでCVE-2024-47554を残さないよう、2.14.0を採用 |
| Expo LogBox → Gson | 2.8.6 → 2.8.9 | GHSA-4jrv-ppp4-jm57 |
| Expo Image / Glide → Guava Android | 28.1-android → 33.7.2-android | GHSA-5mg8-w23w-74h3、GHSA-7g45-4rm6-3mm3、GHSA-xxph-c9ww-hj94 |

Androidは専用のGuava Android版を使用する。[Guavaの公式対応](https://github.com/google/guava/wiki/Android)、[修正対象の公式advisory](https://github.com/google/guava/security/advisories/GHSA-xxph-c9ww-hj94)、[Commons IOのセキュリティ情報](https://commons.apache.org/proper/commons-io/security.html)を照合した。生成済みのnativeコードを手編集せず、Config pluginと生成物のCI検査で再適用を確認する。

API24/25の互換性対策は[Android公式のライブラリdesugaring](https://developer.android.com/studio/write/java8-support#library-desugaring)と[Googleのライブラリ変更履歴](https://github.com/google/desugar_jdk_libs/blob/master/CHANGELOG.md)を参照した。依存ライブラリの脆弱性が減ったことだけを理由に、既存OSで使えなくなる更新を採用しない。

## 個人情報・共有状態の境界

個人予定の名前・場所・メモ・生の区間を共有Outboxや正式な共通予定へ渡さない。共有の署名形式、管理者権限、承認済み日時、共通予定hashは変更しない。時刻未設定の家事に時刻を要求せず、本人の推奨日と日単位の負荷判断へ使う。

正式な共有Schedulerは `liflow-shared-2-draft-38` を維持する。本人だけの推奨ロジック2ファイルを独立した `liflow-personal-1` へ分けた。旧契約全体のhashと残る共通ソースを照合し、正式状態から個人カレンダーをruntime importできないこともASTで検査する。今回のローカル推奨修正を理由に、既存グループの署名済みrosterやDBを書き換えない。

## 無料ツールの結果

| ツール | 実行範囲・結果 |
| --- | --- |
| [Semgrep CE](https://semgrep.dev/docs/semgrep-ce) 1.183.0 | TypeScriptとsecretsの110ルール、558ファイル。timeout 0。CORSの1指摘は完全一致allowlistと拒否テストを照合し誤検知と判定。変更後のnative plugin・生成物検査にも追加実行し、指摘0 |
| [Gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 | 全Git refsをローカルで検査し、100% redact。歴史上の20候補を照合。15件はランダム鍵のSHA256確認値、4件は検査ファイル名・内容hash、1件は合成認証トークン。実際の資格情報は見つからなかった。新規の送信差分も検査する |
| [OSV-Scanner](https://github.com/google/osv-scanner) 2.7.0 | npm lockfileの875パッケージと、Android Releaseの解決済みMaven依存を別々に検査。実行時300座標にNIO互換ライブラリ1件を加えた301座標では指摘0 |
| npm audit | high / critical / moderateは0、lowは8。Expoツールに連なるdeepmergeの同じadvisoryと依存元への波及。互換性を失うExpoへの変更は行わない |
| Android Lint | 最初のエラー2件を修正。最終Releaseビルド成功、エラー0・Warning70件（Security分類0件）。未使用リソース・生成コード等を含むため、エラー0を全警告0とは表現しない |

Semgrepはmetricsとversion checkを無効化し、ソースを解析サービスへ送信しない。`confirmation.ts`の一部構文はCE parserで未対応だったため、原本を変えず、ローカル変数をASTで改名・型を除去した私的な写しも検査し、追加指摘0を確認した。原本が全行そのまま解析されたとは評価しない。

月見出しとNIOの追加修正にも110ルールを実行し、指摘0・解析エラー0を確認した。

OSVのこの版は `ios/Podfile.lock` を未対応として拒否した。CocoaPods依存をOSV検査済みとは数えない。Gitleaks・OSVの配布物は公式リリースのchecksumと照合した。CodeQLの有料なprivate repository向け機能は有効化せず、リポジトリも公開していない。

## 回帰と実機確認

- `npm run check` はlint・型検査を含め2,390件PASS。機能契約374件・必須Cloud参照53件を保持する。
- Firestore Emulatorの89件PASS。未ログイン・他グループ・除名済み端末、権限偽装、改ざん、再送、順序逆転、競合、復旧記録を含む既存攻撃検査を再実行した。
- 2,000通りの繰り返し・終了日・例外を、製品の周期計算とは異なる日ごとの総当たりoracleで照合した。SQL風の文字列、`__proto__` / `constructor`、同時20更新のrevision競合も検査した。
- iPhoneのデータを保持してRelease版を更新し、実際に参加済みのv2グループ内で予定の作成、打ち直し、隔週・カスタム、画面往復、保存、単回編集、全体削除、各表示切替がXCTestでPASSした。最終Release版でも総合操作と家事の再配分の2シナリオが計429.212秒・失敗0件で通過した。合成した共有家事の推奨日が、個人の終日予定の登録で10月31日から11月1日へ移り、予定削除で元へ戻ることを実画面で確認した。開発サーバーを使用していない。
- iPhoneの個人DBは更新・検査後にもintegrity checkが成功し、家事・履歴・設定・ゴミ・家電・Googleリンク等11テーブルの保存値が一致した。共有の合成家事を2件追加し、うち1件を7日周期・基準日より後2日で有効化してから無効に戻した。保存済みの操作記録でも2件とも無効と照合した。既存の個人家事を検査用に変更していない。最終検査後のSQLiteでも11テーブルの一致、共有の合成家事2件の無効状態、有効な検査用個人予定0件・下書き0件を照合した。途中の中断・失敗試行をPASSには数えず、修正後の完走したシナリオを最終結果とした。
- Android 10実機で、更新前後の署名一致とデータ保持更新、非debuggable、Widgetの外部配信拒否と正常表示を確認した。参加済みグループのオフライン画面でも、個人予定の作成、隔週の終了日を含む表示と終了後の非表示、1回だけの翌日移動、全体削除を確認した。時間軸をスクロールしてからリストへ切り替え、選択日と次の日が見えることも最終Release版で確認した。検査用の個人予定は削除した。更新前から開いていたランチャーに古いRemoteViewsが残った失敗は、Widgetを新しく追加して切り分けた。失敗表示を成功扱いにはしていない。

## 残る範囲

Androidのネット接続が失われたため、実サービスに再接続した状態のグループ・予定画面の追加確認は接続復旧後に行う。ローカルの攻撃・SQLite検査、iPhoneの成功を、未実施のAndroid実サービス検査へ読み替えない。

家電AI APIにはプロセス内の件数・同時実行・入力制限があるが、公開インターネット向けの利用者認証と分散した費用制限は未実装。CORSは認証の代わりにならない。一般公開前には、個人利用でのログイン不要方針を保つ認証境界・gateway制限を別途確定する必要がある。

root / jailbreak、紛失端末からの鍵抽出、TLS中間者攻撃、MobSFによるIPA/APK解析、Apple認証の実サービス設定、Background Pushは今回の完了範囲に含まない。[既存の自然な背景同期の観測](sharing-v2/22-background-followup-audit.md)と区別する。生の鍵・認証情報・個人DB・端末ログ・未加工のscan結果は非公開のローカル検査領域へ保持し、Gitへ入れない。
