# iPhone実機検査の再開

利用者が2026年11月5日にiPhoneを再接続したため、延期していた物理端末検査を再開した。iPhone12／iOS26.7.2、既存のPersonal Team署名、開発サーバーなしの通常Release v13。

- 接続、ペアリング、ロック解除、Developer Modeを確認した。
- 検査済みの699個の製品入力と260個のappファイルのSHA256、およびcodesignを再確認し、同じbundle IDへ上書きした。初期化・アンインストールはしていない。
- 設定からGoogle連携画面までの読取専用XCTestが通過した（15.689秒）。アカウント変更や接続実行は行っていない。
- 初期月表示、1日・2日・リスト、家事の展開、ホームから家事説明への移動、4つの下部タブと戻る操作のXCTestが通過した（42.509秒）。元の詳細表示設定を復元した。
- 実際のスクリーンショットも確認した。2日表示の家事名は列内で通常の折返しとなり、以前の1文字ずつの縦崩れは見られない。1日表示と説明画面も確認した。

時間は一連のXCTest操作全体であり、起動速度やタップ遅延の計測値ではない。家事の完了・設定値・予定は変更していない。これは全種類の同期、1秒以内の起動、iOS自然背景処理の成功を意味しない。

証拠は`/tmp/liflow-resume-20261104/ios-v13-preserving-install.json`、`ios-v13-settings-review-20261105.log`、`ios-v13-routes-20261105.log`、各attachmentsフォルダ。対応するxcresultは外部ストレージの`owner-release-review-20261105`内に保持した。XCTestのプロジェクトはソースcheckout外の既存検査用プロジェクトであり、LiFlowへ試験用の操作口を追加していない。

同時に見つけた背景実行記録の誤った「完了」表示はローカルコードで修正し、関連36件・lint・型検査が通過した。この小修正はv13より後で、端末版へはまだ反映していない。全件3294件・隔離Cloud142件の合格はv13時点のものと区別する。

## 実SQLite接続の6条件

別ID・空sandboxの検査用Releaseアプリを作り、iPhoneの実Hermes／Expo SQLite3.53.3で6件を確認した。data_version、未確定writeの分離、古いWAL snapshot、読取専用peer、製品のexclusiveラッパーのrollback、途中で失効した本人入力の最終fenceである。結果JSONは全6件PASS、cleaned=true、existingDatabaseOpened=false。XCTestは20.968秒で通過し、実画面も確認した。

検査用署名は既存のものを使い、製品の共有app group・keychain・background・deep link・Widgetを持たない別IDとした。検査前に同IDが未インストールであることを確認し、検査後はこの新規アプリだけを削除した。通常LiFlowは残っている。ソースマップ内の製品モジュールは保存ラッパー・本人入力fence・純粋な地域計算の3つだけで、Planner／認証／Google／AIのentryは含まない。

初期の試行では、XCTestが元のダミーhostを使ったり、改名した検査用アプリのsceneが起動しなかったり、結果のaccessibilityLabelが本文を隠したりした。これらは合格へ数えず、検査appの固定、検査appだけのscene設定、出力部を修正した。通常アプリのscene設定は変更していない。保存処理の6条件も緩めていない。

証拠は`sqlite-js-isolated-ios-result.json`、`sqlite-js-isolated-ios-xctest-v5.log`、`ios-sqlite-js-v5-attachments`、`ios-sqlite-after-cleanup-apps.json`。署名済みファイルのhashは外部ストレージの`sqlite-js-isolated-ios/artifact-v5.json`に記録した。これは保存層の接続検査であり、同一アカウント2実機同期やiOS自然背景同期の成功とは区別する。

## 追加修正版v15の導入

Calendar APIの中断、API外の本人確認の時間枠、背景診断の誤った完了表示を修正し、両実機へ反映した。iPhoneの通常アプリが存在すること、699入力・完成app全ファイル・有効な既存の署名と端末登録を再確認して上書きし、保存データを保持した。

変更はTypeScriptの4ファイルだけで、nativeコード・設定・assets・依存はv13と同一だった。中間の全native再ビルドは未導入で中止し、全260ファイルを照合したv13 nativeにSDK58のproduction Hermesを再生成して署名した。生成物のsource mapでは、変更した4ファイルを含む638個の製品ソースが現在のhashと一致した。再署名後もnativeの57個の実体sectionはv13と同一で、その他の差分はmain.jsbundleと署名情報だけ。深い署名検証も通過した。これは全nativeをv15でコンパイルし直したという結果ではない。

導入後のXCTestで通常ホームから設定、背景診断の展開・再読込・戻るが通過した（13.364秒、操作全体であり速度計測ではない）。実画面でも11月5日の未完了記録を「処理待ち」と表示することを確認した。画面に出た21:14:29と19:52:42はv15導入前の記録で、11月2日の完了記録も旧版のものなので、v15の自然背景同期成功へ読み替えない。新しい検査用hostは残っておらず、通常LiFlowは保持している。

証拠は`owner-v15-ios-preserving-install.json`、`owner-v15-ios-diagnostics-test.log`、`owner-v15-ios-diagnostics-attachments`。xcresultの添付名に残るv14という文字は検査helperの古いラベルで、対象アプリの版は署名済みartifactと導入記録で照合したv15である。最終成果物は外部ストレージの`startup-v15-ios-artifact.json`と`ios-v15-native-reuse/pre-sign-proof.json`に記録した。追加の起動最適化は引き続き保留、全作業の完了や公開は未実施。
