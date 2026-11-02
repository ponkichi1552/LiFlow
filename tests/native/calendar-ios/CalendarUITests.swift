import XCTest
import XCUIAutomation

@MainActor final class CalendarUITests: XCTestCase {
  override func setUpWithError() throws { continueAfterFailure = false }
  func shot(_ app: XCUIApplication, _ name: String) {
    let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
    let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-tree"; tree.lifetime = .keepAlways; add(tree)
  }
  func tap(_ app: XCUIApplication, _ label: String) {
    let button = app.buttons[label].firstMatch
    XCTAssertTrue(button.waitForExistence(timeout: 15), label)
    var scrolled = false
    for _ in 0..<6 {
      if button.isHittable { break }
      let scroll = app.scrollViews.containing(.button, identifier: label).firstMatch
      if scroll.exists {
        if button.frame.maxY <= scroll.frame.minY { scroll.swipeDown() } else { scroll.swipeUp() }
        scrolled = true
      }
      else {
        // Fixed headers can be briefly blocked while a native sheet dismisses.
        // Swiping the app here would browse an unrelated month or day.
        let ready = NSPredicate(format: "hittable == true")
        expectation(for: ready, evaluatedWith: button); waitForExpectations(timeout: 10)
        break
      }
    }
    XCTAssertTrue(button.isHittable, label)
    // XCTest can report a partially visible scroll target as hittable before
    // deceleration ends. Do not require identical floating-point AX frames.
    if scrolled {
      let settled = expectation(description: "native scroll settled")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { settled.fulfill() }
      waitForExpectations(timeout: 2)
    }
    button.tap()
  }
  func keyboardReady(_ app: XCUIApplication) {
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 10))
    // Existence precedes the end of the keyboard's native slide animation.
    let ready = expectation(description: "native keyboard presented")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { ready.fulfill() }
    waitForExpectations(timeout: 2)
  }
  // iOS 27 XCTest can omit a consecutive uppercase character in bulk injection
  // before the app receives an onChange event. Deliver literal keys individually;
  // the expected complete value and persisted round-trip checks remain unchanged.
  func typeLiteral(_ field: XCUIElement, _ value: String) {
    for character in value { field.typeText(String(character)) }
  }
  func replace(_ field: XCUIElement, _ value: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
    let before = field.value as? String ?? ""
    if !before.isEmpty { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: before.count)) }
    typeLiteral(field, value)
    expectation(for: NSPredicate(format: "value == %@", value), evaluatedWith: field); waitForExpectations(timeout: 5)
  }
  func view(_ app: XCUIApplication, _ label: String) {
    tap(app, "カレンダーの表示を選択"); tap(app, label)
  }
  func openBlankOwnCalendarEditor(_ app: XCUIApplication) {
    tap(app, "予定を追加")
    let name = app.textFields["予定名"].firstMatch
    XCTAssertTrue(name.waitForExistence(timeout: 10))
    let prior = name.value as? String ?? ""
    if !prior.isEmpty && prior != "予定名・家事名" {
      XCTAssertTrue(["QA-LiFlow-calendar", "QA-LiFlow-quick-input", "QA-LiFlow-calendar-today"].contains(prior), "Refuse to discard an unrelated unfinished draft")
      tap(app, "入力を破棄")
      XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 15)); tap(app, "予定を追加")
      XCTAssertTrue(name.waitForExistence(timeout: 10))
      XCTAssertTrue((name.value as? String ?? "").isEmpty || (name.value as? String) == "予定名・家事名")
    }
  }
  func jump(_ app: XCUIApplication, _ year: Int, _ month: Int) {
    tap(app, "表示する年と月を選択"); tap(app, String(year) + "年"); tap(app, String(month) + "月")
    tap(app, String(year) + "年" + String(month) + "月へ移動")
  }
  func removeOwnInterruptedEvent(_ app: XCUIApplication) {
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
    jump(app, calendar.component(.year, from: Date()) + 2, calendar.component(.month, from: Date()))
    view(app, "リスト表示")
    let normal = app.buttons["QA-LiFlow-calendarを編集"].firstMatch
    let interrupted = app.buttons["QA-LiFlow-calendarQA-LiFlow-calendar-todayを編集"].firstMatch
    var event = normal.exists ? normal : interrupted
    while event.exists {
      tap(app, event.label)
      let title = app.textFields["予定名"].firstMatch
      XCTAssertTrue(title.waitForExistence(timeout: 15))
      XCTAssertTrue(["QA-LiFlow-calendar", "QA-LiFlow-calendarQA-LiFlow-calendar-today"].contains(title.value as? String ?? ""))
      XCTAssertEqual(app.textFields["予定の場所"].firstMatch.value as? String, "QA room", "Never delete an unrelated event")
      if app.buttons["繰り返し全体"].exists { tap(app, "繰り返し全体") }
      tap(app, "予定を削除"); let remove = app.alerts.buttons["削除"].firstMatch
      XCTAssertTrue(remove.waitForExistence(timeout: 10)); remove.tap()
      expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["予定を保存"]); waitForExpectations(timeout: 90)
      XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 15))
      event = normal.exists ? normal : interrupted
    }
    tap(app, "今日"); tap(app, "月表示に戻る")
  }
  func wheel(_ app: XCUIApplication, _ value: String) {
    let picker = app.pickerWheels.firstMatch
    XCTAssertTrue(picker.waitForExistence(timeout: 10))
    let presets = ["繰り返さない", "毎日", "毎週", "隔週", "毎月", "毎年", "カスタム"]
    let ordinals = ["第1", "第2", "第3", "第4", "第5", "最後"]
    let weekdays = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"]
    let values = presets.contains(value) ? presets : ordinals.contains(value) ? ordinals : weekdays
    guard let target = values.firstIndex(of: value) else { XCTFail("Unknown option"); return }
    for _ in 0..<18 {
      if value == "カスタム" {
        if app.buttons["カスタム繰り返しを適用"].exists { return }
        if !picker.exists { XCTAssertTrue(app.buttons["カスタム繰り返しを適用"].waitForExistence(timeout: 15)); return }
      }
      guard let current = values.firstIndex(of: picker.value as? String ?? "") else { XCTFail("Unknown current picker value"); return }
      if current == target { return }
      let begin = picker.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
      let end = picker.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: current < target ? 0.36 : 0.64))
      begin.press(forDuration: 0.05, thenDragTo: end, withVelocity: XCUIGestureVelocity(rawValue: 40), thenHoldForDuration: 0.3)
    }
    XCTFail("Picker did not settle on " + value)
  }
  func testCalendarLiteralPlaceInput() throws {
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.terminate(); app.launch(); app.open(URL(string: "houseworkplanner://explore")!)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 30))
    openBlankOwnCalendarEditor(app)
    let name = app.textFields["予定名"].firstMatch
    name.tap(); keyboardReady(app); typeLiteral(name, "QA-LiFlow-calendar")
    replace(name, "QA-LiFlow-quick-input"); replace(name, "QA-LiFlow-calendar")
    let place = app.textFields["予定の場所"].firstMatch
    place.tap(); typeLiteral(place, "QA room")
    let first = place.value as? String ?? ""
    replace(place, "QA room 2")
    let rewritten = place.value as? String ?? ""
    shot(app, "literal-place-input")
    tap(app, "入力を破棄")
    XCTAssertEqual(first, "QA room", "A literal place name must retain every delivered character")
    XCTAssertEqual(rewritten, "QA room 2", "Rewriting a literal place must retain spaces and uppercase characters")
  }
  func testCalendarSaveEditDeleteAndNativePicker() throws {
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.terminate(); app.launch(); app.open(URL(string: "houseworkplanner://explore")!)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 30))
    removeOwnInterruptedEvent(app)
    shot(app, "01-month-dark")
    openBlankOwnCalendarEditor(app)
    let name = app.textFields["予定名"].firstMatch
    XCTAssertTrue(name.waitForExistence(timeout: 10)); name.tap()
    keyboardReady(app); typeLiteral(name, "QA-LiFlow-calendar")
    expectation(for: NSPredicate(format: "value == %@", "QA-LiFlow-calendar"), evaluatedWith: name); waitForExpectations(timeout: 5)
    replace(name, "QA-LiFlow-quick-input"); replace(name, "QA-LiFlow-calendar")
    let location = app.textFields["予定の場所"].firstMatch; replace(location, "QA room")
    let notes = app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", "予定のメモ")).firstMatch
    notes.tap(); typeLiteral(notes, "QA verification")
    app.swipeUp(); tap(app, "開始日を選択")
    XCTAssertTrue(app.buttons["開始日の選択を完了"].waitForExistence(timeout: 10)); XCTAssertEqual(app.pickerWheels.count, 3)
    var qaCalendar = Calendar(identifier: .gregorian); qaCalendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
    let qaYear = qaCalendar.component(.year, from: Date()) + 2
    app.pickerWheels.element(boundBy: 0).adjust(toPickerWheelValue: String(qaYear) + "年")
    shot(app, "02-full-width-date-picker"); tap(app, "開始日の選択を完了")
    let dateText = app.buttons["開始日を選択"].firstMatch.value as? String ?? ""
    let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX"); format.timeZone = TimeZone(identifier: "Asia/Tokyo"); format.dateFormat = "yyyy/MM/dd"
    let qaDate = try XCTUnwrap(format.date(from: dateText))
    app.swipeDown()
    let allDay = app.switches["終日"].firstMatch
    for _ in 0..<3 { if allDay.isHittable { break }; app.swipeDown() }
    allDay.tap()
    tap(app, "繰り返しを選択"); wheel(app, "隔週"); tap(app, "繰り返しの選択を完了")
    expectation(for: NSPredicate(format: "value == %@", "隔週"), evaluatedWith: app.buttons["繰り返しを選択"].firstMatch); waitForExpectations(timeout: 5)
    tap(app, "繰り返しを選択"); wheel(app, "カスタム")
    XCTAssertTrue(app.buttons["カスタム繰り返しを適用"].waitForExistence(timeout: 15))
    replace(app.textFields["繰り返しの間隔"].firstMatch, "2")
    tap(app, "月"); tap(app, "第N曜日"); tap(app, "月の週を選択"); wheel(app, "最後"); tap(app, "週の選択を完了")
    tap(app, "月の曜日を選択"); wheel(app, "金曜日"); tap(app, "曜日の選択を完了")
    shot(app, "03-custom-monthly-last-weekday")
    tap(app, "カスタム繰り返しを適用")
    XCTAssertTrue(app.buttons["予定を保存"].waitForExistence(timeout: 15))
    expectation(for: NSPredicate(format: "value == %@", "2か月ごと（最後の金曜）"), evaluatedWith: app.buttons["繰り返しを選択"].firstMatch); waitForExpectations(timeout: 5)
    tap(app, "繰り返しを選択"); tap(app, "繰り返しの選択を完了")
    XCTAssertTrue(app.buttons["カスタム繰り返しを適用"].waitForExistence(timeout: 15)); tap(app, "週")
    let days = ["日", "月", "火", "水", "木", "金", "土"]
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
    let startDay = calendar.component(.weekday, from: qaDate) - 1
    let wanted = Set([1, 4, startDay])
    for (index, day) in days.enumerated() {
      let button = app.buttons[day + "曜日に繰り返す"].firstMatch
      if button.isSelected != wanted.contains(index) { button.tap() }
    }
    shot(app, "04-custom-weekdays"); tap(app, "カスタム繰り返しを適用")
    XCTAssertTrue(app.buttons["予定を保存"].waitForExistence(timeout: 15))
    XCTAssertEqual(app.textFields["予定名"].firstMatch.value as? String, "QA-LiFlow-calendar")
    XCTAssertEqual(app.textFields["予定の場所"].firstMatch.value as? String, "QA room")
    XCTAssertEqual(app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", "予定のメモ")).firstMatch.value as? String, "QA verification")
    shot(app, "05-grouped-event-form"); tap(app, "予定を保存")
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["予定を保存"]); waitForExpectations(timeout: 90)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 15)); view(app, "1日表示")
    let event = app.buttons["QA-LiFlow-calendarを編集"].firstMatch
    XCTAssertTrue(event.waitForExistence(timeout: 15)); shot(app, "06-day-with-collapsed-chores"); tap(app, "QA-LiFlow-calendarを編集")
    XCTAssertTrue(app.buttons["今回だけ"].waitForExistence(timeout: 10))
    replace(app.textFields["予定名"].firstMatch, "QA-LiFlow-edited"); tap(app, "予定を保存")
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["予定を保存"]); waitForExpectations(timeout: 90)
    let edited = app.buttons["QA-LiFlow-editedを編集"].firstMatch
    XCTAssertTrue(edited.waitForExistence(timeout: 15)); tap(app, "QA-LiFlow-editedを編集"); tap(app, "繰り返し全体")
    XCTAssertEqual(app.textFields["予定名"].firstMatch.value as? String, "QA-LiFlow-calendar")
    tap(app, "予定を削除")
    let remove = app.alerts.buttons["削除"].firstMatch
    XCTAssertTrue(remove.waitForExistence(timeout: 10)); remove.tap()
      expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["予定を保存"]); waitForExpectations(timeout: 90)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 15)); XCTAssertFalse(app.buttons["QA-LiFlow-editedを編集"].exists)
    view(app, "2日表示"); shot(app, "07-two-day"); view(app, "リスト表示"); shot(app, "08-list")
    tap(app, "月表示に戻る"); tap(app, "年表示に戻る"); shot(app, "09-year"); tap(app, "今日"); shot(app, "10-final-month")
  }
  func testCoreScreenAppearance() throws {
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.terminate(); app.launch()
    app.open(URL(string: "houseworkplanner://")!)
    XCTAssertTrue(app.staticTexts["今日の家事"].firstMatch.waitForExistence(timeout: 20))
    XCTAssertFalse(app.staticTexts["所属グループの保存情報を読み込めませんでした。"].firstMatch.exists, "A visible fallback home is not a restored shared workspace")
    shot(app, "11-home")
    app.open(URL(string: "houseworkplanner://settings")!)
    XCTAssertTrue(app.staticTexts["設定"].firstMatch.waitForExistence(timeout: 20)); shot(app, "12-settings")
    app.open(URL(string: "houseworkplanner://guide")!)
    XCTAssertTrue(app.staticTexts["家事一覧"].firstMatch.waitForExistence(timeout: 20)); shot(app, "13-guide-list")
    let water = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "室内・水回りの清掃、")).firstMatch
    XCTAssertTrue(water.waitForExistence(timeout: 10)); water.tap()
    tap(app, "浴室掃除の説明を開く")
    XCTAssertTrue(app.staticTexts["家事の手順"].firstMatch.waitForExistence(timeout: 15)); shot(app, "14-guide-detail")
    app.open(URL(string: "houseworkplanner://manual")!)
    XCTAssertTrue(app.staticTexts["家電"].firstMatch.waitForExistence(timeout: 20)); shot(app, "15-appliance-list")
    let dyson = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "SV20")).firstMatch
    if dyson.exists { dyson.tap(); XCTAssertTrue(app.staticTexts["お手入れ方法"].firstMatch.waitForExistence(timeout: 15)); shot(app, "16-appliance-detail") }
    app.open(URL(string: "houseworkplanner://explore")!)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 20)); shot(app, "17-calendar")
  }

  func testChoreSettingsAudienceSwitch() throws {
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.launch()
    app.open(URL(string: "houseworkplanner://settings/chore/builtin-chore-01?source=personal")!)
    let personalCycle = app.textFields["家事周期の日数"].firstMatch
    XCTAssertTrue(personalCycle.waitForExistence(timeout: 30))
    let initialCycle = personalCycle.value as? String
    func audience(_ label: String) -> XCUIElement {
      app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }
    let shared = audience("グループ用の家事設定")
    XCTAssertTrue(shared.waitForExistence(timeout: 15)); XCTAssertTrue(shared.isHittable)
    shot(app, "settings-audience-personal")
    shared.tap()
    XCTAssertTrue(app.textFields["共有家事の名前"].firstMatch.waitForExistence(timeout: 30))
    shot(app, "settings-audience-shared")
    let personal = audience("個人用の家事設定")
    XCTAssertTrue(personal.waitForExistence(timeout: 10)); XCTAssertTrue(personal.isHittable)
    personal.tap()
    XCTAssertTrue(personalCycle.waitForExistence(timeout: 30)); XCTAssertEqual(personalCycle.value as? String, initialCycle)
    shot(app, "settings-audience-personal-restored")
  }

  func testSharedManualSyncAndLocalReads() throws {
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.launch(); app.open(URL(string: "houseworkplanner://sharing")!)
    let qaGroup = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "LiFlow-QA-")).firstMatch
    XCTAssertTrue(qaGroup.waitForExistence(timeout: 30), "Use the existing QA group only")
    tap(app, "グループを管理")
    let section = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "同期（未送信")).firstMatch
    XCTAssertTrue(section.waitForExistence(timeout: 30))
    for _ in 0..<6 { if section.isHittable { break }; app.swipeUp() }
    XCTAssertTrue(section.isHittable); section.tap()
    let status = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "最終同期：")).firstMatch
    XCTAssertTrue(status.waitForExistence(timeout: 10)); let before = status.label
    tap(app, "今すぐ同期")
    expectation(for: NSPredicate { _, _ in status.exists && status.label != before }, evaluatedWith: app)
    waitForExpectations(timeout: 120)
    XCTAssertTrue(app.buttons["今すぐ同期"].firstMatch.waitForExistence(timeout: 10))
    expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: app.buttons["今すぐ同期"].firstMatch)
    waitForExpectations(timeout: 120)
    XCTAssertFalse(app.staticTexts["同期を完了できませんでした。端末内の変更は保持し、再送します。"].exists)
    shot(app, "shared-sync-completed")
    app.open(URL(string: "houseworkplanner://settings/chore/builtin-chore-01?source=personal")!)
    let group = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "グループ用の家事設定")).firstMatch
    XCTAssertTrue(group.waitForExistence(timeout: 30)); group.tap()
    XCTAssertTrue(app.textFields["共有家事の名前"].firstMatch.waitForExistence(timeout: 30))
    app.open(URL(string: "houseworkplanner://explore")!)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 30))
    shot(app, "shared-reads-after-sync")
  }

  func testSavingTodayPreservesDateAcrossViewSwitch() throws {
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["今日の家事"].firstMatch.waitForExistence(timeout: 120))
    let calendarTab = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "tab, 2 of 4")).firstMatch
    XCTAssertTrue(calendarTab.waitForExistence(timeout: 10)); calendarTab.tap()
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 120))
    tap(app, "今日"); view(app, "リスト表示")
    let title = "QA-LiFlow-calendar-today"
    let event = app.buttons[title + "を編集"].firstMatch
    func removeOwnEvent() {
      event.tap()
      XCTAssertEqual(app.textFields["予定名"].firstMatch.value as? String, title)
      XCTAssertEqual(app.textFields["予定の場所"].firstMatch.value as? String, "QA room", "Never delete an unrelated event")
      tap(app, "予定を削除"); let remove = app.alerts.buttons["削除"].firstMatch
      XCTAssertTrue(remove.waitForExistence(timeout: 10)); remove.tap()
      expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["予定を保存"]); waitForExpectations(timeout: 90)
      XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 30))
    }
    if event.exists { removeOwnEvent() }
    tap(app, "月表示に戻る"); tap(app, "今日"); openBlankOwnCalendarEditor(app)
    let name = app.textFields["予定名"].firstMatch
    XCTAssertTrue(name.waitForExistence(timeout: 10)); name.tap()
    keyboardReady(app); name.typeText(title)
    replace(app.textFields["予定の場所"].firstMatch, "QA room")
    let allDay = app.switches["終日"].firstMatch
    XCTAssertTrue(allDay.waitForExistence(timeout: 10)); allDay.tap(); tap(app, "予定を保存")
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["予定を保存"]); waitForExpectations(timeout: 90)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 30)); shot(app, "today-after-save-month")
    view(app, "リスト表示")
    XCTAssertTrue(event.waitForExistence(timeout: 30), "Saving and opening List must retain the saved date")
    removeOwnEvent(); XCTAssertFalse(event.exists); shot(app, "today-after-delete-list")
  }
  func testPersonalGoogleCalendarConnection() throws {
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.launch(); app.open(URL(string: "houseworkplanner://settings")!)
    let section = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Google連携を")).firstMatch
    XCTAssertTrue(section.waitForExistence(timeout: 30))
    // A partially visible AX element may be reported hittable while XCTest's
    // automatic scroll changes its tap location. Bring it fully into view first.
    for _ in 0..<6 {
      let frame = section.frame; let viewport = app.frame.insetBy(dx: 0, dy: 130)
      if viewport.contains(frame) { break }
      if frame.maxY > viewport.maxY { app.swipeUp() } else { app.swipeDown() }
    }
    if section.label.contains("開く") { section.tap() }
    if section.label.contains("開く") { section.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
    shot(app, "personal-google-section")
    let toggle = app.switches.matching(NSPredicate(format: "label CONTAINS %@", "Googleカレンダーと個人予定を双方向同期")).firstMatch
    for _ in 0..<7 { if toggle.exists && toggle.isHittable { break }; app.swipeUp() }
    shot(app, "personal-google-controls")
    XCTAssertTrue(toggle.waitForExistence(timeout: 20)); XCTAssertTrue(toggle.isHittable)
    if String(describing: toggle.value ?? "0") != "1" { toggle.tap() }
    let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    if system.buttons["続ける"].waitForExistence(timeout: 2) { system.buttons["続ける"].tap() }
    // Only the consent for the explicitly enabled Calendar connection. Never
    // enter a password, dismiss unrelated alerts, or choose a different identity.
    for _ in 0..<12 {
      if String(describing: toggle.value ?? "0") == "1" { break }
      let browser = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
      let candidates = [app, browser, XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")]
      var acted = false
      for surface in candidates where surface.exists {
        let page = surface.webViews.firstMatch
        if page.exists {
          let next = page.links["続行"].firstMatch
          let button = page.buttons["続行"].firstMatch
          if next.exists && next.isHittable { next.tap(); acted = true; break }
          if button.exists && button.isHittable { button.tap(); acted = true; break }
        }
      }
      if !acted {
        let tick = expectation(description: "Calendar consent response")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { tick.fulfill() }; waitForExpectations(timeout: 2)
      }
    }
    shot(app, "personal-google-consent-result")
    expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: toggle); waitForExpectations(timeout: 90)
    let syncButtons = app.buttons.matching(identifier: "今すぐ同期")
    if syncButtons.count > 0 { syncButtons.element(boundBy: syncButtons.count - 1).tap() }
    expectation(for: NSPredicate { _, _ in !app.buttons["同期中…"].firstMatch.exists }, evaluatedWith: app)
    waitForExpectations(timeout: 180)
    for _ in 0..<3 { if app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "最終同期：")).firstMatch.isHittable { break }; app.swipeUp() }
    let synced = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND NOT (label CONTAINS %@)", "最終同期：", "まだ同期")).firstMatch
    XCTAssertTrue(synced.waitForExistence(timeout: 180)); shot(app, "personal-google-connected")
  }
  func testCreateOwnPersonalGoogleDeltaProbe() throws {
    guard ProcessInfo.processInfo.environment["LIFLOW_NATIVE_GOOGLE_E2E"] == "1" else {
      throw XCTSkip("実Googleの検査予定を作成し、別クライアントで照合・削除する手動E2E専用です。")
    }
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.launch(); app.open(URL(string: "houseworkplanner://explore")!)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 30)); tap(app, "今日"); view(app, "リスト表示")
    let title = "QA-LiFlow-iOS-delta-20261101"
    if !app.buttons[title + "を編集"].exists {
      tap(app, "予定を追加")
      let name = app.textFields["予定名"].firstMatch; XCTAssertTrue(name.waitForExistence(timeout: 10)); name.tap(); keyboardReady(app); name.typeText(title)
      let allDay = app.switches["終日"].firstMatch; XCTAssertTrue(allDay.exists)
      if String(describing: allDay.value ?? "0") != "1" { allDay.tap() }
      tap(app, "予定を保存")
      expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["予定を保存"]); waitForExpectations(timeout: 90)
    }
    XCTAssertTrue(app.buttons[title + "を編集"].waitForExistence(timeout: 30)); shot(app, "personal-google-own-delta-probe")
  }

  func testEditGoogleSeededOccurrence() throws {
    guard ProcessInfo.processInfo.environment["LIFLOW_NATIVE_GOOGLE_E2E"] == "1" else {
      throw XCTSkip("実Googleへ用意した専用の検査予定だけを編集する、手動E2E専用です。")
    }
    try testPersonalGoogleCalendarConnection()
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.open(URL(string: "houseworkplanner://explore")!)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 30))
    tap(app, "今日"); view(app, "リスト表示")
    let title = "QA-LiFlow-Google-E2E-20261101"
    let event = app.buttons[title + "を編集"].firstMatch
    XCTAssertTrue(event.waitForExistence(timeout: 90), "Googleで作った専用の繰り返し予定を受信する")
    tap(app, title + "を編集")
    XCTAssertEqual(app.textFields["予定名"].firstMatch.value as? String, title)
    XCTAssertEqual(app.textFields["予定の場所"].firstMatch.value as? String, "QA isolated verification", "Never edit an unrelated event")
    XCTAssertEqual(app.buttons["開始日を選択"].firstMatch.value as? String,
      ProcessInfo.processInfo.environment["LIFLOW_NATIVE_GOOGLE_ANCHOR"] ?? "2026/11/03")
    XCTAssertTrue(app.buttons["今回だけ"].firstMatch.isSelected)
    shot(app, "google-seeded-original-instance")
    replace(app.textFields["予定名"].firstMatch, title + "-native-edited")
    replace(app.textFields["予定の場所"].firstMatch, "QA native occurrence only")
    tap(app, "予定を保存")
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["予定を保存"]); waitForExpectations(timeout: 90)
    XCTAssertTrue(app.buttons[title + "-native-editedを編集"].firstMatch.waitForExistence(timeout: 30))
    XCTAssertTrue(app.buttons[title + "を編集"].firstMatch.exists, "翌週以降は元の予定名を保つ")
    shot(app, "google-seeded-one-instance-edited")
  }

  func testGoogleInboundUpdateOrDelete() throws {
    guard ProcessInfo.processInfo.environment["LIFLOW_NATIVE_GOOGLE_E2E"] == "1" else {
      throw XCTSkip("実Googleからの専用検査予定の変更・削除を照合する、手動E2E専用です。")
    }
    try testPersonalGoogleCalendarConnection()
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.open(URL(string: "houseworkplanner://explore")!)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 30))
    tap(app, "今日"); view(app, "リスト表示")
    let title = "QA-LiFlow-Google-E2E-20261101"
    if ProcessInfo.processInfo.environment["LIFLOW_NATIVE_GOOGLE_EXPECTED"] == "deleted" {
      XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH %@", title, "を編集")).count, 0)
      shot(app, "google-seeded-deletion-received")
    } else {
      tap(app, title + "-remote-editedを編集")
      XCTAssertEqual(app.textFields["予定名"].firstMatch.value as? String, title + "-remote-edited")
      XCTAssertEqual(app.textFields["予定の場所"].firstMatch.value as? String, "QA remote occurrence only")
      XCTAssertEqual(app.buttons["開始日を選択"].firstMatch.value as? String, "2026/11/10")
      shot(app, "google-seeded-remote-update-received")
      tap(app, "予定の編集を閉じる")
    }
  }

  func testUpgradeExistingQaGroupKeepingData() throws {
    guard ProcessInfo.processInfo.environment["LIFLOW_NATIVE_GROUP_UPGRADE"] == "1" else {
      throw XCTSkip("両実機更新・バックアップ・公開Rules照合後に限る、既存QAグループの互換更新検査です。")
    }
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.launch(); app.open(URL(string: "houseworkplanner://sharing/group/group.6437d178-515c-42ef-bc3f-fca0028404eb")!)
    tap(app, "更新・復旧を開く")
    let upgrade = app.buttons["共有グループを互換更新"].firstMatch
    XCTAssertTrue(upgrade.waitForExistence(timeout: 30)); shot(app, "existing-qa-before-compatible-upgrade")
    tap(app, "共有グループを互換更新")
    let confirm = app.alerts.buttons["更新する"].firstMatch
    XCTAssertTrue(confirm.waitForExistence(timeout: 10)); confirm.tap()
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: upgrade); waitForExpectations(timeout: 180)
    XCTAssertTrue(app.staticTexts["グループ設定"].firstMatch.exists)
    shot(app, "existing-qa-after-compatible-upgrade")
  }

}
