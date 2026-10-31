import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';

// Resolve the compiler from the installed SDK; npm may keep its dependency nested under expo.
const requireExpo = createRequire(import.meta.resolve('expo/package.json'));
const { transformSync } = requireExpo('@babel/core');
const { widgetsPlugin } = requireExpo('babel-preset-expo/build/plugins/widgets-plugin.js');

function loadWidgetLayout(platform) {
  const filename = new URL(`../src/platform/widgets/NextChoreWidget.${platform}.tsx`, import.meta.url);
  const { ast } = transformSync(readFileSync(filename, 'utf8'), {
    filename: filename.pathname,
    babelrc: false,
    configFile: false,
    ast: true,
    code: false,
    plugins: [
      ['@babel/plugin-transform-typescript', { isTSX: true }],
      ['@babel/plugin-transform-react-jsx', { runtime: 'automatic' }],
      widgetsPlugin,
    ],
  });
  const declaration = ast.program.body
    .filter((node) => node.type === 'VariableDeclaration')
    .flatMap((node) => node.declarations)
    .find((node) => node.id.name === 'NextChoreWidget');
  assert.equal(declaration?.init.type, 'TemplateLiteral');
  const layout = declaration.init.quasis[0].value.cooked;
  const jsx = (type, props, key) => ({ type, props, key });
  const globals = { _jsx: jsx, _jsxs: jsx };
  for (const component of ['Button', 'Column', 'HStack', 'Row', 'Text', 'VStack']) {
    globals[component] = component;
  }
  for (const modifier of ['background', 'border', 'buttonStyle', 'containerBackground', 'fillMaxWidth', 'font',
    'foregroundStyle', 'lineLimit', 'padding', 'paddingAll']) {
    globals[modifier] = (...args) => ({ modifier, args });
  }
  // Native widget execution receives only the serialized function and SDK globals.
  return runInNewContext(`(${layout})`, globals);
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

for (const platform of ['android', 'ios']) {
  test(`${platform} widget renders chores in its isolated runtime`, () => {
    const layout = loadWidgetLayout(platform);
    const tree = layout({
      chores: [
        { id: 'pending', name: 'エアコンのフィルターを掃除する', completed: false },
        { id: 'done', name: '洗濯をする', completed: true },
      ],
      pendingWidgetCompletionIds: [],
      remainingCount: 2,
      updatedAt: '2026-10-24T03:00:00.000Z',
    });
    const rendered = nodes(tree);
    const text = rendered.filter((node) => node.type === 'Text').map((node) => node.props.children);
    assert.ok(text.includes('エアコンのフィルターを掃除する'));
    assert.ok(text.includes('洗濯をする'));
    const buttons = rendered.filter((node) => node.type === 'Button');
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].props.target, 'complete:pending');
  });

  test(`${platform} widget completion updates the row and preserves pending actions`, () => {
    const layout = loadWidgetLayout(platform);
    const props = {
      chores: [
        { id: 'first', name: '一つ目の家事', completed: true },
        { id: 'second', name: '二つ目の家事', completed: false },
      ],
      pendingWidgetCompletionIds: ['first'],
      remainingCount: 1,
      updatedAt: '2026-10-24T03:00:00.000Z',
    };
    const button = nodes(layout(props)).find((node) => node.type === 'Button');
    const updated = (button.props.onClick ?? button.props.onPress)();
    assert.deepEqual(plain(updated.chores), [
      { id: 'first', name: '一つ目の家事', completed: true },
      { id: 'second', name: '二つ目の家事', completed: true },
    ]);
    assert.deepEqual(plain(updated.pendingWidgetCompletionIds), ['first', 'second']);
    assert.equal(props.chores[1].completed, false);
    assert.equal(nodes(layout({ ...props, ...updated })).filter((node) => node.type === 'Button').length, 0);
  });

  test(`${platform} widget renders the empty state before any snapshot is published`, () => {
    const layout = loadWidgetLayout(platform);
    const tree = layout({});
    assert.ok(nodes(tree).some((node) => node.type === 'Text' && node.props.children === '予定はありません'));
    assert.equal(nodes(tree).filter((node) => node.type === 'Button').length, 0);
  });
}
