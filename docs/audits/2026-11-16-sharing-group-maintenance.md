# 共有更新と受信処理の競合

## 観測と切り分け

3台へ`fff35df`を導入し、draft58対応の本人端末APIへ切り替えた後、検証用グループを所有者のiPhoneから互換更新した。更新後のrosterと既存106件はiPhone・iPadに届き、未送信・拒否は0だったが、更新直後に同期失敗の表示が出た。手動同期後はエラーが消え、最終同期時刻も進んだ。実機の例外本文は保存されておらず、後述の競合がこの実機例外の唯一の原因だったとは断定しない。

本物のgroup manager・v2 synchronizer・署名・暗号snapshot・SQLiteを使い、Cloud IOのみメモリーに置いた制御実験で、旧epochのmetadataまたはregistry recordを取得済みのlistenerが更新処理に重なると、更新後の同期が同じ古い処理へ合流して失敗することを再現した。確定済みの新しい名簿・鍵は残り、通常の再同期で受信できるが、更新操作そのものが失敗したように見える。

## 実装前の案と自己評価

2026-11-15 21:39:43 UTCから21:43:04 UTCまで、案を文章化し、通信数・保存・権限・失敗時の解放を3分21秒見直した。既存の`withMaintenance`を使い、事前同期の後、prepare・membership commit・鍵と履歴の保存を同じ排他区間で行う。更新後の同期は排他を解放してから行う。排他の中で再帰同期して待ち合いを作らない。

利用者は更新後に同じ操作や再認可を追加しなくてよい。正常時の通信数を増やさず、取得済みの古い名簿を新epochへ当てはめる競合を防ぐ。真のrollback、権限不足、通信失敗の検証やエラーを弱めない。更新できていない状態を表示だけで成功に変えない。

同じrotationを使う承認・除名・端末解除・所有者移譲・保持用snapshot・所有者退出にも同じ境界を使う。処理失敗でも既存の排他を必ず解放し、元の署名履歴・未送信編集・動作中の鍵を維持する。

## 修正と検査

修正はgroup managerと本番v1/v2 factoryの3ファイル。synchronizer本体と共有の検証契約は変更せず、draft58のfingerprintを維持した。

新規20件を含む関連9ファイル73件、lint・型検査・契約検査が成功した。106件のsyntheticな原署名履歴と旧鍵の保持、100 listenerの合流、正常時の要求数不変、更新中の未送信編集、prepare/commit/キャンセル/応答喪失/鍵・履歴保存の失敗後の解放と復旧を検査した。実機の106件をこのfixtureへコピーしたものではない。

真のrollback・権限不足・再取得失敗は引き続き拒否する。maintenanceの本番v2注入だけを外すmutation検査では、2つの競合回帰が元のrollback/history-limitとmembership-changed条件で失敗し、注入ありでは成功した。正常な更新の計数はreadGroup 3、readSnapshot 1、pull 4、ack 2、prepare 1、commit 1で、修正前の競合なし条件と一致した。

Cloud全件は下記のとおり通過した。修正は未コミットで、修正版のnativeバンドルは未導入、実機受入れは未実施。既に更新済みの検証グループを旧版へ巻き戻したり、既存検証データを削除して同じ状態を作り直したりしない。

## Cloud全件の結果

私的な`group-maintenance-cloud.log`を確認し、Auth・Firestore Emulator上の`npm run test:sharing-cloud`が173/173件成功、失敗・キャンセル・スキップ0、終了コード0だった。これは隔離環境での自動検証であり、稼働Cloudの再配備や修正版nativeの実機通過を示すものではない。ログのSHA-256は`9621338f358bc2d32959438cea772cbbd6923e25103608dfe839b031ecde28d2`。

## 本人端末APIへの到達性

私的な`calendar58-server-fix-reachability.json`を確認した。TypeScript 6.0.3のcompiler ASTで`server/account-device-api/src/index.mjs`からローカルのimport・re-exportをたどった実行時グラフは33ファイル・ローカル93辺、型だけのimportも含む保守的なグラフは50ファイル・ローカル260辺だった。外部packageへの辺はそれぞれ20辺・21辺で、ローカル辺と区別している。

修正した以下の3ファイルは、両グラフから非到達だった。

- `src/features/sharing/group-manager.ts`
- `src/features/sharing/v2/workspace-session.ts`
- `src/platform/sharing/workspaces.ts`

未解決のローカルimportは0件。動的な実行時import、require、ファイルやモジュールの別読み込み経路も解析・手動確認した。外部package自体はグラフの終点として扱い、Dockerfile・package.json・package-lock.jsonの一致を別に確認している。Docker imageへクライアントのソースをコピーすることと、APIのentryから実際に読み込むことを区別した。

配備元として親作業が報告した`fff35df`のソースと比較し、両グラフのSHA-256・到達ファイルの内容マニフェストが一致、実行時ソースの差分は0件、上記3つの構成ファイルもバイト単位で一致した。この3ファイルのクライアント修正だけを理由に、本人端末APIを再ビルド・再配備する必要はないと判断する。解析ではAPI entryを実行せず、配備済みimageや稼働Cloudへ新たな照会を行っていない。到達性記録のSHA-256は`57a035d762e7aae71cf8113f973bdab808cc00505b59f1b30e39e45f31cfe1ec`。

## 残る実機確認

Cloud全件と到達性の成功を、修正版nativeの導入・実機受入れへ置き換えない。実機の例外本文は未採取のため、制御実験で再現した競合が観測時の唯一の原因だったかは未確定のまま。修正3ファイルの未コミット状態と、修正版native未導入を明示した1件として`LF-AUD-0006`へ記録した。
