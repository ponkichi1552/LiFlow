import Foundation
import Darwin

/// Independent of timeline replacement. The same file lock is held by the app and widget extension.
enum LiflowWidgetInputJournal {
  enum Failure: Error { case unavailable, invalid, full }
  static let processLock = NSLock()

  static func directory() throws -> URL {
    guard let group = WidgetsStorage.appGroupIdentifier,
      let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw Failure.unavailable }
    return root.appendingPathComponent("LiFlowWidgetInputs", isDirectory: true)
  }

  static func transaction<T>(at directory: URL, _ body: (inout [[String: Any]]) throws -> T) throws -> T {
    processLock.lock(); defer { processLock.unlock() }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let lock = open(directory.appendingPathComponent("inputs.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard lock >= 0 else { throw Failure.unavailable }; defer { close(lock) }
    guard flock(lock, LOCK_EX) == 0 else { throw Failure.unavailable }; defer { flock(lock, LOCK_UN) }
    let file = directory.appendingPathComponent("inputs.json")
    let old = try FileManager.default.fileExists(atPath: file.path) ? Data(contentsOf: file) : Data("[]".utf8)
    guard old.count <= 24_000_000, var rows = try JSONSerialization.jsonObject(with: old) as? [[String: Any]], rows.count <= 1000 else { throw Failure.invalid }
    let result = try body(&rows)
    let next = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
    if old != next {
      #if os(iOS)
      try next.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      #else
      try next.write(to: file, options: .atomic)
      #endif
      let descriptor = open(file.path, O_RDONLY)
      guard descriptor >= 0 else { throw Failure.unavailable }; defer { close(descriptor) }
      guard fsync(descriptor) == 0 else { throw Failure.unavailable }
      let folder = open(directory.path, O_RDONLY)
      guard folder >= 0 else { throw Failure.unavailable }; defer { close(folder) }
      guard fsync(folder) == 0 else { throw Failure.unavailable }
    }
    return result
  }

  static func read(at directory: URL) throws -> [[String: Any]] { try transaction(at: directory) { $0 } }
  static func append(_ operation: [String: Any], at directory: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: operation)
    guard data.count <= 24_000, let id = operation["id"] as? String, id.hasPrefix("completion-intent.") else { throw Failure.invalid }
    try transaction(at: directory) { rows in
      if rows.contains(where: { $0["id"] as? String == id }) { throw Failure.invalid }
      guard rows.count < 1000 else { throw Failure.full }; rows.append(operation)
    }
  }
  static func acknowledge(_ ids: [String], at directory: URL) throws {
    guard ids.count <= 1000, Set(ids).count == ids.count, ids.allSatisfy({ $0.hasPrefix("completion-intent.") && $0.count <= 80 }) else { throw Failure.invalid }
    let exact = Set(ids)
    try transaction(at: directory) { rows in rows.removeAll { row in (row["id"] as? String).map(exact.contains) ?? false } }
  }

  /// Capture an input, not a completed fact. The app rechecks entitlement, account and exact occurrence in SQLite.
  static func accept(props: [String: Any], target: String?, at directory: URL, now: Date = Date()) throws -> Bool {
    guard let target, target.hasPrefix("complete:") else { return false }
    let milliseconds = now.timeIntervalSince1970 * 1000
    guard props["subscriptionLocked"] as? Bool != true, props["contentStale"] as? Bool != true,
      let scope = props["widgetAccountScope"] as? String, !scope.isEmpty, scope.count <= 160,
      let contentUntil = props["contentUntil"] as? Double, contentUntil.isFinite, milliseconds < contentUntil,
      let published = props["publishedAtMs"] as? Double, published.isFinite, milliseconds >= published,
      let household = props["householdCreatedAt"] as? String,
      let chores = props["chores"] as? [[String: Any]] else { return false }
    if props["subscriptionEnforced"] as? Bool == true && props["accessUntil"] == nil { return false }
    if let deadline = props["accessUntil"] {
      guard let expiry = deadline as? Double, expiry.isFinite, milliseconds < expiry else { return false }
    }
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.calendar = Calendar(identifier: .gregorian)
    var selectedZone = TimeZone.current
    if let raw = props["displayTimeZone"] {
      guard let name = raw as? String, let zone = TimeZone(identifier: name) else { return false }; selectedZone = zone
    }
    formatter.timeZone = selectedZone; formatter.dateFormat = "yyyy-MM-dd"
    let day = formatter.string(from: now)
    let id = String(target.dropFirst("complete:".count))
    guard props["displayDate"] as? String == day,
      let chore = chores.first(where: { $0["id"] as? String == id && $0["completed"] as? Bool != true }),
      let entry = chore["entry"] as? [String: Any], entry["id"] as? String == id, entry["householdId"] as? String == "local-household" else { return false }
    try append(["id": "completion-intent.\(UUID().uuidString.lowercased())", "accountScope": scope, "householdCreatedAt": household,
      "acceptedAtMs": Int(milliseconds), "completedLocalDate": day, "timeZone": selectedZone.identifier, "entry": entry], at: directory)
    return true
  }
}
