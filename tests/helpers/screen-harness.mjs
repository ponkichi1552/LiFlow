import './typescript-loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);

/** Runs the real TSX screen and event handlers with deterministic hooks and Native host controls.
 * Native layout/animation still needs simulator checks; persistence and screen wiring run in CI.
 */
export function screenHarness(filename, options = {}) {
  const slots = new Map();
  const modules = new Map();
  let current;
  let tree = [];
  const readError = options.readError ?? (() => null);
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const hook = (initial) => {
    const index = current.index++;
    const values = current.values;
    if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
    return [values[index], (value) => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
  };
  const react = {
    useState: hook,
    useRef: (value) => hook(() => ({ current: value }))[0],
    useMemo: (fn, deps) => {
      const [memo] = hook(() => ({ deps, value: fn() }));
      if (!deps || !memo.deps || deps.length !== memo.deps.length || deps.some((value, i) => !Object.is(value, memo.deps[i]))) { memo.deps = deps; memo.value = fn(); }
      return memo.value;
    }, useCallback: (fn, deps) => react.useMemo(() => fn, deps), useEffect: (callback) => options.effect?.(callback),
    useLayoutEffect: (callback) => options.layoutEffect?.(callback),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useContext: (context) => context._currentValue ?? null,
    createElement: (type, props, ...children) => jsx(type, { ...props, children }),
  };
  const transition = { duration: () => transition, springify: () => transition };
  const mocks = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    'react-native': {
      ...Object.fromEntries(['Text', 'View', 'Pressable', 'TextInput', 'Switch', 'ScrollView', 'KeyboardAvoidingView', 'ActivityIndicator', 'Modal'].map((name) => [name, name])),
      FlatList: (props) => {
        const [position, setPosition] = hook(null); const first = position ?? props.initialScrollIndex ?? 0;
        return jsx('FlatList', { ...props, onScroll: event => {
          if (props.getItemLayout) setPosition(Math.max(0, Math.floor(event.nativeEvent.contentOffset.y / props.getItemLayout(props.data, 0).length)));
          props.onScroll?.(event);
        }, children: [props.ListHeaderComponent,
          ...((props.data ?? []).length ? props.data.slice(first, first + (props.initialNumToRender ?? 10)).map((item, index) => props.renderItem({ item, index: index + first })) : [props.ListEmptyComponent]), props.ListFooterComponent] });
      },
      Platform: { OS: options.platform ?? process.env.HOUSEWORK_TEST_PLATFORM ?? 'ios' }, StyleSheet: { create: (styles) => styles, hairlineWidth: 1, absoluteFill: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 } },
      useColorScheme: () => options.colorScheme ?? 'light',
      useWindowDimensions: () => ({ width: options.width ?? 390, height: options.height ?? 844, fontScale: 1, scale: 3 }),
      PanResponder: { create: callbacks => ({ panHandlers: callbacks }) },
      AppState: { addEventListener: (_event, listener) => { options.appStateListener?.(listener); return { remove() {} }; } },
      Linking: { openURL: async () => {} },
      Alert: { alert: (...args) => options.alert?.(...args) },
    },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }) },
    'react-native-reanimated': {
      __esModule: true, default: { View: 'AnimatedView', FlatList: (props) => mocks['react-native'].FlatList(props) }, LinearTransition: transition,
      useSharedValue: (value) => hook(() => ({ value }))[0], useAnimatedStyle: (fn) => fn(), withTiming: (value) => value,
    },
    'expo-router': {
      useLocalSearchParams: () => options.params ?? {},
      useRouter: () => options.scopedRouter ?? mocks['expo-router'].router,
      useNavigation: () => ({ addListener: (event, listener) => { options.navigationListener?.(event, listener); return () => options.navigationUnsubscribe?.(event, listener); },
        setParams: (value) => { options.params = { ...options.params, ...value }; } }),
      router: { ...Object.fromEntries(['push', 'navigate', 'replace', 'back', 'dismissTo'].map((name) => [name, (...args) => options.navigate?.(name, ...args)])),
        setParams: (value) => { options.params = { ...options.params, ...value }; } },
      Tabs: { Screen: 'TabsScreen' }, useFocusEffect: (callback) => options.focusEffect?.(callback),
      usePreventRemove: (prevent, callback) => { options.preventRemove?.(prevent, callback); return () => options.disablePrevention?.(); },
    },
    'expo-sqlite': { useSQLiteContext: () => options.database },
    'expo-sqlite/kv-store': { __esModule: true, default: { getItemSync: () => null, setItemSync: () => {} } },
    'expo-symbols': { SymbolView: 'SymbolView' },
    '@expo/ui': { Host: 'NativeUIHost', Picker: Object.assign((props) => jsx('NativePicker', props), { Item: 'NativePickerItem' }) },
    'react-native-svg': { __esModule: true, default: 'Svg', ...Object.fromEntries(['Path', 'Rect', 'Line', 'Ellipse', 'G', 'Circle'].map(name => [name, name])) },
    '@react-native-community/datetimepicker': { __esModule: true, default: 'DateTimePicker', DateTimePickerAndroid: { open: params => options.datePicker?.(params) } },
    'expo-linking': { openURL: async (url) => options.openURL?.(url) },
    // Native FlatList jumps are tested directly in chore-book tests. Other screen tests
    // inspect the requested virtual chapter instead of pretending all chapters are mounted.
    '@/components/chore-book': { ChoreBook: (props) => jsx('ChoreBook', { ...props, children: [props.titleAccessory, props.header,
      props.renderChore(props.chores.find(row => row.id === props.selectedId) ?? props.chores[0]),
      jsx(load(resolve(root, 'src/components/planner-ui.tsx')).BackButton, { onPress: props.onBack })] }) },
    '@/hooks/use-planner-data': { usePlannerData: (scope) => scope?.personal && options.personalData ? options.personalData() : ({ loading: false, error: null, refresh: options.refresh ?? (async () => {}), database: options.database, snapshot: options.snapshot?.(), readSnapshot: options.snapshot ?? (() => null), readError }) },
    '@/features/weather/use-municipality-suggestions': { useMunicipalitySuggestions: () => ({ status: 'idle', candidates: [] }) },
    '@/platform/notifications/expo-local-notification-gateway': { ExpoLocalNotificationGateway: class { async requestPermission() { return false; } } },
    '@/features/google-sync/coordinator': { syncGoogleTasksAfterLocalCompletion: () => {} },
    // The real API client imports Native Platform. Screen tests inject responses explicitly; never start a paid API job implicitly.
    '../../appliance-care/api-client': { analyzeApplianceCareRequest: async () => { throw new Error('Appliance API transport was not injected by this screen test'); } },
    '@/platform/sharing/workspaces': { hasOtherGoogleWorkspaceConnections: async () => false },
    ...options.mocks,
  };

  const load = (path) => {
    if (modules.has(path)) return modules.get(path).exports;
    const mod = { exports: {} };
    modules.set(path, mod);
    let source = readFileSync(path, 'utf8');
    source = options.transformSource?.(path, source) ?? source;
    const { outputText } = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    }, fileName: path });
    const localRequire = (specifier) => {
      if (specifier in mocks) return mocks[specifier];
      let target = specifier.startsWith('@/') ? resolve(root, 'src', specifier.slice(2))
        : specifier.startsWith('.') ? resolve(dirname(path), specifier) : undefined;
      if (!target) return require(specifier);
      if (!extname(target)) target = ['.ts', '.tsx', '.mjs', '.js'].map((ext) => target + ext).find(existsSync) ?? target;
      return target.endsWith('.tsx') ? load(target) : require(target);
    };
    runInThisContext(`(function(require,module,exports){${outputText}\n})`, { filename: path })(localRequire, mod, mod.exports);
    return mod.exports;
  };

  const expand = (element, path) => {
    if (element === null || element === undefined || typeof element === 'boolean') return [];
    if (Array.isArray(element)) return element.flatMap((child, index) => expand(child, `${path}/${child?.key ?? index}`));
    if (typeof element !== 'object') return [String(element)];
    if (typeof element.type === 'function') {
      const identity = `${path}:${element.type.name}:${element.key ?? ''}`;
      if (!slots.has(identity)) slots.set(identity, []);
      const parent = current;
      current = { values: slots.get(identity), index: 0 };
      const output = element.type(element.props);
      current = parent;
      return expand(output, identity);
    }
    // A new key on a native host (not only a function component) remounts its
    // subtree, as React does when reopening an interactively dismissed Modal.
    const children = expand(element.props.children, path + '/children' + (element.key == null ? '' : `/key:${element.key}`));
    return [{ ...element, children }];
  };
  const component = load(resolve(root, filename))[options.exportName ?? 'default'];
  assert.equal(typeof component, 'function', `${filename} must export a usable screen`);
  const text = (node) => typeof node === 'string' ? node : (node.children ?? []).map(text).join('');
  const nodes = (items = tree) => items.flatMap((item) => typeof item === 'string' ? [] : item.props.accessibilityElementsHidden
    ? [item] : [item, ...nodes(item.children)]);
  const render = () => { tree = expand(jsx(component, options.props ?? {}), 'root'); return tree; };
  const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); render(); };
  const button = (name) => {
    const found = nodes().find((node) => node.props.accessibilityRole === 'button'
      && (node.props.accessibilityLabel === name || text(node) === name));
    assert.ok(found, `missing button: ${name}`);
    return found;
  };
  render();
  return {
    render, nodes, text: () => tree.map(text).join(''), button, flush,
    async press(name) {
      const node = button(name);
      assert.ok(!node.props.disabled && !node.props.accessibilityState?.disabled, `disabled button: ${name}`);
      await node.props.onPress({ stopPropagation() {} }); await flush();
    },
    async change(label, value) {
      const node = nodes().find((item) => item.type === 'TextInput' && item.props.accessibilityLabel === label);
      assert.ok(node, `missing input: ${label}`);
      assert.notEqual(node.props.editable, false, `read-only input: ${label}`);
      node.props.onChangeText(value); await flush();
    },
    async endEditing(label) {
      const node = nodes().find((item) => item.type === 'TextInput' && item.props.accessibilityLabel === label);
      assert.ok(node, `missing input: ${label}`);
      await node.props.onEndEditing?.(); await flush();
    },
  };
}
