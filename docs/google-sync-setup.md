# Google Tasks・Calendar連携のセットアップ

## 実装範囲

家事PlannerからGoogle Tasksへ名前と予定日を同期し、完了・完了の取り消しを双方へ同期します。専用Task Listの対応表にあるTaskだけを既存の完了履歴・家事状態・Schedulerへ取り込みます。Googleで完了を取り消すと対応する履歴を未完了へ戻し、予定を再計算します。履歴の行や他の家事の完了は削除しません。Phase 3では、任意のCalendar連携で予定が入っている時間だけを取得し、家事の候補日を調整します。家族間・複数端末同期は対象外です。

同期済み状態と未送信のローカル操作をSQLiteに保持し、通信失敗後も取り消しを再送します。同期中の新しい操作は古い送信の完了確認では消しません。旧版の対応表に同期済み状態がない場合は、初回同期で基準を確立し、未送信のローカル完了を優先します。GoogleでTaskそのものを削除する操作は完了取り消しと区別し、ローカル履歴を削除しません。

同期対象は有効な家事の今日以降の予定と期限超過予定です。Google Tasksに `家事Planner` というTask Listを使い、schedule entry IDとGoogle Task IDを端末内SQLiteで対応づけます。アプリから消えた未完了Taskは次回同期で削除し、完了済みTaskは履歴として残します。

GoogleのTasks scope (`https://www.googleapis.com/auth/tasks`) は広い範囲のTasksデータにアクセスできます。設定画面で同期する家事名と予定日を送信すること、接続解除後も既存Google Tasksを残すことを案内します。

## OAuth方式とバックグラウンド制約

このアプリはサーバーを持たないため、Google公式のiOS/Androidネイティブ認証SDKでユーザー認証とaccess tokenの更新を行います。アプリ独自のSecureStoreやSQLiteへOAuth tokenを保存せず、Google SDKの資格情報管理を使います。offline access / server auth codeは要求しません。iOSではアプリ再起動後にSDKのサイレント復元を試み、AndroidではSDKに保存されたセッションを使います。自動同期から対話的なログイン画面は開きません。

Expo BackgroundTaskはWorkManager (Android) とBGTaskScheduler (iOS) を使います。指定値は60分の最小間隔で、実行時刻はOSが決めます。実行間隔、iOSでのオフライン更新、アプリを明示終了した後の実行は保証しません。起動時・アプリ復帰時にも期限を確認し、前面同期を試みます。

GoogleのモバイルSDKとExpoのバックグラウンド制約を確認する資料:

