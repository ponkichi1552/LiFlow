# ビルド依存の警告と挙動検査

2026-11-05の`npm audit --json`はrootがmoderate 22件、high／critical 0件。API側は0件。件数には依存元への波及を含む。警告を消す目的のExpo 51へのダウングレードや強制更新は行わない。

rootとAPIのlockfile、および実際にインストールされたコピーを照合した。glob 13.0.6が1コピー、minimatch 10.2.6が1コピー、ESLint系のminimatch 3.1.5が5コピー。[一覧と修正後のSHA-256](toolchain-copies-2026-11-05.json)を保存している。追加・版変更されたコピーを既存のrootパッチで修正済みと推測せず、回帰検査で再検討を要求する。

globはCJS／ESM、同期／非同期の双方で、中断後の新しいファイル読み取りが0件であることを検査する。minimatch 10はパターンの増幅制限・二次処理の上限・通常のファイル選択を検査する。3.1.5の全コピーは、別プロセスの3秒上限内で同じ種類の入力を与え、展開が1件のままであることと従来の関数APIを確認する。3系は今回の問題の前処理を持たないため、10系のパッチを機械的に適用しない。これらは今回の2件の問題に対する検査であり、全種類の入力の安全性を証明するものではない。

対象はExpo／lint等のビルド依存で、現行`src/`とAPIソースにこれらを直接利用する経路はない。バージョンを変更していないバックポートは、`npm audit`の警告表示を消さない。

一次資料：[globの公開アドバイザリ](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)、[minimatchの公開アドバイザリ](https://github.com/advisories/GHSA-g3hv-75wg-m249)、[minimatchの開発元修正](https://github.com/isaacs/minimatch/commit/77a0f5c)。

## 2026-11-06の再照合

rootの`npm audit`はmoderate 15件、high／critical／low 0件、API側は全件0。依存元への波及と版に基づく警告を含む。既知の2件への互換パッチは既に導入されており、全7コピーの実ファイルが上記一覧の修正済みSHA-256と一致した。今回の全3,452件にも、通常のファイル選択を保持しつつ中断・増幅を防ぐ回帰を含む。iOS v32の本番sourcemapにglob／minimatchのmoduleは含まれていない。警告を消すためのSDK変更は行っていない。
