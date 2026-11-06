# 固定SDKのCI診断

公開した`e9c9657`の[Native configuration](https://github.com/ponkichi1552/LiFlow/actions/runs/42222795479)は、Expo Doctorの依存版診断で失敗した。その他19項目は通過した。インストール済みExpoは58.0.22、lockfileも同じ版である。

実サービスの推奨表はsafe-area-contextを`~5.11.1`としたが、固定したSDKに同梱された表は`~5.10.1`で、実機検査済みの5.10.1に一致する。ほかにExpo関連8件の推奨差分があった。これら9件を更新済み・解消済みとは扱わない。

今回のCIは次の2段階に分ける。

1. 公式の`expo install --check --json`を`EXPO_OFFLINE=1`で実行し、インストールしたSDKに同梱される対応表で検査する。不一致は引き続きCIを失敗させる。
2. `expo-doctor@1.21.6`で残り19項目をオンライン検査する。先行段階で置き換えた依存版の照合だけを重複実行しない。

既存の脆弱性検査・ネイティブ設定の生成・Android Kotlinコンパイルは維持する。依存版の除外リスト、全体の診断無効化、依存パッケージの更新は追加しない。最新推奨への更新は、ネイティブ成果物と実機検査を揃える別の変更として扱う。

`EXPO_OFFLINE`と`install --check`の動作は[Expo CLI公式資料](https://docs.expo.dev/more/expo-cli/#environment-variables)と、インストール済みSDK58のCLI実装で照合した。`install --check`が実際に検査することも、隔離した2つのプロジェクトで確認した。5.10.1はexit0、5.11.1へ変更したfixtureはexit1で不一致を検出した。通常の作業コピーも対応表との不一致0、残りのDoctor19項目もPASSだった。[実測記録](qa-assets/google-tasks-2026-11-06/ci-sdk-baseline.json)。検査用ディレクトリは削除した。

アプリの710入力・依存lockfile・両端末の通常Release34・端末データは変更していない。今回の変更はCIと検査記録だけであり、SDK更新後の検査結果へ読み替えない。
