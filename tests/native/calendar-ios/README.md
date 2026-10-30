# iOSカレンダーの実画面検査

通常の `npm test` とは別に、インストール済みLiFlowをXCTestで操作する。開発サーバーを使わないRelease版でも実行できる。専用の検査用シミュレーターを使い、実ユーザーの端末やDBを初期化しない。

`testCalendarSaveEditDeleteAndNativePicker` は `QA-LiFlow-calendar` という合成予定を2年後に作り、ホイール・カスタム月次・複数曜日・入力の往復・保存・1回だけの編集・全体削除・表示切替を確認する。最後に今日へ戻る。180日内の家事配分を変えない日付を使う。無関係な下書きがあれば破棄せず失敗する。途中失敗時に保存済みの検査予定が残った場合は、次回実行前に検査分だけを確認・整理する。

`testCoreScreenAppearance` はホーム、設定、家事一覧と浴室の説明、家電一覧、登録済みならSV20の説明、カレンダーを読み取る。外観を変えて画像を見比べる用途であり、画像の一致を自動判定するテストではない。

XcodeとCocoaPodsの `xcodeproj` Ruby gemが必要。LiFlowを更新して起動できることを先に確認する。生成するXcodeプロジェクト・ビルド・結果はリポジトリ外へ置く。

```sh
export LIFLOW_QA_SIMULATOR="検査用シミュレーターのUDID"
ruby tests/native/calendar-ios/create-project.rb /tmp/liflow-calendar-ui-qa
xcodebuild test \
  -project /tmp/liflow-calendar-ui-qa/CalendarAudit.xcodeproj \
  -scheme CalendarAudit -configuration Debug -sdk iphonesimulator \
  -destination "id=$LIFLOW_QA_SIMULATOR" \
  -derivedDataPath /tmp/liflow-calendar-ui-qa/derived \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO \
  COMPILER_INDEX_STORE_ENABLE=NO \
  -resultBundlePath /tmp/liflow-calendar-ui-result.xcresult
```

結果のパスは実行ごとに新しくする。シミュレーターの外観は `xcrun simctl ui "$LIFLOW_QA_SIMULATOR" appearance light` / `dark` で設定できる。検査後は元へ戻す。アプリやシミュレーターを別のツール・人が同時操作すると検査が成立しないため、実行中は操作を重ねない。

SwiftUIのホイールはAXの値指定だけでは選択確定が届かない場合があるため、短いドラッグと表示値の確認を使う。画面遷移中にホイールが消えた場合は、遷移先を待って確認する。これらの結果を物理端末の背景同期の成功として扱わない。
