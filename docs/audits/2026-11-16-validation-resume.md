# 216候補検証の再開記録

記録作成: 2026-11-16T05:03:29.956847+00:00。利用者は既存216候補の機能・実機・通信最小化検証の継続を指示した。全ページUI/UX監査と1,000件目標は引き続き対象外。この記録は以前の8:15区切りを保持したうえで、保存済み証拠と後から確定したCIを再整理する。証拠整理担当は実機・認証・Cloudを操作していない。

## 継続の基準

- canonical main: `c3d65d68c70ecf4649206f70846387a365ac110d`。導入済みアプリのコード: `ef07838a6fecb9933d80888ed0e529b731f2d553`。mainの最後の差分は記録であり、導入コードと区別する。
- 検証データは保持する。掃除を目的とする削除・解除・鍵の初期化を行わない。
- 有料OpenAI実APIは保留。配送切替フラグ0、削除workerの新規配備なしを維持する。
- `cases.jsonl` 216行と旧`results.jsonl` 31行、旧8:15記録、私的fff35df棚卸しは変更しない。新規[観測・候補対応JSONL](../qa-assets/physical-2026-11-15/resume-observations-2026-11-16.jsonl)へ追跡可能な別記録を作成した。
- 機器ID、アカウントID、credentials、追加の私的本文を転記しない。検証名の「C12」はfixture識別子であり、候補C12（月ドラッグ）の完了を意味しない。

## 後から確定したCI

8:15の観測はUTC `2026-11-15T23:15:10.023959+00:00` 時点でiOSが実行中だったという正しい履歴である。code CIのiOS集計はUTC23:20:37、JST11月16日8:20:37に終了した。旧記録をsuccessに書き換えず、再開時のGitHub Actions結果と取得済み全ログで次を確定した。

