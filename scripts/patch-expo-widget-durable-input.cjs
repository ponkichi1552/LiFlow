const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../node_modules/expo-widgets/ios');
if (!fs.existsSync(root)) process.exit(0);
function patch(file, before, after) {
  const target = path.join(root, file); const text = fs.readFileSync(target, 'utf8');
  if (text.includes(after)) return;
  if (!text.includes(before)) throw new Error(`Expo Widgets durable input patch no longer matches ${file}`);
  fs.writeFileSync(target, text.replace(before, after));
}
const storage = path.join(root, 'WidgetsStorage.swift');
const marker = '// LiFlow durable widget inputs';
let source = fs.readFileSync(storage, 'utf8');
source = source.split(`\n${marker}`)[0];
fs.writeFileSync(storage, `${source}\n${marker}\n${fs.readFileSync(path.join(__dirname, '../plugins/ios/WidgetCompletionJournal.swift'), 'utf8')}\n`);
patch('WidgetObject.swift', '    WidgetsStorage.set(entries.map { $0.toDictionary() }, forKey:',
`    if name == "NextChoreWidget", let control = entries.first?.props, control["__liflowAckOnly"] as? Bool == true {
      guard entries.count == 1, let ids = control["__liflowAcknowledgedOperationIds"] as? [String] else { throw LiflowWidgetInputJournal.Failure.invalid }
      try LiflowWidgetInputJournal.acknowledge(ids, at: LiflowWidgetInputJournal.directory())
      return
    }
    WidgetsStorage.set(entries.map { $0.toDictionary() }, forKey:`);
patch('WidgetObject.swift', `    guard let entries = WidgetsStorage.getArray(forKey: "__expo_widgets_\\(name)_timeline") as? [[String: Any]],
          let appContext else {
      return []
    }
    return try entries.map { try WidgetsJSTimelineEntry(from: $0, appContext: appContext) }`,
`    guard let appContext else { return [] }
    var entries = WidgetsStorage.getArray(forKey: "__expo_widgets_\\(name)_timeline") as? [[String: Any]] ?? []
    if name == "NextChoreWidget" {
      let operations = try LiflowWidgetInputJournal.read(at: LiflowWidgetInputJournal.directory())
      if entries.isEmpty { entries = [["timestamp": 0, "props": [:]]] }
      entries = entries.map { entry in
        var value = entry; var props = value["props"] as? [String: Any] ?? [:]
        props["nativeWidgetInputVersion"] = 1; props["nativeWidgetCompletionOperations"] = operations
        value["props"] = props; return value
      }
    }
    return try entries.map { try WidgetsJSTimelineEntry(from: $0, appContext: appContext) }`);
patch('Widgets/AppIntent.swift', '    environment["target"] = target',
`    if source == "NextChoreWidget", target?.hasPrefix("complete:") == true {
      guard try LiflowWidgetInputJournal.accept(props: props, target: target, at: LiflowWidgetInputJournal.directory()) else { return .result() }
    }
    environment["target"] = target`);
patch('Widgets/AppIntent.swift', '    if let newProps {\n      var newEntry = entry',
`    if var newProps {
      // New inputs live only in the locked journal. Never recreate the legacy ID-only queue.
      if source == "NextChoreWidget" { newProps.removeValue(forKey: "pendingWidgetCompletionIds") }
      var newEntry = entry`);
