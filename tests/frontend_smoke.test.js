const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function createHarness() {
  const state = [];
  let cursor = 0;
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    }
  };
  const SDK = {
    React,
    hooks: {
      useState(initial) {
        const idx = cursor++;
        if (state[idx] === undefined) state[idx] = initial;
        return [state[idx], value => { state[idx] = typeof value === 'function' ? value(state[idx]) : value; }];
      },
      useEffect(fn) { fn(); },
      useRef(initial) { return { current: initial || null }; }
    },
    components: {
      Badge: 'Badge', Button: 'button', Label: 'label', Select: 'select', SelectOption: 'option'
    },
    utils: { cn: (...parts) => parts.filter(Boolean).join(' ') },
    fetchJSON: async () => ({
      presets: [{ id: 'model-a', provider: 'openrouter', current: true }],
      providers: [{ name: 'openrouter', label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', discoverable: true }]
    })
  };
  const window = {
    __HERMES_PLUGIN_SDK__: SDK,
    __HERMES_PLUGINS__: { registered: null, register(name, component) { this.registered = { name, component }; } }
  };
  return { window, state, resetCursor() { cursor = 0; } };
}

function walk(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  (node.children || []).flat().forEach(child => walk(child, predicate, found));
  return found;
}

const code = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
const harness = createHarness();
vm.runInNewContext(code, { window: harness.window, console, navigator: {}, Blob: function(){}, URL: {}, AbortController: function(){ this.signal = {}; this.abort = function(){}; }, TextDecoder });

assert.strictEqual(harness.window.__HERMES_PLUGINS__.registered.name, 'arena');
const ArenaPage = harness.window.__HERMES_PLUGINS__.registered.component;
harness.resetCursor();
const tree = ArenaPage();

assert(walk(tree, n => n.children && n.children.includes('Model Playground')).length === 1, 'renders Model Playground title');
assert(walk(tree, n => n.props && n.props.placeholder === 'Ask something that reveals model differences...').length === 1, 'renders prompt textarea');
assert(walk(tree, n => n.children && n.children.includes('Run comparison')).length === 1, 'renders run comparison button');
assert(walk(tree, n => n.children && n.children.includes('Random Prompt')).length === 1, 'renders random prompt button');
assert(walk(tree, n => n.children && n.children.includes('Add model')).length >= 1, 'renders add model action');

console.log('arena frontend smoke ok');
