# 開発コードの正本

正本は [ponkichi1552/LiFlow](https://github.com/ponkichi1552/LiFlow) の`main`と、それに同期した作業コピーとする。変更を一時的に分離した枝を、完了後も別の最新版として運用しない。現在のアプリの機能を調べるときは、古い作業コピーや実験枝ではなく`main`を使う。

2026-10-30、ユーザーの指示により、現在の`main`へ到達する履歴を保ったまま個人アカウントの新規非公開リポジトリへ移した。`origin`と`main`の追跡先は新リポジトリである。旧`jphacks/tkb_2633`は削除・アーカイブ・更新をせず、そのまま残す。ローカルでは`legacy-jphacks`として参照を残し、push URLを無効にして誤更新を防ぐ。

2026-10-30、ユーザーから「正本を決めず、取り込み済みの枝を増やしたままにしている」管理状態について指摘を受けた。GitHubの7ブランチの履歴は共有グループの統合枝に含まれていたが、`main`はそこから92コミット遅れていた。これは独立した7製品ではなく、正本への統合と後片付けが遅れた状態だった。

## 作業の進め方

1. 現在の正本と作業コピー・未コミット変更を確認する。既存の作業場所を再利用する。
2. 変更の隔離が必要な場合だけ作業枝を使う。実装・回帰・lint・型検査・必要な実機検査を同じ変更へ揃える。
3. 検査したコミットを既存PRで`main`へ統合する。履歴のある枝をまとめる際は、その履歴を保持する。ブランチ保護や検査を迂回しない。
4. 統合後の`main`と作業コピーを照合し、完了した枝を整理する。復元用のref一覧とGit bundleを先に検証する。

未採用の実験は、評価・設定・期待する結果が異なるため、正本へ機械的に合併しない。ローカルの変更ファイル・patch・commitの参照を保全し、過去の作業コピーは履歴の保管先として扱う。現在のアプリを起動・検査する場所と区別する。

今回の整理は開発コードの統合である。GitHub Actionsの`main`更新はCIとNative configurationの検査を実行する。App Store公開、EAS公開、Firebase Rules配備を自動実行するworkflowはない。Rules配備と実端末の確認は[別の記録](sharing-v2/20-v2-default-and-live-rollout.md)に残す。

ローカルの退避先はリポジトリ外の私的なチェックポイントに記録し、秘密情報や招待リンクをGitHubへ含めない。

## SDK 58のネイティブ再生成

現在のExpo 58 CLIでは、`prebuild`は既存の`ios/`・`android/`を消して再生成することが既定になっている。既存の生成済み作業場所を保って設定を反映する場合は`prebuild --no-clean`を明示する。再生成した場合は、署名鍵の一致、ビルド出力先、外部ボリュームへの生成物のリンクを再確認する。古い出力先に残るAPKを最新と扱わず、実際の出力と端末へ導入したSHAを照合する。

SQLiteの外部キー既定値は公式config pluginの`customBuildFlags`で設定する。JavaScriptだけの更新では、新しいネイティブ接続の既定値は変わらない。ネイティブ再ビルド後、別接続の制約、不正な参照の拒否、親削除時の整合性を両OSで確認する。

## ネイティブ環境の復元と事前確認

復元前後に`npm run doctor:native`を実行する。インストール済みのExpo・React Nativeがロックファイルと一致するか、Android SDKにCMake 3.22.1とNinjaがあるか、`.cxx`がシンボリックリンクになっていないかを確認する。iOSではPodsのロックファイル、`node_modules`への参照、Xcodeの同一ターゲット内での`ExpoModulesProvider.swift`の重複を確認する。

`android/local.properties`に`sdk.dir`があれば、そのSDKを確認する。未指定ならSDKの環境変数か標準パスを確認する。CMake・Ninjaが不足していれば、選択したSDKの`sdkmanager`で`cmake;3.22.1`を追加する。`.cxx`のシンボリックリンクが原因でビルドに失敗している場合は、Gradleを停止し、表示されたリンクを`unlink`してから再ビルドする。

通常はチェックアウト、`node_modules`、`ios/Pods`、Androidの`.cxx`を同じAPFSの作業場所に置く。macOSでExFATの外付けストレージを利用するときは、SDKやPodsをAPFSディスクイメージ内に置く。Podsを外に置く場合は、`PODS_ROOT/../../node_modules`が現在のチェックアウトを参照するようにする。Podsとロックファイルが一致しなければ`cd ios && pod install --deployment`で復元する。Xcodeの重複は各ターゲットのコンパイル対象を示す`PBXSourcesBuildPhase`で調べる。

外部Podsを使ってXcodeを直接ビルドする場合は、チェックアウト直下で`LIFLOW_CHECKOUT="$(pwd -P)"`を実行する。次に`PODFILE_DIR="$LIFLOW_CHECKOUT/ios"`と`REACT_NATIVE_PATH="$LIFLOW_CHECKOUT/node_modules/react-native"`を`xcodebuild`のビルド設定引数に加える。

`EXPO_PUBLIC_*`の値を変えたら、その値を設定した環境でJS bundle taskを強制再実行してからReleaseを作る。

```sh
cd android
./gradlew :app:createBundleReleaseJsAndAssets --rerun :app:assembleRelease
```

Firebase Emulator検査は[READMEの固定コマンド](../README.md)（Firebase CLI 15.34.1、`demo-liflow-sharing`）を使う。Emulator用JDK 21はその子プロセスだけに設定し、Android native buildのJDK 17を保つ。

## iOS Releaseの検査用ビルド

シミュレーターでもKeychainを使用するため、`CODE_SIGNING_ALLOWED=NO`で作った実行ファイルを、そのまま共有機能の検査に使わない。標準のシミュレーター用署名を有効にしてビルドする。SDKが生成する`Simulated.xcent`と、実行ファイルの`__TEXT,__entitlements`を確認する。実機用のentitlementsを後からシミュレーターへ付ける方法とは異なる。

埋め込みJavaScriptだけを更新する場合も、検査済みのネイティブ実行ファイルと署名情報を維持し、`scripts/compile-ios-release-bundle.mjs`で対応するHermesバイトコードへ変換する。生のJavaScriptをReleaseの`main.jsbundle`として扱わない。署名の整合性を確認してから、同じbundle IDへデータを保持して上書きする。

ホームの見出しが表示されただけでは、共有状態の復元成功とはしない。保存情報のエラーがないこと、所属グループが表示されること、個人／共有設定の切替、予定保存・再表示・削除まで確認する。UI検査では、失敗したケースの下書きを次のケースの新規予定へ追記しない。検査で作ったと特定できるデータだけを片付け、無関係な下書きや予定は破棄しない。

## Androidの計測用ビルド

環境変数だけを切り替えても、Gradleが埋め込みJavaScriptを再生成するとは限らない。計測フラグを変更した際は、対象の生成済みbundleを無効化して再生成したことと、APK内の実際のフラグを確認する。単に`BUILD SUCCESSFUL`だったことを、計測コードの導入証拠にしない。

計測後は、データを保持して診断OFFのReleaseへ戻す。作業コピーの一時的な計測コード、生成済みbundle、APK出力、端末へ導入した版を照合する。起動操作からの時間、JavaScript開始からの描画時間、操作ハンドラーからのlayout時間、自動操作ツールの検出待ちを区別する。

## 共有と本人の推奨計算の版

正式な共有状態と本人だけの推奨計算には、それぞれソース契約を持たせる。共通ルール・権限・共通予定の互換性は `scheduler-contract.json`、本人の推奨はv2の `personal-scheduler-contract.json` で検査する。前者から後者や個人カレンダーへruntime importする変更は拒否する。ローカル推奨の改善だけで、既存グループの署名済み版やrosterを書き換えない。ソースhashの更新だけで検査を回避せず、変更した側の版と回帰を揃える。

共有の受信保存の一括化は `receiveStorageRevision` を2に進める。操作・元署名・受領・投影・受信位置が従来と一致することを確認した前後のソース指紋を検査で固定し、既存グループと旧端末は同じ署名付きスケジューラ版で同期できる。

署名検証の高速化はローカルの `signatureVerificationRevision` を2に進める。固定版libsodiumが受理した署名を優先し、ほかの結果を現行のNobleへ渡す。署名した原文、受理・拒否の条件、署名済みスケジューラ版を維持する。読み込み側、ネイティブ接続コード、配布用ライブラリもソース契約で検査する。現行と同じNobleで検証済みの旧キャッシュは、元の暗号化ポリシーに一致する場合に読み込む。

`calendarProjectionRevision` 2では検証済みの固定幅ISO日付を文字列順で比較する。同日の終日・開始時刻・IDの順序は従来どおり。繰り返し展開では同じ予定の期間を再利用し、画面の時刻変換では同じ投影内の確定時刻を再利用する。

`calendarProjectionRevision` 3では、繰り返しの個別回を移行するときに、変更前と変更後の周期をそれぞれ一度だけたどる。対応する回がなくなっても保存済みの個別回を保持する。夏時間で存在しない回の時刻を編集前の値として開けるようにし、保存時と他端末での受信時には確定した時刻を従来と同じ条件で検証する。
