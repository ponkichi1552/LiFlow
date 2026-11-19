import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { compileFunction } from 'node:vm';

const require = createRequire(import.meta.url);
const { transformSync } = require('@babel/core');
const library = path.join(path.dirname(require.resolve('react-native/package.json')), 'Libraries');
const factories = Object.fromEntries(['ReactNative/BridgelessUIManager', 'ReactNative/UIManager', 'Utilities/defineLazyObjectProperty'].map(name => {
  const filename = path.join(library, name + '.js');
  const { code } = transformSync(readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-flow-strip-types'), require.resolve('@babel/plugin-transform-modules-commonjs')],
  });
  return [name, compileFunction(code, ['require', 'module', 'exports', 'global', '__DEV__'])];
}));

function runtime(os = 'android', dev = false) {
  const bulk = [];
  const named = [];
  const events = { bubblingEventTypes: {}, directEventTypes: {} };
  const globals = {
    RN$Bridgeless: true,
    RN$LegacyInterop_UIManager_getConstants: () => {
      bulk.push(true);
      return { Eager: { name: 'Eager' }, ...(os === 'android' && { ViewManagerNames: ['View', 'Text'], LazyViewManagersEnabled: true }) };
    },
    RN$LegacyInterop_UIManager_getConstantsForViewManager: name => { named.push(name); return { name }; },
    RN$LegacyInterop_UIManager_getDefaultEventTypes: () => events,
  };
  const cache = new Map();
  const modules = {
    'Utilities/Platform': { OS: os, select: choices => choices[os] ?? choices.default },
    'NativeComponent/NativeComponentRegistryUnstable': { unstable_hasComponent: () => true },
    'ReactNative/FabricUIManager': {},
    nullthrows: value => { assert.ok(value != null); return value; },
  };
  const load = name => {
    if (Object.hasOwn(modules, name)) return modules[name];
    if (cache.has(name)) return cache.get(name);
    const module = { exports: {} };
    cache.set(name, module.exports);
    const resolve = specifier => load(specifier.startsWith('.') ? path.posix.join(path.posix.dirname(name), specifier) : specifier);
    factories[name](resolve, module, module.exports, globals, dev);
    cache.set(name, module.exports);
    return module.exports;
  };
  const { default: manager, getAndroidDefaultEventsBeforeConstants: fastDefaults } = load('ReactNative/UIManager');
  return { manager, inner: load('ReactNative/BridgelessUIManager').default, bulk, named, events, fastDefaults };
}

test('Android release loads only requested native configs until a caller asks for the catalogue', () => {
  const { manager, bulk, named, events, fastDefaults } = runtime();
  assert.deepEqual(bulk, []);
  assert.equal(fastDefaults(), events);
  const eager = manager.getViewManagerConfig('Eager');
  const view = manager.getViewManagerConfig('View');
  eager.fromCaller = true;
  assert.equal(manager.getViewManagerConfig('View'), view);
  assert.deepEqual(named, ['Eager', 'View']);
  assert.deepEqual(bulk, []);
  assert.equal(manager.getConstants().Eager, eager);
  assert.equal(manager.Eager, eager);
  assert.equal(manager.getConstants().View, view);
  assert.equal(manager.Eager.fromCaller, true);
  assert.equal(bulk.length, 1);
  assert.equal(fastDefaults(), null);
});

test('restored legacy descriptors preserve the public config across private mutation and object sealing', () => {
  const { manager, inner } = runtime();
  inner.Text = { name: 'changed privately' };
  assert.equal(manager.Text.name, 'Text');
  delete inner.View;
  assert.equal(manager.View.name, 'View');
  assert.equal('View' in inner, false);
  for (const lock of [Object.seal, Object.freeze]) {
    const instance = runtime().manager;
    lock(instance);
    assert.equal(instance.Text.name, 'Text');
    assert.deepEqual(Object.getOwnPropertyDescriptor(instance, 'Text').value, { name: 'Text' });
  }
});

test('iOS and Android development use the original eager interop and expose no fast path', () => {
  for (const [os, dev] of [['ios', false], ['android', true]]) {
    const { manager, bulk, fastDefaults } = runtime(os, dev);
    assert.equal(bulk.length, 1);
    assert.equal(fastDefaults, undefined);
    assert.equal(manager.Eager.name, 'Eager');
  }
});
