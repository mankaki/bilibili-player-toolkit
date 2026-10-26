const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { URL } = require('node:url');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/../bilibili-player-toolkit.user.js`, 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test('controls added later to a shadow root schedule the default-state update', () => {
  let mutationCallback;
  let scheduled = 0;
  let retries = 0;
  let defaultRetries = 0;
  let observedOptions;
  class FakeElement {
    matches() { return true; }
    querySelector() { return null; }
    closest() { return this; }
  }
  class FakeText {
    constructor(parentElement) { this.parentElement = parentElement; }
  }
  class FakeMutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe(_root, options) { observedOptions = options; }
  }
  const host = {
    shadowRoot: {
      addEventListener() {},
      querySelector: () => null
    },
    isConnected: true
  };
  const context = {
    Element: FakeElement,
    MutationObserver: FakeMutationObserver,
    PLAYER_ENHANCEMENT_SELECTOR: '.enhancement',
    DEFAULT_PREFERENCE_SELECTOR: '.preference',
    SUBTITLE_RENDER_SELECTOR: '.subtitle-text',
    shadowHostObservers: new Map(),
    cleanupShadowHostObservers() {},
    disconnectShadowHostsInSubtree() {},
    scanAddedNodes() {},
    scanSubtree() {},
    schedulePlayerEnhancementUpdate: () => scheduled++,
    startPlaylistPositionRetries: () => retries++,
    startDefaultPreferenceRetries: () => defaultRetries++,
    handleManualPlayerControlClick() {}
  };
  vm.runInNewContext(`
    ${extractFunction('mayContainPlayerEnhancement')}
    ${extractFunction('mayContainDefaultPreferenceControl')}
    ${extractFunction('isDefaultPreferenceStateMutation')}
    ${extractFunction('observeShadowHost')}
    observeShadowHost(host);
  `, { ...context, host });

  assert.equal(observedOptions.characterData, true,
    'the observer receives text-node updates from existing subtitle elements');
  assert.equal(scheduled, 0);
  mutationCallback([{
    removedNodes: [],
    addedNodes: [new FakeElement()]
  }]);
  assert.equal(scheduled, 1);
  assert.equal(retries, 1);
  assert.equal(defaultRetries, 1);

  mutationCallback([{
    type: 'attributes',
    target: new FakeElement()
  }]);
  assert.equal(scheduled, 2, 'state-only attribute changes schedule enforcement');

  mutationCallback([{
    type: 'childList',
    target: new FakeElement(),
    removedNodes: [],
    addedNodes: []
  }]);
  assert.equal(scheduled, 3, 'rendered subtitle text changes schedule another state check');

  mutationCallback([{
    type: 'characterData',
    target: new FakeText(new FakeElement())
  }]);
  assert.equal(scheduled, 4,
    'updating an existing subtitle text node schedules another state check');
});

test('default-state retries cover delayed initial and SPA restoration with a finite schedule', () => {
  const timers = [];
  let scheduled = 0;
  const context = {
    clearTimeout() {},
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return delay;
    },
    schedulePlayerEnhancementUpdate: () => scheduled++
  };
  vm.runInNewContext(`
    let defaultPreferenceRetryTimers = [];
    ${extractFunction('startDefaultPreferenceRetries')}
    this.start = startDefaultPreferenceRetries;
  `, context);

  context.start();
  assert.deepEqual(timers.map(({ delay }) => delay), [0, 100, 250, 500, 1000, 2000, 4000, 7000]);
  timers.at(-1).callback();
  assert.equal(scheduled, 1, 'initial page still checks a state restored after one second');

  timers.length = 0;
  context.start();
  timers.at(-1).callback();
  assert.equal(scheduled, 2, 'SPA navigation starts the same bounded late-state check');
  assert.equal(timers.length, 8, 'retry schedule remains bounded');
});

test('subtitle controls are discovered inside captured open or closed shadow roots', () => {
  const chinese = {
    getAttribute: () => 'zh-CN',
    textContent: '中文（自动生成）'
  };
  const closeSwitch = {};
  const document = { querySelectorAll: () => [] };
  const shadowRoot = {
    querySelectorAll(selector) {
      if (selector.includes('language-item')) return [chinese];
      if (selector.includes('close-switch')) return [closeSwitch];
      return [];
    }
  };
  const host = { isConnected: true, shadowRoot: null };
  const context = {
    document,
    SUBTITLE_RENDER_SELECTOR: '.subtitle-text',
    shadowHostObservers: new Map([[host, { host, root: shadowRoot }]])
  };
  vm.runInNewContext(`
    ${extractFunction('getPlayerRoots')}
    ${extractFunction('queryPlayerElements')}
    ${extractFunction('getChineseSubtitleControls')}
    this.controls = getChineseSubtitleControls();
  `, context);

  assert.equal(context.controls.chinese, chinese);
  assert.equal(context.controls.closeSwitch, closeSwitch);
});

test('document click listener preserves controls exposed by an open shadow root', () => {
  let listener;
  const pendingTasks = [];
  class FakeElement {
    constructor(match = null) { this.match = match; }
    closest(selector) { return selector.includes(this.match) ? this : null; }
    getRootNode() { return null; }
  }
  class FakeShadowRoot {}
  const host = new FakeElement('not-a-control');
  const subtitleControl = new FakeElement('subtitle-close-switch');
  let state = 'mixed';
  let danmakuClicks = 0;
  const input = {
    getAttribute: () => state,
    click() {
      danmakuClicks++;
      state = 'false';
    }
  };
  const danmakuControl = new FakeElement('dm-switch');
  danmakuControl.querySelector = () => input;
  const document = {
    addEventListener(type, callback, capture) {
      assert.equal(type, 'click');
      assert.equal(capture, true);
      listener = callback;
    }
  };
  const context = {
    URL,
    location: { href: 'https://www.bilibili.com/video/BV1' },
    Element: FakeElement,
    ShadowRoot: FakeShadowRoot,
    document,
    setTimeout: (callback) => pendingTasks.push(callback),
    localStorage: { setItem() {} },
    getChineseSubtitleControls: () => ({ closeSwitch: null }),
    cancelSubtitleCloseConfirmation() {},
    restoredSubtitleControls: new WeakSet(),
    subtitleEnabled: null
  };
  vm.runInNewContext(`
    const MODE_CLOSED = 'closed';
    let danmakuDefaultMode = MODE_CLOSED;
    let danmakuUserOverrideKey = null;
    let subtitleUserOverrideKey = null;
    const handledManualControlEvents = new WeakSet();
    ${extractFunction('getPlaybackKey')}
    ${extractFunction('skipSimplifiedDanmakuState')}
    ${extractFunction('closestCrossShadow')}
    ${extractFunction('findControlInEvent')}
    ${extractFunction('saveNativeSubtitleState')}
    ${extractFunction('handleManualPlayerControlClick')}
    document.addEventListener('click', handleManualPlayerControlClick, true);
    this.getOverrides = () => ({ danmakuUserOverrideKey, subtitleUserOverrideKey });
  `, context);

  listener({
    isTrusted: true,
    target: host,
    composedPath: () => [danmakuControl, host]
  });
  assert.equal(context.getOverrides().danmakuUserOverrideKey, 'video:bv1|p=1');
  pendingTasks.shift()();
  assert.equal(state, 'false');
  assert.equal(danmakuClicks, 1);

  listener({
    isTrusted: true,
    target: host,
    composedPath: () => [subtitleControl, host]
  });
  assert.equal(context.getOverrides().subtitleUserOverrideKey, 'video:bv1|p=1');
});

test('closed shadow root listener preserves controls hidden from the document path', () => {
  let documentListener;
  let rootListener;
  let visiblePath = [];
  const pendingTasks = [];
  class FakeElement {
    constructor(match = null) { this.match = match; }
    closest(selector) { return selector.includes(this.match) ? this : null; }
    getRootNode() { return null; }
  }
  class FakeShadowRoot {}
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  const host = new FakeElement('not-a-control');
  host.isConnected = true;
  host.shadowRoot = null;
  const subtitleControl = new FakeElement('subtitle-close-switch');
  let state = 'mixed';
  let danmakuClicks = 0;
  const input = {
    getAttribute: () => state,
    click() {
      danmakuClicks++;
      state = 'false';
    }
  };
  const danmakuControl = new FakeElement('dm-switch');
  danmakuControl.querySelector = () => input;
  const root = {
    addEventListener(type, callback, capture) {
      assert.equal(type, 'click');
      assert.equal(capture, true);
      rootListener = callback;
    },
    querySelector: () => null
  };
  const document = {
    addEventListener(type, callback, capture) {
      assert.equal(type, 'click');
      assert.equal(capture, true);
      documentListener = callback;
    }
  };
  const context = {
    URL,
    location: { href: 'https://www.bilibili.com/video/BV1' },
    Element: FakeElement,
    ShadowRoot: FakeShadowRoot,
    MutationObserver: FakeMutationObserver,
    document,
    setTimeout: (callback) => pendingTasks.push(callback),
    localStorage: { setItem() {} },
    PLAYER_ENHANCEMENT_SELECTOR: '.enhancement',
    DEFAULT_PREFERENCE_SELECTOR: '.preference',
    SUBTITLE_RENDER_SELECTOR: '.subtitle-text',
    shadowHostObservers: new Map(),
    cleanupShadowHostObservers() {},
    disconnectShadowHostsInSubtree() {},
    scanAddedNodes() {},
    scanSubtree() {},
    schedulePlayerEnhancementUpdate() {},
    startPlaylistPositionRetries() {},
    startDefaultPreferenceRetries() {},
    getChineseSubtitleControls: () => ({ closeSwitch: null }),
    cancelSubtitleCloseConfirmation() {},
    restoredSubtitleControls: new WeakSet(),
    subtitleEnabled: null,
    host,
    root
  };
  vm.runInNewContext(`
    const MODE_CLOSED = 'closed';
    let danmakuDefaultMode = MODE_CLOSED;
    let danmakuUserOverrideKey = null;
    let subtitleUserOverrideKey = null;
    const handledManualControlEvents = new WeakSet();
    ${extractFunction('getPlaybackKey')}
    ${extractFunction('skipSimplifiedDanmakuState')}
    ${extractFunction('closestCrossShadow')}
    ${extractFunction('findControlInEvent')}
    ${extractFunction('saveNativeSubtitleState')}
    ${extractFunction('handleManualPlayerControlClick')}
    ${extractFunction('mayContainPlayerEnhancement')}
    ${extractFunction('mayContainDefaultPreferenceControl')}
    ${extractFunction('isDefaultPreferenceStateMutation')}
    ${extractFunction('observeShadowHost')}
    document.addEventListener('click', handleManualPlayerControlClick, true);
    observeShadowHost(host, root);
    this.getOverrides = () => ({ danmakuUserOverrideKey, subtitleUserOverrideKey });
  `, context);

  const danmakuEvent = {
    isTrusted: true,
    target: host,
    composedPath: () => visiblePath
  };
  visiblePath = [host];
  documentListener(danmakuEvent);
  assert.equal(context.getOverrides().danmakuUserOverrideKey, null,
    'the retargeted document path cannot reveal a closed-root control');
  visiblePath = [danmakuControl, host];
  rootListener(danmakuEvent);
  assert.equal(context.getOverrides().danmakuUserOverrideKey, 'video:bv1|p=1');
  pendingTasks.shift()();
  assert.equal(state, 'false');
  assert.equal(danmakuClicks, 1);

  const subtitleEvent = {
    isTrusted: true,
    target: host,
    composedPath: () => visiblePath
  };
  visiblePath = [host];
  documentListener(subtitleEvent);
  assert.equal(context.getOverrides().subtitleUserOverrideKey, null);
  visiblePath = [subtitleControl, host];
  rootListener(subtitleEvent);
  assert.equal(context.getOverrides().subtitleUserOverrideKey, 'video:bv1|p=1');
});
