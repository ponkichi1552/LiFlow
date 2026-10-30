# アプリの構成

## 基本方針

- 通常の家事管理は端末内で完結する。保存先はExpo SQLite。
- スケジュールの生成・再生成はオフラインで動く。
- 天気、AI、アカウント／端末間同期などの外部処理は機能ポートの後ろに分離する。
- 天気・Google連携・家電AI・暗号化共有は、明示した設定や操作に従って外部サービスへ接続する。グループv2の未実装機能は、[設計と進捗](sharing-v2/05-progress.md)を既存動作と区別する。

## アプリの導線

- `src/app/(tabs)/index.tsx`: 初回設定、今日と近い家事、ゴミ収集日、完了操作
- `src/app/(tabs)/explore.tsx`: 月間カレンダー。複数日にまたがる実施期間を表示
- `src/app/(tabs)/guide.tsx`: 選択した家事の見出し、手順、道具、注意事項、個別履歴への導線
- `src/app/(tabs)/manual/`: 家電一覧、説明、公式資料による再解析
- `src/app/chores/`: 家事一覧、検索、設定画面から開く個別設定、家電登録・家電詳細・公式資料による再解析
- `src/app/history.tsx`: 全体または家事別の完了・未完了の履歴
- `src/app/settings.tsx`: 頻度、休日、負荷上限、カテゴリ別の家事設定、機能接続状態
- `src/app/waste.tsx`: 毎週・隔週・毎月のゴミ収集日を登録・編集・削除し、次回予定を表示
- `src/features/onboarding/first-run-setup.tsx`: 初回設定を6段階で入力。市区町村の任意確定と、最後のゴミ収集日の登録・スキップを含む

## 保存と初期データ

- `src/platform/storage/migrations.ts`: 世帯、メンバー、家事、割り当て、依存関係、予定、完了、曜日、同期待ち変更、天気、家電スナップショット、通知許可、非表示ゴミ予定のスキーマ
- `src/features/google-sync/`: Google Tasksの双方向同期・BackgroundTask、Calendarの追加許可・日別集計・独立した取得状態と共通の操作キュー
- `src/platform/google-tasks/`: Google Sign-In SDK、Google Tasks API、Calendar FreeBusy APIのadapter
- `src/platform/storage/repository.ts`: 初期マスター投入、SQLite読み書き、初回設定、完了・未完了の記録と予定再生成
- `src/domain/chores/catalog.ts`: 組み込み20件の家事名、手順・道具・注意点・豆知識・負荷、各家事の3つの頻度モードの周期と期間幅
- `src/domain/chores/types.ts`: 家事、実施状態、完了・未完了記録、世帯設定の型
- `src/features/appliance-care/contracts.ts`: 安定IDを持つ家電親データと、最新のユーザー確認済み公式解析スナップショット

家事一覧と周期案は企画書で未確定です。現在のマスターは動作確認用の初期案で、家事単位の周期は設定画面から編集できます。初期設定で「今日／1週間前／1か月前」を選んだ日付は概算の印を保持します。「不明」とスキップは初回分散に入り、履歴は削除しません。

SQLiteのスキーマは `PRAGMA user_version` で段階的に更新します。予定は同じエンジンから再生成し、履歴は独立テーブルに残します。同じ予定の未完了記録は後から完了へ更新でき、`schedule_entry_id` の一意制約で二重記録を防ぎます。

### 共有Snapshotと更新

`SQLiteProvider` 直下の `PlannerDataProvider` が、前景のSnapshot・AppState購読・日付タイマー・Widget完了の読込を管理します。画面は `usePlannerData` から同じSnapshotを購読し、保存・完了・取り消し後に共有refreshを要求します。家電解析結果の保存もこの経路を使います。

`createPlannerRefreshController` は連続要求をまとめ、変更中に得た古い結果を公開しません。`readCachedPlannerSnapshot` はDBを書かないメモリ参照で、変更・日付・timezone・Calendar期限切れで無効になります。復帰時とWidget操作時は別接続の変更を考慮して読み直します。`loadPlannerSnapshot` は引き続き必要な再生成と保存を含む明示的な更新APIです。

