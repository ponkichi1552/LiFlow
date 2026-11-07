# 2026-11-07 開発ツール依存の追加修正

追加100件の監査後、利用者の指示でmoderate 15件の指摘も調査した。15個の独立したアプリ脆弱性ではなく、globとminimatchの2つのadvisoryがExpo CLI・Fingerprint・ESLintなどの依存元へ波及していた。

## 修正

- globを公式修正版14.0.4へ固定した。従来の移植修正は`walker.js`だけを変更しており、通常の公開入口が読み込む`index.min.js`には届いていなかった。公開入口のCommonJS／ESM、同期／非同期の4通りで中断後のディレクトリ読み取りを再現し、公式版で停止することを確認した。
- minimatchは7以上の利用元だけを公式修正版11.0.5へ固定した。ESLint等が関数として呼び出す3.1.5は別の依存として保持した。悪意あるパターンを生成途中で拒否し、通常パターン・Expoの除外指定・否定指定・iOS／Androidのファイル指定が動くことを検査した。
- 移植コードを削除し、postinstallではレビュー済みの公式バージョンを検査する。圧縮された公開入口も依存ファイルのSHA-256一覧へ含める。
- CIではroot・家電API・端末管理APIの依存監査をmoderate以上で失敗させる。

Expo SDK 58やReact Nativeの世代は変更していない。ネットワークから取得する最新SDK 58パッチの推奨値と、固定済み58.0.22に同梱された推奨範囲は異なるため、今回は後者と照合し、ビルド・lint・型検査・アプリ回帰検査で互換性を確認する。

## 証拠

- 修正前：通常のglob公開入口に対する中断検査で、中断後の読み取りを検出した。
- 修正後：セキュリティと互換性の検査9件が通過。
- `npm audit`：root・家電API・端末管理APIの全3ツリーで0件。moderate／high／criticalも0件。
- 台帳の100件とは別の追加対応であり、テスト調整を新しいアプリ不具合として加算していない。

公式の根拠：[glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)、[minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)。
