# Calendarのnative待機と同期中断

`createGoogleCalendarApi`はAbortSignalをHTTPへ渡していたが、nativeの本人確認・トークン取得・HTTP・本文読取が中断を無視した場合、そのawaitが終わらなかった。4段階それぞれを止まらないPromiseで再現し、修正前は4件とも失敗した。Android自然実行で見られたpendingの原因を、この再現だけで断定するものではない。

呼出側の既存の時間枠が中断されたら、これらの待機も終了するようにした。同時リクエストで中断listenerを100個作らず、1つを共有し、最後のリクエストの終了時に除去する。中断後に返った結果から本文の読取・次の要求・成功扱いを続けない。本人・設定の照合は維持する。

Google側へ届いたか不明なwriteは、成功として消し込まない。実SQLiteと実API wrapperを使った回帰検査では、Google側がPOSTを確定した後に応答が止まる条件で時間枠を終了させた。送信intentを残し、後から端末で加えた編集を含めて再同期し、Google予定が1件に収束することを確認した。期限切れのpassへ遅れて届いた応答も消込には使わない。

関連129件、lint、型検査、feature contractの登録確認が通過した。ここには中断4段階、100並行要求のlistener解放、送信結果不明からの回復、および背景診断表示の検査を含む。全件3294件・隔離Cloud142件の先行結果とは別の、変更範囲の検査である。

証拠は`/tmp/liflow-resume-20261104/calendar-api-cancellation-before-fix.log`、`calendar-api-cancellation-affected-final.log`、`calendar-api-cancellation-{lint,typecheck,contracts}.log`。修正を含む通常Release v14の実機検査は、後続の結果として記録する。

## API外の本人確認も同じ時間枠へ含める

追加調査で、coordinatorがAPI外で行うnativeの本人確認にも、応答を待ち続ける経路があった。最初のguard、transaction開始後の本人確認、pageを書いた後の最終本人確認の3条件を実SQLiteで再現し、すべて期限後も終了しないことを修正前のテストで確認した。

本人確認の読取だけを既存の時間枠へ含めた。SQLiteのwrite・commit・rollback自体をPromise.raceで切り離す変更はしていない。本人確認が時間切れならrollbackの終了を待ってから共有キューを解放し、後から届いた本人確認で期限切れpageをcommitさせない。次の同期で1件の予定へ正常に回復することも検査した。

この追加を含む関連98件は全件PASS。lint・型検査も通過した。証拠は`calendar-identity-budget-before-fix.log`、`calendar-identity-budget-after-fix.log`、`calendar-identity-budget-affected-final.log`、`calendar-identity-budget-{lint,typecheck}.log`。先行129件との重複があるため加算しない。

Android v14では先行するAPI中断修正と診断表示をデータ保持で導入し、実画面の完了／処理待ちを確認済み。iPhoneの中間v14ビルドは、追加修正を最終候補へまとめるため安全に中止し、端末には未導入。追加の本人確認修正も含めるv15は両OSでビルド中で、完了したビルドや実機検査の結果とは区別する。

後続のv15を両実機へデータ保持で導入し、Android通常ホームとiPhoneのホーム→設定→背景診断→戻るが通過した。iPhoneのnativeコードはv13と同一で、今回のTypeScript4ファイルを含むproduction Hermesを再生成・既存署名で再署名して検証した。詳細は`ios-resume-2026-11-05.md`。この通常操作の合格は、実サービスで意図的に認証待機を止める検査や、v15の自然背景完了の証明ではない。

変更したcoordinatorが使われるCalendar結合・loopback・共有Google native・workspaceの61件も全件PASS（`calendar-identity-cross-domain.log`）。98件とは別の関連ファイル群で、先行全件検査の結果とは区別して記録した。