通常の画面更新に伴うWidget・通知の公開はProviderへ集約します。Google取り込みも前景の購読者が処理し、バックグラウンドでは従来の出力adapterを使います。SQLite移行は未適用分全体を1トランザクションで確定し、schema v16にGoogle同期状態とCalendarの反映済み署名を保持します。

### 個別設定の自動保存と文字の共通設定

個別家事設定は `useChoreSettingsAutosave` と `createAutosaveQueue` で保存します。切り替え操作は即時、数値は450ms入力が止まった時点で保存し、入力終了・戻る操作・フォーカス離脱・バックグラウンド移行で保留中の有効値を確定します。保存は1件ずつ実行し、処理中の追加編集はまとめて次へ送ります。失敗した変更は保持して再試行でき、入力を消した項目が古い失敗データから復活することを防ぎます。周期の入力を空欄で終了した場合は、組み込みの初期値・メーカー推奨へ戻し、メーカー周期のない家電では予定を無効にします。

Repositoryの `updateChoreSettings` は、キュー内で最新のDB行を読み、編集した項目だけ反映します。未編集の説明・手順・周期・完了履歴を古い画面データで置き換えません。値が変わらなければDB書き込みと予定の再計算を省略します。

アプリ画面の文字サイズと行間は `src/components/planner-typography.ts` に集約しています。タイトル28、見出し22、家事名19、本文17、補足14を基本とし、操作ラベル18、短いラベル16、カレンダー・タブの専用役割を定義します。戻るボタンと主要ボタンのタップ高さは48以上を維持します。ウィジェットの独立したネイティブ描画は別のサイズ制約で扱います。

## スケジューラ

- `src/domain/scheduling/engine.ts`: 全家事に共通する周期・期間・休日・負荷・依存関係のエンジン
- `src/domain/scheduling/local-date.ts`: タイムゾーンによる日付ずれを避ける日単位の計算
- `src/domain/scheduling/contracts.ts`: エンジン入出力と設定契約

現在から180日先までの期間を生成します。未完了家事は期間を過ぎても1つの超過予定として保持し、その再提案日を日ごとの負荷に合わせて配置します。経過周期数も記録し、次の周期案を続けて表示します。未完了記録だけでは周期の起点を変えず、通常の完了は実際の日を新しい基準日にします。実施期間がまだ始まっていない未来の完了は操作日時を履歴に残し、推奨日が来てから周期へ反映します。この扱いはGoogleからの完了取込にも共通です。

