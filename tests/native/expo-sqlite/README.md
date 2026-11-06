# Expo SQLiteの実JavaScript接続検査

`connections-app.tsx`はSDK58の実ライブラリとアプリの`withIsolatedSqliteTransaction`を呼ぶ、検査専用の小さな画面である。Node SQLiteの代替試験とnative JNIだけの検査を補い、Hermesからの非同期呼出しを通す。

通常のLiFlowへ検査モードを追加せず、**別のアプリID・空のsandbox**を持つReleaseアプリで、この画面だけを`registerRootComponent`へ渡す。通常のRouter entry、Planner、認証、Google同期、AIを起動しない。Androidの検査用manifestからINTERNET、既存deep link、製品Widget receiverを外す。通常アプリのインストールや保存データを変更しない。

実行前に、SDK・lockfile・検査するアプリ保存ラッパー・このファイルのhashを固定する。新しい検査IDが未インストールであること、完成したAPKのアプリID・署名・INTERNET権限の欠如を確認してから導入する。既存の同名検査アプリを上書き・初期化しない。生成したnativeプロジェクトとビルド出力はソースcheckoutの外へ置く。

画面の`SQLite JS connection audit result`に、次の6件と`PASS`、`cleaned: true`、`existingDatabaseOpened: false`が必要。各OSの`platform`・`hermes: true`・実際のSQLite版も照合する。途中の表示、console出力だけ、ビルド成功だけを合格にしない。

- 別接続のcommitによる`data_version`と値の更新。
- 非同期で並行した読取に未確定writeが見えず、別writerのwriteがBUSYになる。
- 古いWAL snapshotが新しいcommitを上書きできない。
- 読取専用peerのwriteは拒否され、元writerには影響しない。
- アプリのexclusiveラッパーが別接続を使い、失敗時に確実にrollbackする。
- 検査用の本人入力を途中で失効させると最終fenceでrollbackし、その後は接続を再利用できる。

UUID相当の名前の新規DBだけを開き、両接続のclose後に削除する。検査後は導入したAPKのhashをもう一度確かめ、その検査用アプリだけを削除する。通常のLiFlowを起動し直す必要はない。自然な背景同期を観測中に、通常アプリのprocessをinstrumentationで再起動しない。

2026年11月5日のAndroid10とiPhone12／iOS26.7.2で、両方ともHermes／Expo SQLite3.53.3を通した6件PASS。証拠は`/tmp/liflow-resume-20261104/sqlite-js-isolated-{result,artifact}.json`と`sqlite-js-isolated-ios-result.json`。iOSは再接続後に実施し、XCTestの結果JSON・画面・6条件を照合した。検査DBと新規の検査アプリだけを削除し、通常LiFlowの保持も再確認した。

iOSの検査用アプリは既存の検査用署名を使い、製品のapp group・keychain group・Widget・background登録を外した別IDである。改名した検査アプリのscene delegate設定を調整してReact画面を起動したが、製品の設定は変更していない。通常の`xcodebuild test`が元のダミーhostへ差し替えた失敗も記録し、最終検査は対象appを固定した`test-without-building`で行った。結果の出力部のみ、iOSでもJSONを取得できるaccessibilityValueと明示的な文字・背景色へ変更した。Androidの先行結果とこの出力部のhashは異なり、6件の保存処理・判定条件は同一である。

これは実接続の分離・rollbackの検査であり、Firebaseの実権限失効や、製品アプリ全体の安全性の証明ではない。
