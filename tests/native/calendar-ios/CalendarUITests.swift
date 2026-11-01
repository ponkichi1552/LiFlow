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
  func replace(_ field: XCUIElement, _ value: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
    let before = field.value as? String ?? ""
    if !before.isEmpty { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: before.count)) }
    field.typeText(value)
    expectation(for: NSPredicate(format: "value == %@", value), evaluatedWith: field); waitForExpectations(timeout: 5)
  }
  func view(_ app: XCUIApplication, _ label: String) {
    tap(app, "カレンダーの表示を選択"); tap(app, label)
  }
  func jump(_ app: XCUIApplication, _ year: Int, _ month: Int) {
    tap(app, "表示する年と月を選択"); tap(app, String(year) + "年"); tap(app, String(month) + "月")
    tap(app, String(year) + "年" + String(month) + "月へ移動")
  }
  func removeOwnInterruptedEvent(_ app: XCUIApplication) {
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
    jump(app, calendar.component(.year, from: Date()) + 2, calendar.component(.month, from: Date()))
    view(app, "リスト表示")
    let event = app.buttons["QA-LiFlow-calendarを編集"].firstMatch
    while event.exists {
      tap(app, "QA-LiFlow-calendarを編集")
      XCTAssertEqual(app.textFields["予定名"].firstMatch.value as? String, "QA-LiFlow-calendar")
      XCTAssertEqual(app.textFields["予定の場所"].firstMatch.value as? String, "QA room", "Never delete an unrelated event")
      if app.buttons["繰り返し全体"].exists { tap(app, "繰り返し全体") }
      tap(app, "予定を削除"); let remove = app.alerts.buttons["削除"].firstMatch
      XCTAssertTrue(remove.waitForExistence(timeout: 10)); remove.tap()
      expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["予定を保存"]); waitForExpectations(timeout: 90)
      XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 15))
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
  func testCalendarSaveEditDeleteAndNativePicker() throws {
    let app = XCUIApplication(bundleIdentifier: "jp.jphacks.tkb2633")
    app.terminate(); app.launch(); app.open(URL(string: "houseworkplanner://explore")!)
    XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 30))
    removeOwnInterruptedEvent(app)
    if app.buttons["入力中の予定を再開"].exists {
      tap(app, "入力中の予定を再開")
      let prior = app.textFields["予定名"].firstMatch
      XCTAssertTrue(prior.waitForExistence(timeout: 10))
      XCTAssertTrue((prior.value as? String) == "QA-LiFlow-calendar", "Refuse to discard an unrelated unfinished draft")
      tap(app, "入力を破棄")
      XCTAssertTrue(app.buttons["予定を追加"].waitForExistence(timeout: 15))
    }
    shot(app, "01-month-dark")
    tap(app, "予定を追加")
    let name = app.textFields["予定名"].firstMatch
    XCTAssertTrue(name.waitForExistence(timeout: 10)); name.tap()
    keyboardReady(app); name.typeText("QA-LiFlow-calendar")
    expectation(for: NSPredicate(format: "value == %@", "QA-LiFlow-calendar"), evaluatedWith: name); waitForExpectations(timeout: 5)
    replace(name, "QA-LiFlow-quick-input"); replace(name, "QA-LiFlow-calendar")
    let location = app.textFields["予定の場所"].firstMatch; location.tap(); location.typeText("QA room")
    let notes = app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", "予定のメモ")).firstMatch
    notes.tap(); notes.typeText("QA verification")
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
    XCTAssertTrue(app.staticTexts["今日の家事"].firstMatch.waitForExistence(timeout: 20)); shot(app, "11-home")
    app.open(URL(string: "houseworkplanner://settings")!)
    XCTAssertTrue(app.staticTexts["設定"].firstMatch.waitForExistence(timeout: 20)); shot(app, "12-settings")
    app.open(URL(string: "houseworkplanner://guide")!)
    XCTAssertTrue(app.staticTexts["家事の説明"].firstMatch.waitForExistence(timeout: 20)); shot(app, "13-guide-list")
    let water = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "水回り、")).firstMatch
    XCTAssertTrue(water.waitForExistence(timeout: 10)); water.tap()
    tap(app, "浴室全体を掃除する、水回り")
    XCTAssertTrue(app.staticTexts["家事の手順"].firstMatch.waitForExistence(timeout: 15)); shot(app, "14-guide-detail")
    app.open(URL(string: "houseworkplanner://manual")!)
    XCTAssertTrue(app.staticTexts["家電の説明"].firstMatch.waitForExistence(timeout: 20)); shot(app, "15-appliance-list")
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
    tap(app, "月表示に戻る"); tap(app, "今日"); tap(app, "予定を追加")
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
}