組み込み20件の周期と期間幅は、`catalog.ts` の各項目の `frequencyDaysByMode` と `windowRadiusDays` に明示します。負荷から周期や期間幅を一律に決めません。初期値と根拠は [家事ガイド](housework-guide.md#scheduler用の負荷周期実施可能期間) に掲載しています。日次4件は全頻度モードで1日周期、期間幅・移動幅0日です。ユーザーの個別周期は頻度モードより優先します。

内部推奨日は実施期間の中から選びます。まず期間内で負荷を分散し、休日優先の家事は設定休日を含む期間を選びます。期間を移動する場合は家事ごとの `maxShiftDays` を上限とします。重い家事は初期1日1件、普通は1日2件、軽い家事は上限なしです。上限と期間幅は設定・家事詳細で変更できます。軽い家事も指定された期間幅を使用し、負荷の変更だけでは周期や期間幅を変えません。

組み込みカタログversion 3への移行では、旧デフォルトと一致する設定だけを項目・頻度モード単位で更新します。ユーザーの個別周期、変更済み設定、有効状態、完了履歴は保持し、設定が変わる家事の生成済み予定だけを破棄して再生成します。旧デフォルトと同じ値を明示保存したかどうかは、旧版のデータからは区別できません。

依存関係は「先に行う家事」から「後に行う家事」へ保存し、後の家事の推奨日が先の家事より前にならないようにします。循環する依存関係は保存前に拒否します。

Calendar連携がONで36時間以内・同じtimezoneの日別cacheがある場合は、候補の`abs(offset)`に`busyBucket × load別の日数相当値`を加えます。bucketは0〜120／121〜300／301〜480／481分以上、日数相当値はlight=1、normal=2、heavy=3です。日ごとの負荷上限・restDaysの優先順位を保ち、busyな候補も除外しません。Calendarなし・OFF・期限切れでは従来と同じ入力になります。cycle基準のschedule entry IDを維持するため、日付変更は同じGoogle Taskへのdue PATCHになります。

## ゴミ収集日

- `src/features/waste/weekly-scheduler.ts`: 毎週・基準日から14日ごと・毎月指定日を展開する純粋関数。指定日が存在しない月は月末
- `src/features/waste/waste-schedule-editor.tsx`: 初期設定と設定画面で共有する検索・周期・曜日・開始週のフォーム
- `src/features/waste/calendar-labels.ts`: 毎週は曜日見出し、隔週・毎月は対象の日付へ表示する区分
- `src/features/waste/contracts.ts`: 曜日設定、収集日、例外取得・適用ポート
- `src/features/waste/occurrence-visibility.ts`: 特定の収集区分・日付だけを隠す表示抑制。曜日ルールや次週以降には影響しません

収集区分は入力ごとに端末内の候補を検索し、ひらがな・カタカナ・別名から選べます。自治体独自の区分は入力した名前も選択できます。初期設定の6段階目で登録・編集でき、スキップもできます。周期・曜日・基準日はSQLiteへ保存し、ホーム・カレンダー・ゴミ収集日画面で共有します。スキーマv17は現行v16と、旧ゴミ機能ブランチの別系統v13の両方をデータ保持して移行します。

「今回は表示しない」は、その収集区分・日付の1回だけに適用する手動の例外指定です。通常曜日と次週以降を保ち、再表示もできます。「次の収集日」は初期状態で収納し、見出し行で開閉します。祝日に基づく自動振替や収集中止の自動判断は実装していません。

## 通知とウィジェット

- `src/features/notifications/contracts.ts` と `src/platform/notifications/`: 日時指定の端末内通知ゲートウェイ
- `src/features/widgets/contracts.ts` と `src/platform/widgets/`: 今日の家事スナップショットと、iOS SwiftUI / Android Jetpack Compose のウィジェット

初回設定と設定画面に通知ON/OFFを表示します。通知許可があり、設定がONの場合は毎朝9:00に、その日に実施期間へ入る家事・期間最終日の家事・期間終了翌日の家事をまとめて通知します。すでに完了した家事は除き、期間終了翌日を過ぎた家事には通知しません。ウィジェットはiOS systemSmall（2×2）とsystemMedium、Androidは2×2に対応します。今日の実施期間内と期間終了翌日の家事を優先順で最大3件表示し、丸を押すと完了できます。完了した家事はチェック付きで残ります。

## 外部機能

### Google Tasks・Calendar

Tasksは専用リストの対応表にある家事だけを送信・完了取込します。任意のCalendar連携は、設定でONにしたときだけ`calendar.freebusy`を追加許可し、primary calendarのFreeBusyを取得します。Event一覧や予定内容は取得せず、raw busy intervalも保存しません。schema v15の日別cacheは日付・分数・IANA timezone・取得時刻を保持し、Calendar設定・retry状態はTasksと別テーブルです。

完了と完了取り消しは同期時に双方向へ反映します。同じTaskと履歴行を使い、未送信のローカル状態とrevisionをSQLiteに保存します。送信の失敗や送信中の新しい操作で取り消しが消えないようにし、未送信のローカル操作を古いGoogle情報で上書きしません。Task自体の削除は履歴の取り消しと区別します。Calendarの取得時刻や同じbusy区分内の変化だけではPlannerを再生成せず、日付・busy区分・利用可否が変わった場合に再計算します。

同じGoogle同期キューでCalendar更新・Scheduler再生成・Tasks同期を順に実行します。CalendarのHTTP失敗や追加許可不足でもTasksは継続します。Plannerの180日先までの全期間を最大90日ずつのHTTP要求に分け、すべて成功してから日別cacheと成功状態を1つのtransactionで置換します。OFF時はcacheを削除しAPIを呼びません。認証は既存のGoogle native SDKと`offlineAccess=false`を維持します。セットアップは[Google連携](./google-sync-setup.md)を参照してください。

家事の完了・取り消し直後はTasksを即時同期しますが、Calendarは通常の24時間・失敗時再試行の判定に従います。設定の「今すぐ同期」では両方を明示的に更新します。完了操作による同期は、別実行中の新しい同期状態を手動復旧として上書きしません。

### 天気

- `src/features/weather/open-meteo-geocoder.ts`: 初回設定または設定画面に入力された市区町村名を日本国内に限定して検索し、市区町村・都道府県だけを候補表示
- `src/features/weather/open-meteo-provider.ts`: 選択地域の座標からOpen-Meteo の7日分の日別予報を取得し、配列長・日付・数値を検証して内部型へ変換
- `src/features/weather/laundry-policy.ts`: 降水確率30%以下、降水量0.5mm以下、晴れ〜曇りのWMOコードを満たす日のみを候補化
- `src/features/weather/optimize-laundry-schedule.ts`: 予報取得失敗時に入力スケジュールをそのまま返す最適化境界

初回設定または設定画面でユーザーが市区町村名を入力すると候補を自動検索し、候補を確定した場合だけ動作します。入力文字列をOpen-Meteo Geocoding APIへ送り、日本限定の候補から選んだ市区町村・都道府県と地点の座標をSQLiteへ保存します。天気予報取得にはその座標を使います。端末の位置情報APIや権限は使いません。スキーマv6への移行時に以前保存した端末位置の座標を消去します。通常の予定は天気取得を待たずに表示し、予報結果は後から反映します。既存スケジューラの出力に対して、今後7日以内の洗濯家事だけを調整し、移動範囲、日ごとの負荷上限、依存順を再確認します。初回保留と完了済み予定は固定します。天気取得や必要データが失敗した場合はルールベースの予定を維持します。干し方希望は引き続き手動設定です。

天気による再配置でもCalendarの日別busy penaltyを候補日の移動距離に加算します。乾きやすさ、負荷上限、依存順、同じ家事の周期順序を満たす候補から選びます。完了IDのある記録と古い形式の完了記録を共通の適格性判定で除外し、対象がない場合は予報APIを呼びません。

予報HTTPとsnapshotの天気評価は15分間再利用します。同時評価は共有し、変更のない結果では同じsnapshotを返し、DB書き込み・Widgetや通知の再公開を増やしません。調整前の通常予定を保持し、予報更新時にもその予定から評価します。予報失敗時は表示とSQLiteを同じ通常予定へ戻し、失敗結果は60秒間再利用します。日付・timezone・設定・Calendar・snapshotが変わった後の古い結果は保存しません。全日分の値が不明の場合も取得失敗として表示します。

数値入力は `src/components/number-input-field.tsx` を家事個別設定・家電解析結果・毎月のゴミ収集日で共有します。本文の行間を入力欄へ適用せず、ネイティブの一行入力の高さを使い、左右同じ幅の単位欄で数字の中央位置を揃えます。

### 家電AI

- `src/app/(tabs)/manual/appliance-care.tsx`: メーカー、製品名、型番・日本語カテゴリ候補の入力、解析の2段階表示、結果の自動保存、周期の変更
- `src/app/(tabs)/manual/appliances/[id]/index.tsx`: 家電単位のお手入れ一覧、周期なし項目、出典、再解析導線
- `src/features/appliance-care/api-client.ts`: ExpoからAPIサーバーを呼ぶクライアント。iOS/Android Emulatorの初期URLと実機用環境変数を持つ
- `src/features/appliance-care/contracts.ts`: 解析draftと公式出典の既存契約
- `src/features/appliance-care/to-chore-definition.ts`: 承認された解析taskを家電ID・task名・user override付きの既存 `ChoreDefinition` へ変換
- `src/features/appliance-care/persistence-policy.ts`: 有効周期、周期なしtaskの除外、完全一致名の重複防止、再解析時の設定保持
- `server/appliance-care-api/src/product-resolver.mjs`: 公式ドメイン限定の製品同定
- `server/appliance-care-api/src/manual-resolver.mjs`: 公式資料の検索、PDF優先、URLとリダイレクト検証
- `server/appliance-care-api/src/manual-analyzer.mjs`: PDFまたは公式Web資料をOpenAI Responses APIへ渡し、構造化結果を検証
- `server/appliance-care-api/src/openai-responses-client.mjs`: サーバー専用のAPIキーでResponses APIを呼び出す

`POST /api/appliance-care/jobs` は構造化されたメーカー名・製品名・型番を受け、job IDを返します。クライアントは `GET /api/appliance-care/jobs/:id` をポーリングして、`product_verification` と `official_manual_analysis` の2段階を実際の処理状態から表示します。完了結果は `verified`、`ambiguous`、`not_found`、`error` に分類します。Product Resolverが明確に一致した製品だけをManual Resolverへ渡します。検索候補と最終URLの両方が許可された公式ドメインに一致しない場合は採用しません。PDFが特定できたときは公式PDF URLをResponses APIの `input_file` として渡し、AIにはメーカー資料から根拠のあるお手入れだけをJSON Schemaで抽出させます。条件型の手入れに数値周期を推測させず、evidence URL、タスク重複、文字列長、周期範囲をコード側でも検証します。互換用の `POST /api/appliance-care/analyze` も残しています。

AI結果は `requiresUserReview: true` のdraftです。解析がverifiedで完了すると、家電親データへ解析task全件、公式製品URL・説明書URL・taskごとのページ／節、解析日時を自動保存し、画面で内容確認を促します。メーカー周期ありtaskは選択操作なしで既存Schedulerへ登録します。明示的にユーザー周期を入力したtaskも予定に入り、周期なしtaskは `ChoreDefinition` を作らず家電詳細に「定期予定なし」として残します。メーカー周期と `userIntervalDays` は別フィールドです。ユーザー周期を解除するとメーカー周期へ戻ります。完全に同じ家事名だけは重複登録しません。

家電の再解析は新しいverified draftを自動保存し、画面で内容確認を促します。周期変更も同じ家電IDに保存し、ユーザーが無効にした項目を勝手に有効に戻しません。家電親のメーカー・製品名・型番は再解析画面で固定し、Repositoryでも照合します。完全一致したmaintenance task名に限って既存taskと対応付け、家事ID、user override、負荷・期間などの設定、完了履歴を維持しながらメーカー解析情報を更新します。解析結果にないtaskは自動予定から外し、過去の記録を参照できるよう家事定義は保持します。外部出典リンクはHTTPSと登録済みメーカー公式ホストを確認してから外部ブラウザへ渡します。

APIは特定クラウドに依存しないNode.jsモジュールです。ローカルは `npm run api:dev` で起動し、`OPENAI_API_KEY` はAPIサーバーの `.env.server` にのみ設定します。`.env.server.example` は空のキー欄を持つ雛形です。Expoクライアントにはキーを含めません。実OpenAI APIは手動E2Eに限り、通常テストではHTTP、検索結果、説明書取得、AI出力をmockします。

このHTTPサーバーは開発専用です。公開用の利用者認証・分散した費用制限がない状態で本番起動しないよう、`NODE_ENV=production` はHTTPサーバーの生成時点で `DEVELOPMENT_API_ONLY` として拒否します。通常の起動関数と、サーバーを直接生成する経路の両方を検査します。この起動ガード自体を公開用の認証とは扱いません。開発用の待受先は従来どおり維持するため、利用するネットワークは信頼できるローカル環境に限ります。

### 担当者・家事の依存関係

現在の画面では担当者の割り当てと、家事同士の依存関係を設定できません。既存データの移行互換性のため、メンバー・割り当て・依存関係のSQLiteスキーマとドメイン型は残しています。

## テストとCI

- `tests/scheduling.test.mjs`: 周期、初回負荷分散、休日、超過、依存順、循環検知
- `tests/weather.test.mjs`: 地域検索応答と予報応答の検証、WMO・降水条件、負荷・依存・完了制約、失敗時フォールバック、冪等性
- `tests/google-calendar-*.test.mjs`: FreeBusy、IANA timezone・DST、集計・cache・migration、追加許可、Calendar障害とTasksの分離、候補日scoreと天気の回帰
- `npm run check`: lint、TypeScript型チェック、単体テスト
- `.github/workflows/ci.yml`: Pull Requestと `main` pushで `npm ci` と `npm run check`
- `.github/workflows/native-check.yml`: Native関連変更時にExpo Doctor・Android Prebuild。手動実行の `compileAndroid` 指定でAndroid debugのコンパイルも実施

## ネイティブ開発

Expo Widgetsはネイティブ拡張を含むため、iOS・Androidの開発ビルドで確認します。`ios/` と `android/` は生成物でGit管理しません。
