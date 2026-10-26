const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { URL } = require('node:url');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/../bilibili-player-toolkit.user.js`, 'utf8');
const danmakuFunctions = source.slice(
  source.indexOf('  function getPlaybackKey()'),
  source.indexOf('  const CURRENT_PLAYLIST_ITEM_SELECTOR')
);
const keyboardStart = source.indexOf("  document.addEventListener('keydown'");
const keyboardEndMarker = '  }, true); // ★';
const keyboardEnd = source.indexOf(keyboardEndMarker, keyboardStart) + keyboardEndMarker.length;
const toggleSource = source.slice(source.indexOf('  function toggleDanmaku('), keyboardStart);
const keyboardSource = `
  const MODE_CLOSED = 'closed';
  let danmakuDefaultMode = MODE_CLOSED;
  let danmakuUserOverrideKey = null;
  ${danmakuFunctions}
  ${toggleSource}
  ${source.slice(keyboardStart, keyboardEnd)}
  this.testApi = { closeDanmaku, applyDefaultDanmakuPreference, skipSimplifiedDanmakuState };
`;

function setup(initial = 'true', { legacy = false, shadow = false, missing = false } = {}) {
  let state = initial;
  let clicks = 0;
  let listener;
  const input = {
    disabled: false,
    getAttribute: () => state,
    click() {
      clicks++;
      state = state === 'false' ? 'true' : state === 'true' && !legacy ? 'mixed' : 'false';
    }
  };
  const control = {
    querySelector: () => input,
    getClientRects: () => [{}]
  };
  const document = {
    activeElement: null,
    querySelectorAll: () => missing || shadow ? [] : [control],
    addEventListener: (type, fn, capture) => {
      assert.equal(type, 'keydown');
      assert.equal(capture, true);
      listener = fn;
    }
  };
  const host = { isConnected: true, shadowRoot: { querySelectorAll: () => [control] } };
  const context = {
    URL,
    document,
    shadowHostObservers: new Map(shadow ? [[host, { host }]] : []),
    location: { href: 'https://www.bilibili.com/video/BV1' },
    toggleChineseSubtitle() {},
    setTimes() {},
    localStorage: { setItem() {} },
    enabled: false,
    showInfo() {}
  };
  vm.runInNewContext(keyboardSource, context);
  function press(overrides = {}) {
    const event = {
      key: 'd', code: 'KeyD', repeat: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...overrides
    };
    listener(event);
    return event;
  }
  return {
    press, document, input, control, state: () => state, clicks: () => clicks,
    close: () => context.testApi.closeDanmaku(control),
    applyDefault: () => context.testApi.applyDefaultDanmakuPreference(),
    restoreState: (value) => { state = value; },
    navigate: (href) => { context.location.href = href; }
  };
}

test('default-close converts full and simplified danmaku to off', () => {
  const full = setup('true');
  full.applyDefault();
  assert.equal(full.state(), 'false');
  assert.equal(full.clicks(), 2);

  const simplified = setup('mixed');
  simplified.applyDefault();
  assert.equal(simplified.state(), 'false');
  assert.equal(simplified.clicks(), 1);
});

test('default-close leaves already disabled danmaku unchanged', () => {
  const player = setup('false');
  player.applyDefault();
  assert.equal(player.state(), 'false');
  assert.equal(player.clicks(), 0);
});

test('default-close corrects delayed player restoration on initial load and after SPA navigation', () => {
  const player = setup('false');
  player.applyDefault();
  assert.equal(player.clicks(), 0);

  player.restoreState('mixed');
  player.applyDefault();
  assert.equal(player.state(), 'false');
  assert.equal(player.clicks(), 1);

  player.navigate('https://www.bilibili.com/video/BV2');
  player.restoreState('true');
  player.applyDefault();
  assert.equal(player.state(), 'false');
  assert.equal(player.clicks(), 3);
});

test('manual danmaku choice is preserved until SPA navigation', () => {
  const player = setup('false');
  player.press();
  assert.equal(player.state(), 'true');

  player.applyDefault();
  assert.equal(player.state(), 'true');

  player.navigate('https://www.bilibili.com/video/BV2');
  player.applyDefault();
  assert.equal(player.state(), 'false');
});

test('manual danmaku choice survives unrelated URL changes on the same video', () => {
  const player = setup('false');
  player.press();
  player.navigate('https://www.bilibili.com/video/BV1?t=120&spm_id_from=333#reply');
  player.applyDefault();
  assert.equal(player.state(), 'true');

  player.navigate('https://www.bilibili.com/video/BV1?p=2');
  player.applyDefault();
  assert.equal(player.state(), 'false');
});

test('D alternates fully on/off without stopping at simplified', () => {
  const player = setup();
  for (const expected of ['false', 'true', 'false', 'true']) {
    const event = player.press();
    assert.equal(player.state(), expected);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  }
});

test('simplified starts by turning off', () => {
  const player = setup('mixed');
  player.press();
  assert.equal(player.state(), 'false');
  assert.equal(player.clicks(), 1);
});

test('legacy two-state switch only needs one click', () => {
  const player = setup('true', { legacy: true });
  player.press();
  assert.equal(player.state(), 'false');
  assert.equal(player.clicks(), 1);
});

test('held D is swallowed without cycling native or custom state', () => {
  const player = setup();
  const event = player.press({ repeat: true });
  assert.equal(player.clicks(), 0);
  assert.equal(event.stopped, true);
});

test('modifiers and IME composition are ignored', () => {
  for (const flag of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing']) {
    const player = setup();
    assert.equal(player.press({ [flag]: true }).prevented, undefined);
    assert.equal(player.clicks(), 0);
  }
});

test('text inputs and nested shadow editors are ignored', () => {
  for (const editor of [
    { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
    { tagName: 'DIV', isContentEditable: true }
  ]) {
    const player = setup();
    player.document.activeElement = { shadowRoot: { activeElement: editor } };
    assert.equal(player.press().prevented, undefined);
    assert.equal(player.clicks(), 0);
  }
});

test('finds controls inside an observed shadow root', () => {
  const player = setup('false', { shadow: true });
  player.press();
  assert.equal(player.state(), 'true');
});

test('missing, hidden, or disabled controls do not swallow D', () => {
  const missing = setup('true', { missing: true });
  const hidden = setup();
  hidden.control.getClientRects = () => [];
  const disabled = setup();
  disabled.input.disabled = true;
  for (const player of [missing, hidden, disabled]) {
    assert.equal(player.press().prevented, undefined);
    assert.equal(player.clicks(), 0);
  }
});