- [Expo Google authentication](https://docs.expo.dev/guides/google-authentication/)
- [Expo SDK 58 BackgroundTask](https://docs.expo.dev/versions/v58.0.0/sdk/background-task/)
- [Google Sign-In iOS API access](https://developers.google.com/identity/sign-in/ios/api-access)
- [Google Sign-In iOS offline access](https://developers.google.com/identity/sign-in/ios/offline-access)
- [react-native-nitro-google-signin](https://github.com/react-native-nitro-google-sign-in/google-signin)

## Google Cloud Console

1. Google Cloud projectを作成または選びます。
2. Google Tasks APIを有効にします。
3. OAuth consent screenを設定し、開発中はアプリをTestingにして利用するGoogleアカウントをtest usersに加えます。公開・検証要件はGoogle Cloud Consoleの表示に従ってください。
4. Web application OAuth client IDを作成します。ネイティブSDKの `webClientId` として使います。
5. iOS OAuth client IDを作成します。Bundle IDは `jp.jphacks.tkb2633` です。iOS clientのReversed client IDも控えます。
6. Android OAuth clientを作成し、package name `jp.jphacks.tkb2633` と、実際に使う開発・配布署名鍵のSHA-1 fingerprintを登録します。EAS credentialsを使う場合は `npx eas-cli@latest credentials -p android` で署名情報を確認してください。

### Calendar連携を使う場合

1. Tasksと同じCloud projectで **Google Calendar API** を有効にします。APIライブラリで検索し、画面が「有効」になったことを確認してください。
2. Google Auth Platform → データアクセスで `https://www.googleapis.com/auth/calendar.freebusy` を追加・保存します。既存の `https://www.googleapis.com/auth/tasks` は残します。Calendar全体やEvent一覧、CalendarListのscopeは追加しません。
3. アプリをGoogle Tasksへ接続してから、設定の「Googleカレンダーの予定を家事日調整に使う」をONにします。この操作のときだけCalendarの追加許可を要求します。Tasksへの初回接続では要求しません。
4. 追加許可を拒否した場合もTasks同期は利用できます。設定のCalendar欄から再許可できます。自動同期は許可画面を開きません。

既存のWeb・iOS・Android OAuth clientを使います。Calendar用のAPIキーやclient secret、追加の環境変数は不要です。Cloud側でscopeを登録しただけでは端末への追加許可は完了しないため、アプリ内でONにしてください。

対象は接続したアカウントのprimary calendarのみです。アプリが呼ぶのは[FreeBusy API](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)で、予定のタイトル・説明・場所・参加者・Event IDは取得しません。返却された時間帯はメモリ内で重複をまとめ、端末のIANA timezoneの日付ごとに集計します。SQLiteには日付・busyMinutes・timeZone・取得時刻だけを保存します。

Schedulerと同じ今日〜180日先を取得します。2026-10-25の実APIでは181日を一括取得すると期間超過で拒否されたため、HTTP通信だけを最大90日ずつへ分割しています。この期間では3 POSTになり、全リクエストが成功してから181日分のcacheを一括更新します。Schedulerの期間や既存Tasksの件数は短縮しません。

Calendar取得は通常24時間、通信失敗・timeout・5xxは約1時間後に再試行し、429および403の`rateLimitExceeded` / `userRateLimitExceeded`は`Retry-After`も尊重します。API無効やその他の恒久4xxはCalendar欄に取得エラーを表示します。36時間を超えたcacheや現在のtimezoneと異なるcacheは予定計算に使いません。Calendarの失敗状態はTasksと別に表示し、Tasksの送信・完了取込を継続します。

CalendarをOFFにすると日別cacheを消去し、Calendar情報なしで予定を再計算します。OFF中のCalendar APIリクエストは0件です。移動した家事は既存Taskのdueを更新します。Googleへの接続やTasks同期は維持します。現在のUIではTasks自動同期を有効にしてからCalendarをONにしてください。

OAuth client IDは公開識別子であり、アプリへ設定できます。client secret、access token、refresh tokenはこのアプリへ追加しないでください。値はGoogleのコンソールが発行したものだけを使い、推測・仮生成しません。

## ローカル開発

`.env.example` を `.env.local` にコピーし、Google Cloud Consoleで発行されたWebとiOSのclient IDを入れます。`.env.local` はGitに含めないでください。

```text
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<Web client ID>
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<iOS client ID>
```

`app.config.js` はiOS client IDからReversed client IDを生成し、両方のclient IDが揃った場合にだけGoogle Sign-In config pluginを有効にします。既存のOAuth画面と同じ環境変数名なので同一の `.env.local` を利用できます。以前の `GOOGLE_WEB_CLIENT_ID` / `GOOGLE_IOS_CLIENT_ID` / `GOOGLE_IOS_REVERSED_CLIENT_ID` も互換入力として利用できます。値が未設定でもアプリ設定とテストは読み込めますが、設定画面の「Googleと接続」は無効のままです。

値を設定した後はネイティブ開発ビルドを再生成します。`ios/` と `android/` は生成物なので直接編集しません。
Googleからアプリへ戻るiOS URLは、config pluginでGoogle Sign-In SDKへ転送します。Expo SDK 58のscene lifecycleからAppDelegateへの転送を利用します。

```bash
npx expo run:ios
npx expo run:android
```

EAS development buildでは同じ変数をビルド環境に設定してから実行します。

```bash
npx eas-cli@latest build --profile development --platform ios
npx eas-cli@latest build --profile development --platform android
```

OAuth client IDを設定せずに構成を確認する場合:

```bash
npx expo config --type public
```

Google Sign-Inはネイティブmoduleを使います。Expo Goではなくdevelopment buildで実機または対応シミュレータを使ってください。

Phase 3ではAndroid SDKの`getTokens()`が自動処理から許可画面を開かないよう、`postinstall`で依存パッケージへパッチを適用します。追加scopeで対話が必要になった場合は、許可済みの基本scopeだけでサイレント取得を試み、Calendarの再許可をTasksから分離します。Androidはパッチを含む新しいdevelopment buildが必要です。追加許可が必要な場合はCalendar欄に再許可を表示します。iOSのPhase 3追加には既存Google Sign-In対応ビルドを利用できます。Androidビルドと物理端末でのBackgroundTaskは別途検証が必要です。

## 同期動作と状態

- 成功後24時間経過すると次の通常同期対象になります。
- 一時通信障害・timeout・5xxは約1時間後に再試行します。
- HTTP 429は`Retry-After`を尊重し、1時間より早く再試行しません。
- 401やGoogle SDKのサインイン要求は再認証状態になります。
- 手動同期は24時間間隔を無視します。
- Google Tasksへのリクエストに期限20秒を設定します。
- 同期状態とTask ID対応表はSQLiteに保存します。Google tokenはSQLiteへ保存しません。
- BackgroundTaskが登録できない場合も、接続直後・起動時・アプリ復帰時・手動操作の前面同期は利用できます。
- Google側の完了を全ページ取得して取り込んだ後、アプリ側完了・名前・予定日を反映し、不要な未完了Taskを整理します。
- 完了の取得では`showCompleted=true`・`showHidden=true`を必ず指定します。対応表にないTaskは名前が一致しても無視します。
- Googleの明示的な完了日時がないTaskは履歴へ取り込まず、診断件数を記録します。

## 実機テスト

1. `.env.local` に正しいOAuth client IDを設定してdevelopment buildを作ります。
2. Google Tasksを使うtest userでアプリから接続し、Google Tasks scopeを許可します。
3. 設定画面から「今すぐ同期」を実行し、Google Tasksの `家事Planner` listに今日以降の予定が作られることを確認します。
4. 家事名・予定日変更、アプリ側完了、ローカル家事無効化・削除、Google側Task削除をそれぞれ試し、同じTaskの更新・完了・cleanup・再作成を確認します。
5. Google側のUIで対応Taskを完了し、アプリで手動同期します。Googleの完了日時で履歴が1件追加され、次回予定が更新され、再同期・再起動でも履歴が増えないことを確認します。Googleで完了を取り消すと、同じ履歴が未完了へ戻ります。アプリ側の取り消しも、同じGoogle Taskを未完了へ戻します。再度完了しても履歴やTaskが重複しないことを確認します。
6. 接続解除し、ローカルbackground taskが停止し、Google上の既存Taskが残ることを確認します。

2026-10-25にGoogle Cloud project `housework-planner-tkb2633` でTasks APIを有効化し、外部・テスト中のOAuth同意画面、Web・iOS・Android開発用の各クライアント、所有者アカウントのテストユーザー登録、Tasks scopeを設定しました。Web・iOSの公開client IDは、この端末のGit管理外の `.env.local` に設定済みです。

Android開発用クライアントは、既存のローカルdebug署名に対応しています。EASやGoogle Playの配布署名を使う場合は、その署名に対応する別のAndroidクライアント登録が必要です。

2026-10-25、専用のiOS Simulatorのdevelopment buildで、所有者本人によるGoogleログインとTasks権限許可後に初回同期が成功しました。12:20 JSTの端末SQLiteを読み取り専用で確認し、同期状態 `idle`、同期有効、Task List ID保存済み、エラーなし、1種類の家事の予定180件にそれぞれ異なるGoogle Task IDが保存されていることを確認しました。対象日付は2026-10-26〜2027-04-23です。

Google Calendarへの表示も所有者本人の操作と2026-10-25 12:25 JSTの提供画像で確認しました。画像にある10月26〜31日の各日に「食器を洗う」が1件ずつ終日欄に表示され、端末に保存された予定日と一致しています。これは初回同期後の表示確認であり、再同期時の重複なしを示す結果とは分けて扱います。

手動再同期後も10月26日のTaskが1件のままであることを所有者本人が確認しました。端末SQLiteでも12:26:15 JSTの成功同期、エラーなし、対応表180件を確認し、初回同期後と再同期後でschedule entry ID・Task List ID・Google Task IDの全組み合わせが一致しています。同じ予定を再作成せずに再同期できています。

アプリ内カレンダーから10月26日の「食器を洗う」を完了にし、Google側も完了状態になったことを所有者本人が確認しました。Google側の完了をアプリへ取り込む操作は行っていません。

アプリの完全終了後もGoogleへの再ログインは不要だったと所有者本人が確認しました。一方、その際に中断前の `syncing` 状態が残り、通信を実行しないまま成功メッセージが出る問題を端末記録から検出しました。手動同期では現在のプロセス内の実行中Promiseを共有しつつ、中断した保存状態から再実行できるよう修正し、スキップした場合は成功メッセージを表示しないようにしました。

修正後、所有者本人が手動同期の完了表示を確認しました。12:36 JSTに端末SQLiteを再確認し、12:34:09 JSTに開始した同期が成功状態 `idle` に戻り、最終成功同期の記録も更新され、再試行回数0・エラーなしであることを確認しました。対応表180件の全IDは初回同期後と同じで、ローカル完了記録2件も保存されています。

ここまでの記録はPhase 1時点のものです。Phase 2の完了取込とPhase 3の予定日変更は、それぞれの確認レポートを参照してください。iOS SimulatorではBackgroundTaskの実動は未検証です。

この実アカウント確認は、最新main `e14e085` へ取り込む前の同期用ブランチで行ったものです。最新mainの家事カード重複防止と設定アコーディオン改善を取り込んだ後も、lintと型チェックは通過しました。確認範囲と残項目は [実装・確認結果](./google-sync-phase1-report.md) にまとめています。

Phase 3の範囲・実Google確認・残項目は [Calendar連携の確認結果](./google-sync-phase3-report.md) にまとめています。

## 再認証・アカウント変更（2026年11月12日）

- 設定の「Googleアカウントを変更」は、共有へのログインがない個人利用でも使える。個人利用ではGoogleの選択だけを行い、Firebaseへのログインを新しく作らない。共有でログイン中の場合は、そのセッションも選択したGoogleへ切り替える。
- Calendarは保存済みのON設定だけで接続済みと判断しない。本人のNativeセッションと必要な権限を確認し、未接続は「Googleと接続」、認証切れは「Googleに再接続」、接続済みで同期を有効にした場合だけ「今すぐ同期」を表示する。確認中も区別し、同期と再接続のボタンを重ねない。通信エラーで認証エラーが解消したとは扱わない。
- 再接続は、明示的なアカウント選択、必要な権限の再許可、接続の保存、差分同期の順で復旧する。Tasksの再認証も対象のアカウントを選択し、その接続を有効化してから再試行する。
- iOSの保存済み資格情報の復元が失敗しても、利用者が押した認証操作ではログイン画面へ進める。バックグラウンド・状態確認からログイン画面や追加権限の確認を開かない。
- アカウントを変えると、以前の対応表・取得位置・送信待ちはアカウント別に保管し、元のアカウントへ戻ると復元する。ローカルの家事・完了履歴は保持する。キャンセルでは接続を解除せず、選択と保存の間にアカウントが変わった場合は保存を拒否する。
- アカウント設定の末尾に変更とログアウトを配置する。共有ログインがなくてもGoogle連携後はログアウトできる。画面のログアウトは個人のTasks／Calendar同期を停止し、Nativeの資格情報を終了する。Firebaseでログイン中なら、その同じ利用者もログアウトする。Google上の予定・タスク、端末内のデータ・対応表・送信待ちは削除しない。進行中の資格情報の復元・更新が終わってから終了させ、遅い応答でログイン状態が復活しないようにする。
- 同じ画面に留まったままのログアウト・アカウント変更もCalendar欄へ通知し、接続状態を再確認する。変更前に始まった遅い確認結果で、古い「今すぐ同期」を復活させない。
