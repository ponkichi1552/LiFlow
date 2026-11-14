import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// General macOS mouse input. No LiFlow labels, simulator IDs, or app data access.
var stopped = false
signal(SIGINT) { _ in stopped = true }
signal(SIGTERM) { _ in stopped = true }
struct GestureError: Error { let message: String }
func emit(_ value: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) { print(text); fflush(stdout) }
}
func windows() -> [[String: Any]] {
  let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return rows.filter { ($0[kCGWindowLayer as String] as? Int ?? 1) == 0 }.compactMap { row in
    guard let bounds = row[kCGWindowBounds as String] as? [String: Any] else { return nil }
    return ["id": row[kCGWindowNumber as String] ?? 0, "owner": row[kCGWindowOwnerName as String] ?? "",
      "pid": row[kCGWindowOwnerPID as String] ?? 0, "title": row[kCGWindowName as String] ?? "", "bounds": bounds]
  }
}
func main() throws {
  let args = Array(CommandLine.arguments.dropFirst())
  if args.first == "info" {
    emit(["accessibility": AXIsProcessTrusted(), "postEvents": CGPreflightPostEventAccess(), "coordinateSpace": "global display points, top-left origin", "windows": windows()]); return
  }
  var values: [String: String] = [:]; var flags = Set<String>(); var index = 1
  while index < args.count {
    let key = args[index]
    if ["--dry-run", "--pause-held", "--pause-moved", "--activate"].contains(key) { flags.insert(key); index += 1 }
    else { guard index + 1 < args.count else { throw GestureError(message: "Missing value: \(key)") }; values[key] = args[index + 1]; index += 2 }
  }
  func number(_ name: String, _ fallback: Double? = nil) throws -> Double {
    guard let result = values[name].flatMap(Double.init) ?? fallback, result.isFinite else { throw GestureError(message: "Invalid number: \(name)") }; return result
  }
  let source = CGEventSource(stateID: .hidSystemState)
  func post(_ type: CGEventType, _ point: CGPoint) {
    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    event?.setIntegerValueField(.mouseEventClickState, value: 1); event?.post(tap: .cghidEventTap)
  }
  if args.first == "release" { guard CGPreflightPostEventAccess() else { throw GestureError(message: "Mouse input permission is not granted") }; post(.leftMouseUp, CGEvent(source: nil)?.location ?? .zero); emit(["released": true]); return }
  guard args.first == "drag" else { throw GestureError(message: "Use info, drag, or release") }
  var start = CGPoint(x: try number("--from-x"), y: try number("--from-y"))
  var end = CGPoint(x: try number("--to-x"), y: try number("--to-y"))
  var window: [String: Any]?
  if let id = values["--window-id"].flatMap(Int.init) {
    guard let row = windows().first(where: { ($0["id"] as? Int) == id }), let b = row["bounds"] as? [String: Any],
      let x = b["X"] as? Double, let y = b["Y"] as? Double, let w = b["Width"] as? Double, let h = b["Height"] as? Double else { throw GestureError(message: "Window is not on screen; refresh its ID") }
    let iw = try number("--image-width", w); let ih = try number("--image-height", h)
    guard iw > 0 && ih > 0 else { throw GestureError(message: "Image size must be positive") }
    start = CGPoint(x: x + start.x * w / iw, y: y + start.y * h / ih); end = CGPoint(x: x + end.x * w / iw, y: y + end.y * h / ih); window = row
  } else if values["--image-width"] != nil || values["--image-height"] != nil { throw GestureError(message: "Image coordinates require --window-id") }
  let hold = try number("--hold-ms", 350) / 1000; let duration = try number("--move-ms", 650) / 1000; let endHold = try number("--end-hold-ms", 150) / 1000
  guard hold >= 0 && hold <= 5 && duration > 0 && duration <= 10 && endHold >= 0 && endHold <= 5 else { throw GestureError(message: "Hold: 0..5000 ms; move: 1..10000 ms") }
  var displays = [CGDirectDisplayID](repeating: 0, count: 16); var count: UInt32 = 0
  guard CGGetActiveDisplayList(16, &displays, &count) == .success, [start, end].allSatisfy({ point in displays.prefix(Int(count)).contains { CGDisplayBounds($0).contains(point) } }) else { throw GestureError(message: "Gesture coordinates are outside active displays") }
  let resolved: [String: Any] = ["from": [start.x, start.y], "to": [end.x, end.y], "holdMs": hold * 1000, "moveMs": duration * 1000, "endHoldMs": endHold * 1000]
  if flags.contains("--dry-run") { emit(["phase": "dry-run", "gesture": resolved, "postEvents": CGPreflightPostEventAccess()]); return }
  guard CGPreflightPostEventAccess() else { throw GestureError(message: "Mouse input permission is not granted; no permission is requested automatically") }
  if flags.contains("--activate") {
    guard let row = window, let pid = row["pid"] as? Int32, let app = NSRunningApplication(processIdentifier: pid) else { throw GestureError(message: "--activate needs a visible --window-id") }
    app.activate(); Thread.sleep(forTimeInterval: 0.2)
    let topAtStart = windows().first { entry in
      guard let b = entry["bounds"] as? [String: Any], let x = b["X"] as? Double, let y = b["Y"] as? Double,
        let w = b["Width"] as? Double, let h = b["Height"] as? Double else { return false }
      return CGRect(x: x, y: y, width: w, height: h).contains(start)
    }
    guard topAtStart?["id"] as? Int == row["id"] as? Int else { throw GestureError(message: "Another window covers the start point; select the target window first") }
  }
  let session = values["--session"].map { URL(fileURLWithPath: $0, isDirectory: true) }
  if flags.contains("--pause-held") || flags.contains("--pause-moved") { guard session != nil else { throw GestureError(message: "Checkpoint pauses need --session") } }
  if let session { try FileManager.default.createDirectory(at: session, withIntermediateDirectories: true) }
  func phase(_ name: String, _ point: CGPoint) throws {
    let data: [String: Any] = ["phase": name, "pid": ProcessInfo.processInfo.processIdentifier, "position": [point.x, point.y], "gesture": resolved, "at": Date().timeIntervalSince1970]
    if let session { try JSONSerialization.data(withJSONObject: data).write(to: session.appendingPathComponent("phase.json"), options: .atomic) }; emit(data)
  }
  func pause(_ name: String, _ point: CGPoint) throws {
    try phase(name, point)
    guard flags.contains("--pause-" + name), let session else { return }
    let gate = session.appendingPathComponent("continue-" + name); let deadline = Date().addingTimeInterval(30)
    while !FileManager.default.fileExists(atPath: gate.path) && !stopped && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
    guard !stopped && Date() < deadline else { throw GestureError(message: "Checkpoint interrupted or timed out; mouse released at its last position") }
  }
  var current = start; var down = false
  defer { if down { post(.leftMouseUp, current); emit(["phase": "released", "position": [current.x, current.y], "interrupted": stopped]) } }
  post(.mouseMoved, start); post(.leftMouseDown, start); down = true
  Thread.sleep(forTimeInterval: hold); try pause("held", current)
  let began = Date(); let frames = max(1, Int(ceil(duration * 60)))
  for step in 1...frames {
    if stopped { throw GestureError(message: "Gesture interrupted") }
    let fraction = Double(step) / Double(frames)
    current = CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
    post(.leftMouseDragged, current)
    let wait = duration * fraction - Date().timeIntervalSince(began); if wait > 0 { Thread.sleep(forTimeInterval: wait) }
  }
  Thread.sleep(forTimeInterval: endHold); try pause("moved", current)
  post(.leftMouseUp, current); down = false; try phase("released", current)
}
do { try main() } catch { emit(["error": (error as? GestureError)?.message ?? error.localizedDescription]); exit(1) }
