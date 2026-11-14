# 画面確認用の共通ドラッグツール

任意のMacアプリ・ブラウザー・シミュレーターの画面座標で「押す → 待つ → 移動 → 離す」を行う操作道具。固定のテストケースやLiFlow固有のラベル・端末ID・データ作成処理は持たない。画面の意味や保存成功は、操作後の実画面・保存状態で別に確認する。

```sh
python3 tools/computer-gesture/gesture.py info
python3 tools/computer-gesture/gesture.py drag \
  --window-id WINDOW_ID --image-width IMAGE_WIDTH --image-height IMAGE_HEIGHT \
  --from-x X1 --from-y Y1 --to-x X2 --to-y Y2 \
  --hold-ms 350 --move-ms 650 --end-hold-ms 150 --dry-run
```

`info`で最新のウィンドウID・位置・大きさを確認する。ウィンドウのスクリーンショットから選んだ座標は、`--window-id`と画像サイズを渡すとRetina倍率とウィンドウ位置を換算する。ウィンドウ指定を省く場合は、ディスプレイ左上原点のグローバル座標（point単位）。`--dry-run`を外すと実際に入力する。画面が変わったら座標を取り直す。対象ウィンドウは先に前面へ出す。`--activate`は指定アプリを前面へ出し、開始位置が別のウィンドウに隠れていないことを確認してから操作する。

## 押したままの画面を見る

```sh
python3 tools/computer-gesture/gesture.py drag ... \
  --session /tmp/gesture-UNIQUE --pause-held --pause-moved
python3 tools/computer-gesture/gesture.py resume /tmp/gesture-UNIQUE held
python3 tools/computer-gesture/gesture.py resume /tmp/gesture-UNIQUE moved
```

最初のコマンドを実行中のまま、`phase.json`の`held`（長押し後）と`moved`（移動後、離す前）で画面を撮影できる。再開ファイルが来るまで最大30秒待ち、止まった場合も最後の位置でマウスを離す。途中で離すと移動が確定するアプリもあるため、操作対象は事前に確認する。緊急時の`release`は現在位置で左ボタンを離す。

同時のツール操作はロックで防ぐ。操作中に人や他のツールがマウスを動かさないこと。権限は現在のmacOS許可を確認し、未許可の場合は入力せず失敗する。自動で許可を要求したりセキュリティ設定を変えたりしない。ビルドキャッシュは接続中なら外部ストレージ、なければ`/tmp`。`LIFLOW_GESTURE_CACHE`で変更できる。アプリのソース・DB・設定を直接変更しない。

実装はAppleの[Quartz Event Services](https://developer.apple.com/documentation/coregraphics/quartz-event-services)を使用する。シミュレーター操作に限定したXCTestのテストスイートとは独立している。