| 対象 | 最終結果 | 内訳 |
| --- | --- | --- |
| [code ef07838](https://github.com/ponkichi1552/LiFlow/actions/runs/43772497602) | success | iOS/Android各4,619件、4,618成功、失敗0、skip1。Cloud174/174、失敗・skip0 |
| [Native configuration](https://github.com/ponkichi1552/LiFlow/actions/runs/43772497601) | success | coordinatorがlive結果を確認 |
| [notes c3d65d6](https://github.com/ponkichi1552/LiFlow/actions/runs/43773793051) | success | iOS/Android各4,619件、4,618成功、失敗0、skip1。Cloud174/174、失敗・skip0 |
| 手元Macのnative widget journal | 1/1成功 | CIのLinux runnerでskipしたmacOS限定ケース。失敗・skip0 |

CI結果のlive確認はcoordinator、全ログの件数・checkout SHA照合は証拠整理担当が行った。機能契約716群、必須Cloud回帰136登録を保持する。CI／Emulator／Node画面ハーネスを実機条件の通過へ置き換えない。

## 追加証拠を候補へ対応

旧fff35df棚卸しは実機証拠のある23候補、構成照合のみ2候補、残191候補だった。今回、後続の限定観測をC08・C11・C13・C15の4候補へ追加対応した。現在の整理は実機証拠あり27、構成のみ2、残187の合計216。27には旧版、表示、受信済み保存の確認、未完了試行を含み、全条件PASSは0である。定義9件・署名履歴117件・予定170回・候補216件を同じ件数として足さない。

| 区分 | 限定native証拠あり | 構成のみ | 残る未実施 |
| --- | ---: | ---: | ---: |
| E：環境と証拠 | 2 | 2 | 4 |
| L：初回利用と再開 | 1 | 0 | 11 |
| A：認証とアカウント | 2 | 0 | 14 |
| G：Google Calendar | 5 | 0 | 17 |
| T：Google Tasks | 0 | 0 | 12 |
| S：グループ共有と権限 | 4 | 0 | 18 |
| H：予定と家事の連動 | 0 | 0 | 20 |
| C：カレンダーと繰り返し | 11 | 0 | 13 |
| D：通信断・受領・復旧 | 0 | 0 | 16 |
| M：送信内容・サーバー保存の最小化 | 0 | 0 | 14 |
| O：最適化・処理時間・資源 | 1 | 0 | 19 |
| N：通知・ウィジェット・OS | 0 | 0 | 10 |
| P：PDF・家電・受領 | 0 | 0 | 12 |
| U：見やすさと操作 | 1 | 0 | 7 |
| 合計 | 27 | 2 | 187 |

| 証拠ID | 観測した範囲 | 候補と残る境界 |
| --- | --- | --- |
| OBS-01/07 | ef07838を3台へ署名付き上書き。Apple保存ファイル129/13一致。最終Apple投影117受理・未送信0・拒否0、170回中169回不変＋意図した1回移動 | E01/E02。Android private DBのバイト比較なし。iPadは導入/起動と保存照合であり視覚レビューではない |
| OBS-02 | fff35dfで9定義をUI入力しAppleの原文・日時・周期/期間を照合。11:30手修正が予定名編集後も保持 | C08/C10/C11/S19。全入力、全端末、Google実送信を完了としない |
| OBS-03 | Androidで最初の5定義と2つの月日、月検索先を表示 | C07/C10。残る4定義のAndroid詳細、場所/メモ/家事検索は未確認 |
| OBS-04 | d88f083でAndroid別アカウントの新規1件が翌日18:00〜19:00としてApple2台へ届き原文・作成者一致。116受理/未送信0/拒否0 | C08/C10/S19。通常同期/配送の限定受入れ。元epoch競合の実機再現ではない |
| OBS-05 | d88f083で350ms長押しから3択を表示し、週系列のこの回だけ18:00→19:00を保存。ef07838導入後のApple投影でも保持 | C13/C16/C23。月移動、全3範囲保存、複数週境界、通知、Androidドラッグへ拡張しない |
| OBS-06 | Undo表示。8秒の期限が過ぎてからの試行で復元は未証明 | C15の未完了観測。期限内Undoの不具合とも成功とも判定しない |
| OBS-08 | 配備元account-device fff35df、weather e0ec346との到達ソース/構成一致とflag0 | E05/E06の構成照合。新しいlive health/API/Rules測定や再配備ではない |

私的`final-fixes-state-check.json`は公開記録のstateと完全一致、`group-maintenance-c12-check.json`の全項目は対応するnative記録と一致、`title-expanded-nine-check.json`の9定義・115受理/Apple・sourceは入力記録と一致した。この照合は保存記録の同一性であり、新しいUI操作・署名検証・権限試験ではない。入力指紋と216候補の元順序をJSONLに残した。

## 実機と合成検証の境界

- 共有epoch/listener競合は本物のmanager・synchronizer・SQLite・暗号と合成Cloud IOで再現。通常要求数と原履歴保持を検査した。既に更新済みの実グループを巻き戻さず、正常なnative同期と別アカウント配送だけを確認した。旧実機例外の本文未採取のため唯一の原因とは断定しない。
- 複数週の今後/全体移動拒否、安全な移動とUndoはNode画面ハーネス・SQLite・合成Google境界。最終nativeへ導入済みであっても、対応する実機ドラッグ/実Googleの再現は未確認。
- 受領済み削除キューの回帰は単体・隔離Auth/Firestore Emulator。最終Cloud174/174で確認したが、以前のローカル連続実行でのlock timeoutを履歴から消さない。flag0・worker未配備のため稼働データの受領後削除は未確認。
- Tasks返信喪失は実resolver・SQLite再オープン・shared journal・claim・制御HTTPによる自動検証。通常同期や機内モードを実Googleの作成成功後返信だけの喪失へ代用しない。
- UDP/接続観測はHTTP要求数・業務同期数・総通信量・CPU/メモリ/電力の証明ではない。10分無操作計測と計測自身の負荷を分離する。

## 次の10動線

残した専用予定/家事を再利用し、同じ動線で複数候補へ触れても観測した条件だけを追記する。以下は提案であり未実施。全ページUI監査や1,000件目標を再開しない。

### R01. 残した状態で再開を照合

候補: E01, E02, E03, E04, E07, A15。

再インストールやログアウトを繰り返さず、3台の現行ビルド受領・専用対象・時刻/地域・未送信を読み取る。保存117件/意図した19:00を今回の基準にする。

確認境界: 導入受領と現在画面/保存を区別。Android DB未比較を埋めた扱いにしない。

### R02. 時間軸移動を期限内Undo

候補: C13, C15, C16, C23。

残した週系列の19:00の1回を可逆に移動し、8秒以内にUndo。Apple保存と相手到達を一度ずつ照合し19:00へ戻す。

確認境界: 18:00への古い移動を勝手に清掃しない。復元・別編集後の拒否・通知は観測した分だけ記録。

### R03. 複数週の今後/全体を拒否

候補: C12, C13, C17, C18, C21, C24。

専用2週/複数曜日系列1件で位相を保てない移動を今後/全体の各1回試し、保存前拒否と原系列不変を確認。そのまま今回だけが選べることを確認。

確認境界: 月の正常日付保存・自動スクロール・全周期を一括完了にしない。作成系列は残す。

### R04. Googleの実際の名前と往復を確認

候補: G01, G02, G04, G05, G08, G09, G19, G20, C10。

専用Google対応予定1件を再利用し、省略名ON/OFFを実送信名で比較。時刻付き/終日/期間と一度の受信編集を同じ対応IDで追う。

確認境界: 省略表示だけを実送信と数えない。同期OFF/共有逆流/他カレンダーは個別の観測条件のみ。

### R05. Tasks完了と再開を確認

候補: T01, T02, T03, T05, T06, T07, T09, T12。

専用の個人/共有家事を再利用してホーム完了/取消とTasks側完了を往復し、対応ID/履歴/次回/重複を確認。返信喪失は受理後応答だけを制御できる既存の可逆手段がある場合に追加する。

確認境界: 制御境界がなければT07実機は環境待ち。機内モードや通常再同期で代用しない。

### R06. 予定と家事の計画を一度ずつ比較

候補: H01, H02, H03, H04, H08, H10, H11, H12, H17, H19, H20, C09。

専用家事1件とR04の専用予定で空き時間を塞ぐ/戻す差分を確認。時刻なし保存、今回だけ変更、完了/取消、固定への切替を同じ履歴で追う。

確認境界: 本人提案と共有正式予定を分離。元から不明/周期なしの家事を推測で有効化しない。

### R07. オフライン変更から収束

候補: D01, D02, D12, D15, D16, S11, S12, S13, C24。

2台の専用同一項目をオフライン編集し、片方終了/再開後に再接続。競合の明示解決を1回行い、両端の有効値/未送信/重複を照合。

確認境界: D03-D05の受付/永続保存/受領境界は追加証拠がある時だけ。通常切断をその代わりにしない。

### R08. 本人端末と共有権限を分離

候補: A12, A13, A14, S02, S03, S10, S14, S18, S21。

保存済み検証状態を消さずに使える未承認の専用環境がある場合、承認前拒否→番号照合→承認→本人/共有の初回受信を連続記録。既存別メンバーで古い画面の読取権限も確認。

確認境界: 既承認端末のキャッシュ再開を遅い初回復元へ代用しない。環境がなければ鍵/データを消して作らず未実施。

### R09. 無操作10分と表示操作の通信を分ける

候補: E08, M01, M02, M03, M04, M07, O01, O02, O04, O08, O19。

1台を無変更の前景10分で測り、別の短い区間で検索/形式変更/同値保存/1件変更を測る。計測中は証拠整理を進め、同じ共有対象への別端末書込みを混ぜない。

確認境界: HTTP/業務イベント/UDP/総量/CPUを手段別に残す。計測不能な資源値は環境待ち。

### R10. 通知とウィジェットから自然復帰

候補: N01, N02, N03, N04, N05, N06, N07, N08, N09, N10, O16。

専用近未来の回で許可/予約→ロック中自然到達→通知タップとWidget完了→再開を確認。保存済みの対象ID/本人通知/履歴を照合。

確認境界: 強制起動と自然実行を区別。OS別未実施条件を残し、全ページUI監査を始めない。

## 継続して残る範囲

有料解析分岐P01/P03/P04/P05/P06/P07/P10は明示保留。公開家電解析API/workerの未配備、P12の負の認証条件を成功としない。既存PDFのローカル閲覧・不正ファイル拒否・キャッシュ/通信確認は保留の有料解析と区別し、後続候補として残す。M08/M09/M10/M11/M14は実削除切替を伴う条件を保留し、flag0を維持する。全UI巡回を含むU01など、明示中止のUI監査に当たる条件は機能・アクセシビリティ等の必要境界と分け、無断で監査を開始しない。

この追記の完成は216候補の検証完成を意味しない。既存31行・216候補・旧8:15記録を保持し、新規JSONLを全行再解析、ID一意、候補216件の順序/本文一致、候補全条件PASSフラグが全件falseであることを確認した。


## 後続の再開観測（2026-11-16T05:54:04.232605+00:00）

初回再開時点の記録と242行は上書きせず保持した。以下を新しいcheckpointとして追記する。現在のHEADとmainは`fa7ff3ca9da1d039d08dc5357488c3410230a840`で一致し、ef07838はその祖先。対象コード・新回帰・契約に未commit差分はない。契約は717群・必須Cloud回帰136登録。旧段落のmain・受理117・候補27件・Undo未証明は、その時点の履歴である。

### 実Googleとef07838の実機

| 追加証拠 | 実際に確認した範囲 | 候補と境界 |
| --- | --- | --- |
| OBS-09/11 | 予定名省略ONでは日付・時刻トークンを除いた名前で実Googleへ表示し、11月17日18:00〜19:00・火曜の週周期を維持。省略OFFの別予定は原文名と同日17:00〜18:00で表示 | G04/C10の限定条件。要求数・全周期・競合まで通過とはしない |
| OBS-10 | Googleで週系列の「すべての予定」を選び予定名と場所を変更。native名前検索に更新名・場所マーカー・毎週18:00が表示 | G02/C07。全回の保存照合、別の検索項目や後編集競合は未確認 |
| OBS-12 | 個人単発を21:00→22:00へ移動し期限内Undoで21:00へ復元。停止中コピーでも21:00〜22:00、revision3、削除なし | C13/C15。移動後の別編集、未来分割、全OSは未確認 |
| OBS-13 | 共有の既存11月17日例外を20:00→19:00へ移動し、保存後2.17秒のUndoで20:00へ復元。raw24＋snapshot.base106をpinned実装で投影し130受理・未送信0・拒否0、最新head1件が20:00〜21:00 | C13/C15/C16/C23/S19。直近logical clock128→129→130は20→19→20。相手端末の現在受信・通知・独立署名検証を証明しない |

共有の旧12系列・170回との比較では、master12件と他169回は不変、欠落・追加0。差分は旧記録で19:00だった同じ意図した1回が現在20:00であることだけ。今回のUndoは20:00へ戻る操作であり、旧18:00や旧19:00への清掃ではない。既存OBS-06の期限切れ試行も正しい履歴として残す。今回、期限内復元の限定条件を別に確認できた。

QA名のG06/G08/U01という接尾辞はfixture名であり、候補G06（読取専用カレンダー）・G08（繰り返し取込/例外）・U01（主要画面の明暗監査）を実施した意味ではない。私的画面は掲載せず、原文やアカウント・グループ・予定IDは転記せず、artifact名・指紋と集計だけをJSONLへ残した。

### fa7ff3cの同値保存

[同値保存の修正記録](2026-11-16-unchanged-calendar-save.md)に対し、統合後の7回帰と関連172件、lint・型検査が成功。手元Macの全件実行は4,626/4,626成功、失敗・skip0。CIのLinux値や実機候補数へこの件数を足さない。

fa7ff3cをiPhone/iPad/Androidへ上書き導入した。停止中のApple保存ファイルはiPhone129＋iPad13＝142件すべて導入前後一致。Androidはinstallとlaunchが終了0、uninstall/clearなし。Android private DBのバイト同一性は未観測のまま。

iPhoneで同期済み予定を何も変えずUTC05:41:56に保存し、05:47:05の停止中コピーで本文・revision1・deleted0を維持した。Google対応は1件でlocal_revision1、remote base不変、pending patch/conflictなし。これはO06の限定native証拠である。HTTP要求数0、通知の再予約0、総通信量0や10分無操作の直接測定とは扱わない。通知だけの変更・下書き・競合等は自動検査と、この1回のnative保存を分ける。

### 配送17件とCIの後続状態

元の配送17ケースは、JVMだけをen_US（user.language=en/user.country=US）としてフックなしで1回実行し17/17成功、失敗・cancel・skip0。製品・Rules・期待値・timeout・契約の変更なし、追跡ソース指紋一致。日本語JVMのロケール資源欠落を切り分けた条件付きの追記であり、以前のlock timeoutや警告の履歴は取り消さない。本番Rules式数上限や稼働Cloudの配送削除を確認した結果ではない。配送フラグ0・未配備workerの境界も維持する。

[fa7ff3cの新CI](https://github.com/ponkichi1552/LiFlow/actions/runs/43811170007)はcoordinatorの直近観測でsharing-securityとiOSがsuccess、Androidは実行中。[Native configuration](https://github.com/ponkichi1552/LiFlow/actions/runs/43811170147)は未確定。これは時点を明示した中間記録であり、全job成功へ昇格していない。確定時は別途追記する。

### 候補と次の操作

同値保存O06だけが新しくnative証拠のある候補へ加わり、限定native証拠28、構成のみ2、残186の計216。全条件PASSは引き続き0。216原簿・旧31結果行・初回216対応は不変で、後続12候補の対応更新とR01/R02/R04/R09の進捗をJSONLへ追記した。R02の期限内UndoとR04の実Google省略ON/OFF・受信は限定範囲で進んだ。複数週拒否、Tasks返信喪失、家事連動、offline/権限、無操作10分、OS通知等の残りを継続し、全ページUI監査は開始しない。


### fa7ff3cの最終CI確定（2026-11-16T05:56:08.109206+00:00）

前段の中間観測と269行は保持したまま、証拠整理担当が`gh run view`で最終metadataを直接取得した。[アプリとCloud](https://github.com/ponkichi1552/LiFlow/actions/runs/43811170007)と[Native configuration](https://github.com/ponkichi1552/LiFlow/actions/runs/43811170147)は、ともにheadがmainの`fa7ff3ca9da1d039d08dc5357488c3410230a840`、completed/success。sharing-security・Android・iOS・ios-widget-input・native-configurationの全5jobもsuccessだった。

private receiptのSHA-256は`2121e8ea42d78d59311f62852fbcdcee6071f785c168fe9bc05fa3e3a4be2ff7`。この取得はmetadata確認であり、新CIの全jobログを再取得したものではない。前段の手元4,626/4,626を新CIの件数として転記せず、実機候補の全条件PASSにも置き換えない。


## Google単発の基本条件と個人同期OFF/ON（2026-11-16T06:08:08.422762+00:00）

270行と以前の監査本文をそのまま保持し、fa7ff3cの実機観測を追記した。環境は実iPhone・検証用本人C・実Google Calendar・通常通信である。

| 候補 | 判定 | 根拠と残る境界 |
| --- | --- | --- |
| G01 | この環境の基本条件は通過 | Googleで新規単発を11月20日13:10〜14:25に作成。nativeの検索・日付・詳細で予定名/該当日/時刻が一致し、場所とメモ2行も一致。原文の「単発作成→LiFlowの該当日・名前・時刻へ反映」を満たす |
| G02 | この環境の基本条件は通過 | 同じGoogle予定の名前・日付・開始/終了時刻・場所・メモ2行を変更し、nativeの「今すぐ同期」で11月21日22:40〜翌22日00:15と全項目が一致。target1件・Google対応1件でprovider対象は元ブラウザー編集対象と一致。他1,494 master不変、対象1件追加だけで削除0。原文の「対応予定だけ更新・重複なし」を満たす |
| G09 | 部分確認 | 日跨ぎの時刻付き取込のみ。終日終了日の排他規則、一般の複数日期間と各日表示まで通過とはしない |
| G19 | 部分確認 | 個人同期OFFで新規保存した予定はrevision1・Google対応0・Google検索0件。ON後の正常同期（表示14:53:15）で検索1件・対応1件となり、同じローカル定義/識別子/revision1・採用revision1を保ちpending/conflictなし。OFF中の既存共有継続とHTTP要求数は未確認 |

G01/G02の判定は候補原文にある基本動作を、この観測環境で満たしたという明示的な通過記録である。別platform、削除、終日、DST、後からのローカル編集との競合、自動同期の遅延まで広げない。G19区間は別端末の無操作計測を妨げないようグループ変更を行っておらず、「既存共有を止めない」という残る条件を実施済みにしない。

新たにnative証拠へ対応したのはG09/G19の2候補。限定native証拠30、構成のみ2、残184の計216となる。今回記録した限定環境の基本条件通過はG01/G02、全状態・全platformを含む候補全条件PASSは引き続き0。元216原簿と31結果行は変更せず、JSONLには基本条件通過を独立した`case_environment_result`として追加した。private artifact名と指紋だけを参照し、account・group・provider/eventのIDや私的画面は掲載しない。


## 共有Google表示の一方向性とAndroid前景10分（2026-11-16T06:21:45.721556+00:00）

281行と旧監査本文をそのまま保持し、main fa7ff3cの後続観測を追記した。

### G20の限定環境での基本条件は通過

共有予定のGoogle出力ON後（表示15:05:25）、11月17日の週予定が実Googleで20:00〜21:00と表示された。その回だけをGoogle側で21:00〜22:00・Google側だけの名前へ変更し、native個人の「今すぐ同期」（表示15:08:23）後を確認した。変更名のnative検索は0件、元の共有名は20:00、詳細も20:00〜21:00のままだった。

停止中コピーの比較は、authorityを持つ`sharing_operations`24件、`sharing_snapshot_state`1件、`sharing_v2_projection`の全行が同一。130受理・未送信0・拒否0で、個人master1,495件もすべて同一、export対応は18件だった。v2 DB内のlegacyなcalendar/chore表が0行であることは、一方向性の根拠へ使っていない。

候補G20の原文「自分のGoogleへ表示し、Google編集をグループへ逆流させない」は、この実iPhone・検証用本人C・通常通信・Googleの1回だけの編集という環境で通過と判断する。他端末、別の例外/取消/競合、Google編集後のさらなるexport復旧まで通過とはしない。HTTP要求数の測定でもない。

### CPU・PSSの測定事実と未判定範囲

Androidのready共有ホームをUTC05:50:31〜06:00:31に前景待機し、CPUの実区間は600.188秒。主processのCPUは66.63秒（user51.26/system15.37）、1論理CPU基準の平均11.10%だった。1分ごとの11標本すべてで前景・画面ON、同じprocess/starttimeを維持し読取error0。PSSは開始/5分/10分の3点で192.49→190.26→190.35MiBだった。連続peakやleakなしを証明した値ではない。

10分終了後の別区間16.665秒では、main thread9.30%、JS名のthread合計0.12%を観測した。Macのscrcpy一致0は、その後のUTC06:02:37の単一のprocess metadata照合である。thread名やこの局在から、関数・通信・CPU原因を断定しない。ソースだけの追加レビューでもready共有ホームに意図された常時アニメーションは特定できず、native/framework内部などの可能性を除外していない。原因も性能不具合も未判定であり、この測定を理由とする製品修正は行っていない。

cached UID netstatsは2時間bucketで、HTTP件数・正確な10分bytesは未測定。通信0、業務同期/全件再計算の固定反復なしへ換算しない。O01は10分待機の条件を実行したが必要な業務処理計数が残り、O19も前景だけの部分測定で背景・電力比較は残る。計測担当による起動/停止/設定変更/Cloud操作はなく、既存観測の読取りだけである。

新しいnative証拠はG20/O19の2候補で、限定native32、構成のみ2、残182の計216。G20の限定環境の基本条件通過を独立記録し、全状態・全platformの候補全条件PASSは0を維持した。未照合のTasks観測はこの追記に含めていない。account/group/event識別子・端末識別子・UID/PID・私的画面は公開せず、artifact名・SHAと必要な集計だけをJSONLへ記録した。


## 個人Tasksの基本往復・Apple保存収束・既存server再照合（2026-11-16T06:44:12.530178+00:00）

291行と旧監査本文を保持して追記した。Tasksの観測環境はfa7ff3c・実iPhone・検証用本人C・通常通信・実Google Tasks。候補T01/T02/T03の原文にある基本条件はこの環境で通過と判断する。

| 候補/操作 | 観測した対応と結果 | 境界 |
| --- | --- | --- |
| T01 個人Tasks ON | activeな本人Google接続/制御が一致し、対象householdの13対応が専用リストへ同期。対象の11月16日回はneedsAction・pendingなし・履歴0。既存の既定リストは操作対象に含めない | 他account/list/OS・共有Tasks・返信喪失まで通過とはしない |
| T02 Home完了 | 同じTask/list/schedule対応でcompleted ACK、pendingなし、元の有効履歴1件がcompleted。11月30日の次roundは別schedule/Taskで生成 | この時点の対象家事2対応は別roundであり同名重複ではない |
| T02 HomeUndo | 元のTask/list/schedule/履歴の同一性を保ちneedsAction ACK。履歴は1件のままincomplete、対象対応は1件へ戻る。fresh Googleでも今日の対象1件、将来予測の対象は取り下げ | 全体active14件には別家事の追加が含まれ、対象の同名重複数へ換算しない。検証データ清掃の削除ではない |
| T03 Google完了→明示pull | Google側で元の今日Taskを完了しnative Tasksの「今すぐ同期」。Home1/4、同じ対応/履歴1件でsource googleTasks・outcome completed・pendingなし | push受信ではない |
| T03 Google再開→明示pull | Google完了欄の同じ元Taskをreopen後、Tasksの「今すぐ同期」。Home0/4、同じ対応/履歴1件がincomplete、対象Task1件・pendingなし | 現契約`google-bidirectional-undo`の同一回更新に対応。並行競合、HTTP件数、echo0は未測定 |

T01は対象と正しいリスト、T02は契約どおりのTask/履歴一致、T03は元の対応回だけへの反映を確認した。受信変化に応じHomeと履歴が変わったことはT12の部分観測、完了/Undoで次round予測Taskが生成/取り下がったことはH11の部分観測としても対応させる。T12の反響ループなし、H11の過去実施・計画全体や全周期までは通過としない。共有Tasks・同時claim・返信だけ喪失は引き続き別条件である。

### Apple2台の共有保存

実iPhone/iPadの停止中containerコピーで、同じgroup binding・immutable operations・snapshot・fact hash・accepted-ID集合が一致し、両方130受理・未送信0・拒否0だった。既存C10 Undoの履歴が相手の実Apple端末の保存にも到達した証拠としてC23/S19へ追加する。iPadの視覚レビュー、独立署名検証、本人通知の私的範囲を確認したものではない。

S18の原文は「同じ本人の複数端末を承認」「他メンバー用と本人専用を分離」である。今回の同じ承認済み2台の共有保存一致は部分的な関連情報であり、承認操作と私的分離のシナリオを新たに実施したとはしない。S18の候補実施件数は増やしていない。

### 稼働serverのread-only確認

既知3serviceのReady/traffic100、revision/imageの配備receipt一致、現mainの到達source graph/config/archive一致を再確認した。正式healthはaccount-device APIとweather APIへ各1回GETし、両方200。metadata4GET＋health2GET＝6読取、mutation0、env/flag/secret取得なし。workerには読取専用health経路がなく、実行POSTは行っていない。

今回のclientだけの修正は配備済み到達sourceへ差を生まないため新配備は不要と判断する。これは新worker batch実行や全region/Jobs/Worker Poolsの検査ではない。前からの削除worker未配備・配送flag0・有料AI保留の境界を維持し、flagの値をlive再取得したとは主張しない。

新しいnative対応はT01/T02/T03/T12/H11の5候補で、限定native37、構成のみ2、残177の計216。限定環境の基本条件通過にはT01/T02/T03を追加し、全状態・全platformの候補全条件PASSは0を維持する。元原簿・旧結果・その他のファイルは変更せず、Task/list/schedule/history/providerやaccount/groupの実ID、私的画面・本文は公開記録へ転記していない。


## 個人Calendar OFF・共有ONの独立動作と保存先切替（2026-11-16T07:05:30.630875+00:00）

314行と旧監査本文を保持し、fa7ff3c・送信元実iPhone/本人C・受信相手実Android/別メンバーD・通常通信での確定観測を追記した。

個人CalendarをOFF、共有のGoogle出力をONにしたまま、11月18日14:00〜15:00の個人新規を保存した。personal1件、Google対応0・Google検索0件、共有operationにも含まれず、localだけに残った。

別の新規は個人の入力として始め、保存前に共有へ切り替えた。原文の予定名・場所・日付・時刻を保持し、保存先はshared1operation/personal0。送信元本人の意図したGoogleへexport対応1件・Google検索1件で届き、Androidの別メンバーも検索1件から11月18日15:00〜16:00と同じ場所を選択確認した。送信元は131受理・未送信0・拒否0だった。相手は予定名省略表示ON、送信元はOFFであり、この表示差と共有本文の原文保持を区別する。

候補G19の「個人OFFで対象外へ送らず、既存共有を止めない」は、この2fixtureによる併用条件で基本通過と判断する。候補S20は観測した**個人→共有の方向に限り**、入力保持・選んだ保存先だけへの反映が通過。逆方向の共有→個人、全権限・保存失敗・取消・通信断・競合・HTTP件数へ拡張しない。S19には今回の共有新規の別メンバーAndroid到達、C08には新規保存先の保持という部分観測を追加した。

観測終了時も個人CalendarはOFF、共有Google出力はONである。Androidのprivate DBバイト同一性や署名の独立再検証は行っていない。T05の共有TasksはSQL照合待ちなので、この追記で通過や候補件数へ加えない。4候補はいずれも既存のnative対応があるため、限定native37・構成のみ2・残177は変わらず、全条件PASSは0を維持する。314行prefix・元原簿・旧結果・他ファイルを保持し、私的画面・account/group/providerの実IDや私的な本文は転記していない。


## T05初回ONと本人native共有完了/Undoの限定確認（2026-11-16T07:15:14.405286+00:00）

324行prefixと旧監査本文を保持した。この追記はfa7ff3c・実iPhone・本人Cによる共有Tasks初回有効化、native完了、native Undoの3captureだけを対象にする。private proofの保存照合61項目はすべて一致した。これは61個の新しい製品テストという意味ではない。

共有対象1家事の本人用5round（11月16/19/22/25/28日）が、本人・group・private namespace・選択した本人Google listに一致する5つの一意な対応として作成された。有効化だけでは既存の共有署名operation・snapshot・projection・server receiptは変わらず、131受理・未送信0・拒否0だった。実Googleにも5件を確認した。観測したproviderのaccount/list/Task識別子が共有ledger/snapshot/projection/receiptへ入っていないことも照合し、原文T05の初回ON・本人対象への同期という基本条件はこの環境で通過と判断する。他memberのGoogle listを直接閲覧した結果や、すべての将来データの非漏えい保証へは広げない。

| 操作 | 対応と共有履歴 | 結果 |
| --- | --- | --- |
| nativeで今日の元roundを完了 | 同じTask/list/schedule/target。期待したcomplete factが1件追加され、ACKはそのfactだけを指す。旧署名operationと他4対応は不変 | 131→132受理、pending/rejected0。Googleの元11月16日Taskがchecked |
| 同じ本人がnative Undo | 元complete factだけを対象とするUndoが1件追加。同じTaskをneedsAction ACKとし、完了ACK集合を解除。5対応は一意で他4件不変 | 132→133受理、pending/rejected0。Googleの元Taskがunchecked |

T02には、この同じ本人による共有native操作の限定通過を追加した。個人SQLiteの履歴1行という前の検査とは保存形式を混同せず、共有では保持されたcomplete factとそれを指すUndo fact/ACKで対応を確認している。署名行の同一性・アプリ受理済み投影の比較であり、暗号署名の独立再検証やHTTP計数ではない。

**後続のGoogle側完了をpullする区間は、この61項目の通過に含めない。** その後の同期エラーは調査中で、共有の外部Google往復全体やT12を通過としない。`resume-t06-*`という私的観測名も、原候補T06「二端末が同時同期」の証拠ではなく、T06は未実施のまま。別memberが取り消すS07、同時claim、応答喪失、他OSも別条件である。

新native対応はT05の1候補で、限定native38・構成のみ2・残176となる。全状態・全platformの候補全条件PASSは0を維持し、未確定の後続区間を成功へ混ぜていない。provider/Task/list/round/署名operationの実ID、account/group識別子、私的画面は公開へ転記していない。


## 未修正の共有Tasks同期制御エラー（観測名O07、2026-11-16T07:42:43.053378+00:00）

334行prefixと旧ログ・原簿を保持して、保留していた外部Google操作とnative原因確認をまとめた。前段の初回ON/native完了/Undoの限定通過と、後続の共有Google往復全体の成否を分ける。

### データ取込は正常、同期制御はエラー

Googleで元の共有Taskを完了、続いてreopenし、それぞれnativeで明示pullした。元Task/list/schedule/targetへのcomplete/Undoが各1operationだけ追加され、ACKも正しい対象へ対応。既存署名operation・snapshotと他4対応は不変、受理は133→134→135、pending/rejected/provisional0だった。保存データ整合46項目はすべて成功した。

一方、両外部操作後のsync controlはともにgeneric errorとなり、healthyではない。設定画面でも成功checkpointの後に新たな試行がエラーへ変わった。したがってデータの取込成功だけで共有往復全体やT12を通過にしない。私的`resume-t06-*`という観測名も、原候補T06「二端末同時同期」の実施を意味しない。

### 診断variantで確認した失敗経路

無変更の強制同期でもUTC07:30:10.615に成功checkpoint、その1.796秒後の07:30:12.411にerrorを確認した。元fa7ff3cの`src/platform/sharing/v2-local-planning.ts`にあるprotected personal planning input changedのplain Errorが、恒久的なgeneric error分類へ落ちる経路で、privateの最小probeと一致した。native診断controlはerror/retryCount0/nextRetryAtなしだった。入力変更の保護guard自体は維持している。

- QA variant1は固定tagの診断ログだけ。OS stdoutからJS warningが見えずtag0だったため、イベントがなかったという根拠にはしない。
- QA variant2はgeneric permanent errorの**診断codeだけ**を静的固定hashへ変更。元のkind:error、制御flowとHTTP呼出し条件は変更せず、コードが上記guardを指した。実HTTP件数を計測した意味ではない。
- 両variantとも非shippingの診断artifactで、コンパイル直後に製品sourceをfa7ff3cへ復元した。request body/credentialsのログは追加していない。診断source復元を修正完了や通常payloadの再導入と同一視しない。
- native上書き導入は各回129保存ファイルすべてが停止中before/afterで一致。4つの私的archive検証も129entry完全一致で保存され、DB欠落の証拠はない。これと、通常のGoogle操作による正当な受理fact追加は区別する。

原因確認の指紋は`resume-shared-tasks-native-cause-confirmation.json`＝`245619f0a9a20a7b41afbdeda2b281366985413adc70ae0ad3871e2b72da9a5e`、対応state＝`02a088b65f909e17bdfac8ffe877f4d70e33c5de77d2ee8540aefb0cbfc5b61b`。この記録は修正前の不具合観測であり、修正済み受入れの主張ではない。修正と再実機確認は別の後続記録にする。

O07という観測名を、原簿O07の依存範囲全体を検証済みという意味にしない。今回新しい候補を追加実施した件数にはせず、限定native38・構成のみ2・残176を維持する。元216原簿・旧31結果・334行の履歴を保ち、T12/共有往復全体は未通過、T06は未実施のまま。私的識別子・画面・本文は公開せず、artifact名と指紋・非機密な定数/集計だけを残した。


## 操作時刻の訂正とO07/O08コード検証（2026-11-16T08:09:59.776355+00:00）

### 訂正：07:30は無変更強制同期ではない

直前の「無変更の強制同期でもUTC07:30:10.615に成功、その1.796秒後にerror」という操作の説明は誤りだった。時刻と原因だけのreceiptから操作を結び付けた記述を訂正する。343行と旧本文は履歴として書き換えず、新しいaction clarificationを正しい対応として追加した。

- UTC07:22:30の**無変更の明示同期は成功**し、追加/更新/取込0でerrorが解消した。
- 07:24:11はGoogle完了を明示pullした後のerror。
- 07:30:10.615の成功checkpointと07:30:12.411のerrorは、**Google reopen/Undo取込後**の連続試行である。無変更同期が失敗した例ではない。

固定cause keyによるprotected planning-input guardのnative原因確認は有効で、変更するのは操作ラベルの推定である。`resume-shared-tasks-native-cause-action-clarification.json`のSHA-256は`dab3a71cabd0c3fb46de803f15cd517e83339ae79f4ecae578b8320f4fd28cf3`。旧frozen receiptは上書きしていない。

### O07：code検証完了、native修正受入れは待ち

O07修正は、保護入力変更を型付きErrorへ限定し、forceを各passで消費しつつ後からの明示forceを保持する。入力を読み直す回復は同じ元deadlineと最大3回の枠を保つ。stale/access/account guardは弱めず、無関係なprepare/実providerエラーを隠さない。既に取込済みのfact/ACKがある状態でplanning入力が変わり続けても、同じTaskとACKを保持し、上限でdurable retryを残す回帰を含めfocused12/12が成功した。

privateの8ファイルfreezeはその時点の718契約群であり、後続のpost-ACK回帰とO08契約追加は別receiptで追跡した。現working treeは元717契約群がdeep identicalのまま新2群を加え719群、必須Cloud回帰136登録を保持する。

### O08：共有Add入口のnative失敗と1行wrapper

旧nativeのactive group「家事」からAddを押すと、native press eventが任意LocalDate引数へ渡り、`Invalid local date: [object Object]`となる失敗を確認した。普通のAdd footerを引数なしwrapperにする1行修正を行い、両OSのrendered button回帰は旧版2失敗→修正後2成功、関連68件も成功。明示日付を渡す別経路・保存先・accessibility・busy状態を保持する。

これは不具合観測名O08であり、原候補O08の連続検索/索引の検証ではない。S04には**追加入口の失敗**という部分native証拠だけを追加し、保存・A/B一致を通過としない。H fixtureの作成/履歴を理由にH01-H06の忙しさ試験を通過にしていない。

### 統合されたlocal checkと残るnative gate

両修正を含むlocal full checkは4,640/4,640成功、失敗・cancel・skip0、lint・型検査成功。ログのSHA-256は`4bfba77cc4b257b3b2fed54803fd03d3b51d3b092fb9a3b043d5a876888243b6`。focused12、両OS2件、関連68件には重複があり、全件へ加算しない。この時点ではmain/remote基準はfa7で、修正は検証したworking-tree内容。次のroot commit/build前のcode検証であり、新CI通過やshipping native受入れではない。

実機3台はまだ旧fa7系（phoneはdiagnostic variant2）で、新fix導入後の共有Google完了/reopenとAdd入口の実機再確認が残る。O07/O08はcode checked / native verification pendingとして記録し、runtime修正済み・T12/共有往復全体の通過を主張しない。

新native対応はS04の入口失敗1候補だけで、限定native39・構成のみ2・残175。全状態・全platformの候補全条件PASSは0を維持する。343行prefix・元原簿・旧結果・他ファイルは保持し、識別子/私的画面/本文は公開へ転記していない。


## 8944導入・限定native再確認と結果文O09（2026-11-16T09:00:44.811460+00:00）

既存355行prefixを保持し、source `8944bded81e9bc7fa5bd6b9b9bbdeb174b34a694` の確定receiptだけを追加した。以下は限定した入口・取込動作の確認であり、216候補全体や共有往復全体の通過には換算しない。

### CIと実機上書き導入

保存済みCI receiptの確認時刻はUTC08:27:50。Native configuration（43829333015）のnative-configuration/ios-widget-inputと、CI（43829333042）のsharing-security/check(ios)/check(android)、計5 jobすべてが同じ8944 headでcompleted/successだった。このreceiptに含まれない各suiteの件数・skip数は推定せず、前節のlocal4,640件とは別の結果として記録する。

iPhone/iPadは上書き導入時の停止中before/afterでそれぞれ129/13ファイルが全byte・SHA一致し、変更・永続差分0。Androidも同じsourceのAPKをdata clear/uninstallなしで上書きし起動、artifact指紋一致・package UID不変を確認した。Androidのprivate DB byte比較は未実施である。これはインストール区間の保存保持であり、その後の138受理factがiPadへ収束したという証拠ではない。

iPadOS26.1はこのhostからのremote画面共有に対応せず、今回もiPadの視覚レビューは行っていない。過去のApple2台のfact収束、今回の導入前後byte一致、画面での受入れはそれぞれ独立した証拠である。

### O08：Add入口は実iPhone/Androidで復旧、保存は別条件

新nativeのiPhone管理者では日付と必要項目を持つ共有Addフォームが開き、Androidメンバーでもフォームが開いてBackで一覧へ戻った。旧`Invalid local date`は現れなかった。Androidで一度入力をdispatchできなかったのはCUAのクリック操作で、rootが許可済みgesture手段で入力後に画面を観測したものであり、アプリの失敗へ分類しない。

この観測では両端末とも新規家事を保存していない。O08の入口不具合はこの2役割/OSで修正確認できたが、原候補S04の新規保存・設定変更・A/Bの家事/周期/担当/予定一致を通過としない。診断名O08は原候補O08の検索/索引検証でもなく、Hの忙しさ試験を通過にする根拠でもない。

### O07：Google完了1回のデータとcontrolは正常、O09の結果文が残る

8944の実iPhoneでGoogle側の元共有Taskを完了後、停止中readcopyをさらにcloneして照合した。rawだけではなく、106 factを持つsnapshot.baseとrawを合わせて正規projector・repository reader・V2 history viewを使った63項目がすべて一致した。

直前diagnostic2からacceptedは137→138、rawは31→32、snapshotは不変。同じ元Task/list/schedule/本人/roundへのcompleteが1件だけ追加され、private ACKもそのfactだけを指す。他4mappingは完全同一で、pending/rejected/provisional/outboxは0だった。controlはUTC08:35:29.992の成功checkpointと同じlastAttemptでidle、retry0、error/nextRetryなしに終わった。O07の**このGoogle完了1回における取込後control回復**はnativeで確認できた。

一方、rootはその操作結果文が「skipped」であることを観測した。保存とcontrolが正常でも集約した結果文が実態を表さないため、別の不具合観測名O09として修正中のまま残す。private proof担当は保存状態を確認したもので、結果文の画面を独立再観測したとは主張しない。O09という診断名を原候補O09の件数/長文検索性能へ対応させず、新しい候補実施件数にも加えない。

同じ新sourceでのGoogle reopen、共有往復全体、T12の全条件、結果文O09の修正受入れはまだ残る。原候補T06の二端末同時同期、他OS/競合/応答喪失、独立暗号署名検証、HTTP件数も今回の証拠に含めない。

### serverはsourceだけ再比較、Cloudは06:16の既存観測

新main8944として提供されたsourceについて、account-device API/weather API/workerの到達graph、各source指紋、import/config/literal archiveが既存の配備pinと一致した。runtimeの対象source数はそれぞれ33/9/7、型を含めても50/9/7で差はなく、この3serviceのsource差から追加配備が必要とは判断されない。

ここで新しく読んだのはlocal sourceだけである。Ready/revision/image/traffic/healthの根拠は**UTC06:16:14.088〜06:16:16.644の既存Cloud receipt**で、新しいCloud metadata GET・health GET・その他networkはすべて0。worker実行もない。削除worker未配備・配送flag0・有料AI保留は変更せず、live再照会した値ともしていない。

T03/T12/S04はいずれも既存のnative対応へ証拠を追加したため、限定native39・構成のみ2・残175を維持する。全状態・全platformの候補全条件PASSは0のまま。元216原簿・旧31結果・歴史的記録は不変で、account/group/provider/Task/list/roundの実IDや私的画面を公開へ転記していない。証拠のartifact名とSHAは今回のJSONL追記へ記録した。


## O09結果集約のコード検証、native受入れは未実施（2026-11-16T09:08:04.902600+00:00）

上の8944 native観測後、製品commit `e3d9c36ce057bcfe57d050f3bf95a06cf8e32d46` にO09結果集約の修正が入った。3ファイルのcommit内指紋がfreeze receiptの修正後指紋と一致した。runtimeは17行追加で、後続のskipが先に成功した取込/作成/更新の結果を消さず、実際に成功したpassの値だけを集約する。全skip・foreground待ち・後続の実retry/auth/errorを区別し、3回上限・force/queue・HTTP判定・権限guard・保存済みfact/ACKを維持する。

旧runtimeで3失敗→修正後3成功、関連64件成功。既存登録テストを拡張し、registryを変更していない。rootのlocal `npm run check` は4,641成功・失敗/cancel/skip0、201326.376792msで、lint・型検査も成功した。関連64件と全4,641件には重複があり加算しない。full checkログSHA-256は`a93f7e6fc22d592128331151ec89a826fae5d598c0afae08c2ddfeff0bbc70d5`。

**実機3台は8944のままで、O09修正はまだnativeへ導入・受入れされていない。** 上の8944の5 job成功をe3のCI成功へ転用せず、e3のCI結論もここでは未確認とする。O09はcode checked / native acceptance pending、共有Google reopen・往復全体・T12は未通過の境界を保つ。今回もnative候補の新規対応は0で、39/2/175、全条件PASS0は変わらない。


## H系の実機保存照合とO11視認性の境界

既存JSONL372行・監査本文全体と、歴史的355行prefixを保持する追記である。H01/H02部分閉塞/H05は8944、H02全帯閉塞/H03/H06はa75の実iPhone・本人Cの個人fixtureを使った。下表の「成功」は保存データと観測した条件に限り、候補の全条件PASSへ換算しない。

| 原候補 | 保存・計画の結果 | 残る条件 |
| --- | --- | --- |
| H01 | 07:00〜07:15の予定を追加しても、同じ回の11月30日09:00〜09:20、14日model、履歴1件を保持。試験の取消後は保存入力が復元。32照合一致 | 他の家事全体・他環境へ拡張しない |
| H02 部分閉塞 | 09:00〜09:15を塞ぐと、同じ日・回・windowの09:15〜09:35へ15分移動。11照合一致 | まだ配置可能な状態である |
| H02 全帯閉塞 | 11月30日09:00〜19:00を塞ぐと、許可帯と11月28日〜12月2日のwindowを保ち11月29日19:00〜19:20へ移動。保存値は全体projectorの結果と一致 | 完全に配置不能な状態とその表示は未実施 |
| H03 | 全帯閉塞の予定を取り消すと、忙しさ85→84、11月30日09:00〜09:20へ復元。他の有効対象計画・履歴を保持 | 既存予定の編集variantは未実施 |
| H05 | 同じ15分を塞ぐ別IDの2予定でもbusy85と09:15〜09:35を維持。片方の取消では不変、最後の取消でbusy84・09:00〜09:20へ復元 | 任意の重なり・provider・timezone全体は未実施 |
| H06 | 11月29日〜12月1日inclusiveの1定義を12月2日0時exclusiveで扱い、3暦日を塞ぐ。対象は12月2日19:00〜19:20へ移動、同じ回・model・履歴を保持 | 保存データは成功、native視認性は失敗したまま |

H02全帯閉塞の区間では、直前の共有Google reopen139に対応するcommon-history mirrorのUndoが独立に1件発生していた。厳密な「全personal履歴・全peer計画が一切不変」はfalseであり、この差を消していない。対象QA/T03の個人履歴、他の有効計画は保持され、H03/H06でもこの既知mirror状態は不変だった。

H05の別ID追加ではraw source provenanceが変わる。初回の「source revisionまで同一」という厳密比較の失敗は保持し、有効な忙しさ・入力geometry・計画が同じという機能上の成功と分けた。H06の区間数84→82もunion統合によるもので、忙しさが減ったという意味ではない。

### O11はデータ欠落と分け、native修正受入れを待つ

H06の旅行定義と計画は保存されていたが、終日rowが時計scrollに巻き込まれ見つけづらくなるnative失敗を観測した。観測名O11であり、原候補O11の資源測定を実施した意味ではない。

修正commit `608321329c65aba72bafa8bf0d0820535f551f99` は、終日を時計から独立した有界欄へ置き、表示中署名の測定保持を最大3列の範囲へ抑える。inclusive期間・同じ保存回を開くcallback・検索/recenter・gesture・既存の家事領域予算を保つ。旧rendererの有意4失敗、測定保持の有意2失敗を保存し、最終focused14・関連159成功、lint/型検査/登録検査も成功した。重複する検査は加算しない。

O11はf483に含まれartifact/CIまで確認したが、この草稿には**修正後nativeの視認性受入れを含めない**。旅行fixtureを保持し、全ページUI監査・1000件洗い出しは再開しない。

## B2はD本人Undo、B3はオフライン競合と明示解決

B2ではa75のDがD本人の各自roundを完了し、本人のcheckboxで取り消した。受理139→140→141、追加はcompleteとそのfactを指すself-Undo各1件、C本人の回とCのTasks5対応は不変。26照合一致である。別メンバーが取り消す原S07は実施していない。履歴にUndoを置かない受容済み設計を維持し、管理者用の新入口や権限緩和は加えていない。

B3ではC/Dの通信を切り、同じ共有descriptionの原文を保って各自の検証用識別子だけを追記した。Dはアプリprocess再開後も本文・未送信1を表示し、保存済みHome/guideを利用できた。端末OS再起動やL07の一時展開状態リセットを確認した意味ではない。

| 段階 | 保存された事実 |
| --- | --- |
| 確認済みbaseline | 141受理、raw35＋snapshot.base106、未送信/暫定/保留/拒否0 |
| Cオフライン保存 | stored accepted142には暫定1が含まれる。確認済み部分集合は元141と完全一致、outbox1。唯一の新factはdescriptionのみ |
| Cを先に再接続 | 同じfactがACKされ142確定、outbox/暫定0。Dの変更はまだない |
| D再接続 | 143確定、raw37。C/D両patchのcontextは同じ141headで、互いのdotを含まない。異なるdescription2候補を保持し、暗黙の後勝ちにしない |
| Cが両候補を展開してCを1回選択 | 全143を観測するdescription-only解決factとreceiptが各1件追加され144。単一候補は原文＋C識別子。旧143factを残し、他entity/field/完了/要求/ルールとCのTasks5対応を保持 |

C/iPadの最終raw38・snapshot.base106・受理144・receipt144、authoritative全fact/投影/receiptが一致し、未送信/暫定/保留/拒否は0。最終92照合が一致した。中間51/74と92は重複する照合で、新しい製品テスト数として加算しない。

rootはC/D双方の通信復帰、両候補の展開、C選択後の通常欄、Dの通常descriptionにもCの値が届いたことを実画面で確認した。Dのprivate DB比較や独立署名検証、正確なHTTP件数は行っていない。iPadは保存の収束であり、iPadOS26.1のremote視覚レビューではない。S12の有効予定全体のC/D一致まで拡張しない。

Dに残った本人設定の赤警告は、旧a75の再入で20:23:05の同期表示とともに消えた。新f483が実行された効果とはしない。これはO07のplanning入力Errorとは別のowner入力Errorで、nativeのどのguardが発火したかは未特定のままである。

## a75の結果文受入れ、bb/f483のコード・CI・buildを分離

前のO09「native未実施」の後、a75を上書き導入した。停止中Apple保存の比較はphone129＋iPad13＝計142ファイルが全一致。Androidは同じ署名・UIDを保つin-place導入/起動を確認し、uninstall/data clearは行っていない。Android private DBのbyte比較は未実施である。

a75の実iPhoneで元共有Google Taskをreopenして明示pullすると、同じTask/list/roundへUndo1件が追加され138→139、ACK解除・他4対応不変、control idle/retry0/errorなしとなった。実際の結果文も追加0・更新0・完了と取消の取込1件で一致し、78照合が成功した。O09のこのreopen variantはnativeで確認できたが、同じ新sourceでのGoogle完了/reopen全往復、T12反響0、T06二端末同時Tasksまでは通過にしない。

`bb780a7c5d0e8dc50d58822a26afad22a7a34a4f` のCalendar認証修正は、保存済みauthRequiredの自動入口を止め、明示force/interactiveと必要な同時参加回復を保持する。Calendar一覧の30秒再利用は採用せず、新規calendar/role/権限喪失反映、差分・CAS・予算・保存形式を維持した。実SQLite＋合成Googleポートのfocused14/関連255、local全4654、lint/型検査が成功。native HTTP0を直接測った結果ではない。

`f483017bd6284633c0e741aa72dda3f4ade0a303` のowner入力回復は、型付きAdaptive変更だけを最大3回のfresh shared表示passで読み直す。generation変化も同じ総枠へ含め、普通のprivate読取APIの3回retryを保つ。account/group/dispose guard、pending合流、書込み済みmirror/fact/ACKを保持し、generic/authority/O07 planning Errorは隠さない。real repository回帰を含む新9/関連122が成功し、既存719契約をdeep identicalのまま1群追加して720、Cloud136登録を保持した。native警告の正確な入口は未証明で、修正後native受入れはこの草稿の対象外である。

local全checkは4669成功・失敗/cancel/skip0、lint/型検査成功。bbのCI/Native計5jobと、f483のCI/Native計5jobはそれぞれのheadでcompleted/successを保存receiptから確認した。local件数・CI job・製品テスト・native受入れを合算しない。

f483のiOS/Androidはbuild-only artifact receiptを確認し、iOS retry1は終了0・署名/追加入力照合成功、Androidも署名と非JS payloadのpinを保持した。最初の失敗/preflight証拠も保存している。**build成功は導入成功やO11/owner回復の実機受入れではない。** B3証拠承認後にrootが進めるf483導入・新native確認は、別の確定receiptで後続追記する。

serverは既存bb時点の限定read-only追補で、同じ既存認証のOAuth refresh POST1と既知3service metadata GETを分離し、Ready/revision/image/trafficの配備pin一致を確認した。health2件200は既存a75観測の再利用で、新しいf483 health実行とはしない。clientだけの差から新配備が必要とは判断せず、worker POST/Cloud mutation/flag・secret・IAM取得/有料AI実APIは行っていない。

## 原216候補の重複を除いた残数

今回の新しい限定native対応はH01/H02/H03/H05/H06とD01/D02/S11/S12の9候補である。各original caseIdの最新mappingを1回だけ数えると、限定native48・構成のみ2・未実施166＝216、全条件PASS0。H02配置不能表示、H03編集variant、H06/O11視認性、S12の全有効予定、別member取消S07、端末再起動L12、全形式C01、二端末同時Tasks T06などの境界を残す。関連しただけのcaseIdを新実施へ増やしていない。

元原簿216件はnot_runのまま、旧31結果・355行prefix・全372行の履歴を保持する。試験手順として行った予定取消は保存された墓標/旧証拠と区別し、清掃目的の検証データ削除は行わない。全ページUI監査/1000件目標の取消、有料OpenAI実API保留、削除worker未配備・配送flag0を維持する。account/group/provider/Task/list/端末の実IDや私的本文・画面は公開へ転記しない。
