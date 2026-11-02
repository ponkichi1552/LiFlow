# LiFlowの月額契約方針（2026-11-01）

これは利用者と確定した製品方針であり、購入機能が公開済みという記録ではない。2026-11-02、StoreKit／Play Billingの購入・復元、既存APIによる購入確認、アカウント共通の利用権を実装中。検査と公開前の未設定項目は[実装記録](subscription-implementation-2026-11-02.md)に分ける。

## 利用単位と期限

- 無料の機能枠を設けない。1人分の契約を同じLiFlowアカウントのiOS・Androidで共通にする。グループ全員へ1契約を配る方式ではない。
- 月額90円程度を希望値とする。各ストアの商品・日本価格の登録後に確定する。購入画面にはストアから取得した価格を使い、希望金額を固定表示しない。
- 自動更新を解除しても支払済みの期限までは利用できる。ストアが認める支払い猶予を含め、有効な利用権を途中で取り上げない。期限切れ・返金による取り消し・利用停止を区別する。
- 利用権がなくなったら、家事管理・説明の閲覧・共有同期・Googleへの同期・AI・通知・Widgetの通常機能を停止する。購入、復元、契約管理、ログイン、必要なアカウント管理と法的案内へ進む操作は残す。
- 期限切れだけではSQLiteや暗号鍵を削除しない。アプリを残して再契約すれば保存済みデータを使える。Googleカレンダーへ登録済みの予定を削除しない。
- アンインストールすると端末内データは失われる。既存の共有クラウド記録やGoogleカレンダーまで連動して削除する指示ではない。OSバックアップの有無と、共有鍵を含む復旧可否は別に扱う。

## 構成

購入・購入復元・ストアでの契約管理はiOSのStoreKit、AndroidのGoogle Play Billingを使う。購入元と解約先を保持し、有効な契約を既に持つ人にもう一方のOSで二重購入を勧めない。

2026-11-01の利用者の選択により、既存Firebase／APIを利用して購入を検証し、認証済みLiFlow UIDへ利用権を紐づける。課金のための別の専用サーバーや新しい外部課金管理サービスは設けない。既存APIは公開準備中であり、この選択だけで本番の購入確認サービスが稼働したわけではない。

クライアントの「購入済み」フラグ、自己申告の期限、別利用者の購入トークンを信用しない。Appleの署名済み取引の検証とGoogleの購入トークン検証を分け、同じ購入の複数UIDへの流用、未決済状態、再送、アカウント変更、更新・失効・返金、通信切断を検査する。Googleのサービスアカウント鍵やAppleのサーバー用秘密鍵をアプリへ含めない。

有料AIは現在の認証・正規端末検証・回数制限に、サーバー側の有効な利用権確認も加える。画面だけの有料ロックでAPIを保護したとは判断しない。共有のクラウド権限にも利用権の境界が必要となる。

起動のたびに購入サーバーの返事で全画面を待たせない。保存済みの検証結果は、対象アカウント・署名・有効期限を確認した範囲で使い、起動・復帰時に状態を更新する。確認失敗を購入成功や新しい有効期限へ読み替えない。

## 公開前の条件

App Store ConnectとPlay Consoleでのアプリ・月額商品・価格・契約の登録、購入確認に使う権限と安全な資格情報の設定が必要。実際の購入・復元・更新・失効・返金・異種OS間の利用は、各ストアの検証環境で確認する。設定されるまでは課金のE2E完了や本番公開可能とは表示しない。

参照：[Apple currentEntitlements](https://developer.apple.com/documentation/storekit/transaction/currententitlements)、[Apple expirationDate](https://developer.apple.com/documentation/storekit/transaction/expirationdate)、[Google Billing統合](https://developer.android.com/google/play/billing/integrate)、[Googleの不正対策](https://developer.android.com/google/play/billing/security)、[Googleの契約状態](https://developer.android.com/google/play/billing/lifecycle/subscriptions)、[Expoのアプリ内購入](https://docs.expo.dev/guides/in-app-purchases/)。
