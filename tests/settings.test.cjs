const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { URL } = require('node:url');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/../bilibili-player-toolkit.user.js`, 'utf8');
const compatibilitySource = readFileSync(`${__dirname}/../bili_skipper.user.js`, 'utf8');

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

test('new settings use the requested defaults', () => {
  const settingsSource = source.slice(
    source.indexOf('  const SETTINGS_STORAGE_PREFIX'),
    source.indexOf('  const storedSubtitlePreference')
  );
  const requestedKeys = [];
  const context = {
    localStorage: {
      getItem(key) {
        requestedKeys.push(key);
        return null;
      }
    }
  };
  vm.runInNewContext(`${settingsSource}
    this.values = { startupNoticeMode, danmakuDefaultMode, subtitleDefaultMode };
  `, context);

  assert.deepEqual({ ...context.values }, {
    startupNoticeMode: 'shortcuts',
    danmakuDefaultMode: 'unchanged',
    subtitleDefaultMode: 'unchanged'
  });
  assert.equal(requestedKeys.length, 3);
  assert.ok(requestedKeys.every((key) => key.startsWith('bilibili_player_toolkit:')));
  assert.match(source, /\/\/ @grant\s+none/);
  assert.match(compatibilitySource, /\/\/ @grant\s+none/);
  assert.doesNotMatch(source, /GM_(?:getValue|setValue|registerMenuCommand)/);
});

test('settings storage tolerates blocked access and invalid values', () => {
  const notices = [];
  const context = {
    localStorage: {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); }
    },
    showNotice: (message) => notices.push(message)
  };
  vm.runInNewContext(`
    ${extractFunction('getStoredValue')}
    ${extractFunction('setStoredValue')}
    ${extractFunction('readSetting')}
    ${extractFunction('writeSetting')}
    this.read = readSetting('key', 'fallback', ['valid']);
    this.written = writeSetting('key', 'valid');
  `, context);
  assert.equal(context.read, 'fallback');
  assert.equal(context.written, false);
  assert.equal(notices.length, 1);
});

test('startup notice is hidden by default and available in video mode', () => {
  const guardStart = source.lastIndexOf('  if (startupNoticeMode === STARTUP_NOTICE_VIDEO)');
  const guard = source.slice(guardStart, source.lastIndexOf('\n})();'));
  for (const [mode, expected] of [['shortcuts', 0], ['video', 1]]) {
    let shown = 0;
    vm.runInNewContext(guard, {
      startupNoticeMode: mode,
      STARTUP_NOTICE_VIDEO: 'video',
      showInfo: () => shown++
    });
    assert.equal(shown, expected);
  }
});

test('Shift+O settings entry persists all three choices', () => {
  const saved = new Map();
  const notices = [];
  const answers = ['1', '2', '2', '2', '3', '2'];
  const context = {
    prompt: () => answers.shift(),
    localStorage: { setItem: (key, value) => saved.set(key, value) },
    startDefaultPreferenceRetries() {},
    cancelSubtitleCloseConfirmation() {},
    resetSubtitleCloseAttempts() {},
    showNotice: (message) => notices.push(message),
    WeakSet
  };
  vm.runInNewContext(`
    const KEY_STARTUP_NOTICE = 'startup';
    const KEY_DANMAKU_DEFAULT = 'danmaku';
    const KEY_SUBTITLE_DEFAULT = 'subtitle';
    const MODE_UNCHANGED = 'unchanged';
    const MODE_CLOSED = 'closed';
    const STARTUP_NOTICE_SHORTCUTS = 'shortcuts';
    const STARTUP_NOTICE_VIDEO = 'video';
    let startupNoticeMode = STARTUP_NOTICE_SHORTCUTS;
    let danmakuDefaultMode = MODE_UNCHANGED;
    let subtitleDefaultMode = MODE_UNCHANGED;
    let danmakuUserOverrideKey = null;
    let subtitleUserOverrideKey = null;
    let restoredSubtitleControls = new WeakSet();
    ${extractFunction('setStoredValue')}
    ${extractFunction('writeSetting')}
    ${extractFunction('selectSetting')}
    ${extractFunction('configureStartupNotice')}
    ${extractFunction('configureDanmakuDefault')}
    ${extractFunction('configureSubtitleDefault')}
    ${extractFunction('openSettings')}
    openSettings();
    openSettings();
    openSettings();
  `, context);

  assert.deepEqual(Object.fromEntries(saved), {
    startup: 'video', danmaku: 'closed', subtitle: 'closed'
  });
  assert.equal(notices.length, 3);
  assert.match(source, /e\.code === 'KeyO' && e\.shiftKey/);
});

test('default-close survives a continuously visible subtitle layer reused by the next part', () => {
  let closed = false;
  let rendered = true;
  let subtitleText = '上一 P AI 字幕';
  let closeSucceeds = false;
  let clicks = 0;
  let restores = 0;
  const timers = [];
  const closeSwitch = {
    classList: { contains: () => closed },
    click() {
      clicks++;
      if (closeSucceeds) {
        closed = true;
        rendered = false;
      }
    }
  };
  const renderedSubtitle = {
    get textContent() { return subtitleText; },
    getClientRects: () => rendered ? [{}] : []
  };
  const location = { href: 'https://www.bilibili.com/video/BV1?p=1' };
  const context = {
    URL,
    location,
    getChineseSubtitleControls: () => ({
      chinese: null, closeSwitch, renderedSubtitles: [renderedSubtitle]
    }),
    restoreChineseSubtitlePreference: () => restores++,
    clearTimeout(timer) { timer.cancelled = true; },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    startDefaultPreferenceRetries() {},
    startPlaylistPositionRetries() {},
    showInfo() {},
    WeakSet
  };
  vm.runInNewContext(`
    const MODE_CLOSED = 'closed';
    const MAX_SUBTITLE_CLOSE_ATTEMPTS = 3;
    const STARTUP_NOTICE_VIDEO = 'video';
    let startupNoticeMode = 'shortcuts';
    let subtitleDefaultMode = MODE_CLOSED;
    let observedPlaybackKey = getPlaybackKey();
    let danmakuUserOverrideKey = null;
    let subtitleUserOverrideKey = observedPlaybackKey;
    let restoredSubtitleControls = new WeakSet();
    let subtitleCloseConfirmationTimer = null;
    let subtitleCloseConfirmationKey = null;
    let subtitleCloseAttemptsKey = observedPlaybackKey;
    let subtitleCloseAttempts = 0;
    let subtitleRenderedVisible = false;
    let subtitleRenderedSignature = '';
    let subtitleRenderedRetryWindowOpened = false;
    ${extractFunction('getPlaybackKey')}
    ${extractFunction('isRenderedSubtitleVisible')}
    ${extractFunction('getRenderedSubtitleSignature')}
    ${extractFunction('cancelSubtitleCloseConfirmation')}
    ${extractFunction('resetSubtitleCloseAttempts')}
    ${extractFunction('refreshSubtitleCloseAttemptWindow')}
    ${extractFunction('confirmSubtitleClosed')}
    ${extractFunction('scheduleSubtitleCloseConfirmation')}
    ${extractFunction('applySubtitlePreference')}
    ${extractFunction('handlePlaybackNavigation')}
    this.apply = applySubtitlePreference;
    this.overrideCurrentVideo = () => { subtitleUserOverrideKey = getPlaybackKey(); };
    this.navigate = handlePlaybackNavigation;
  `, context);

  location.href = 'https://www.bilibili.com/video/BV1?p=2';
  context.navigate();
  context.apply();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 500);
  let nextTimer = 0;
  while (nextTimer < timers.length) {
    const timer = timers[nextTimer++];
    if (!timer.cancelled) timer.callback();
  }
  assert.equal(clicks, 3, 'stale rendered subtitles cannot cause unbounded close attempts');

  closeSucceeds = true;
  closed = false;
  subtitleText = '下一 P AI 字幕';
  context.apply();
  assert.equal(timers.length, 5,
    'changed content in the reused layer opens one fresh bounded close window');
  timers[4].callback();
  assert.equal(clicks, 4, 'closes the asynchronously restored AI subtitle once');
  assert.equal(closed, true);
  assert.equal(rendered, false, 'the new part AI subtitle is actually closed');
  timers[5].callback();
  assert.equal(clicks, 4, 'the successful close is confirmed without another click');

  closed = false;
  rendered = true;
  context.overrideCurrentVideo();
  context.apply();
  assert.equal(clicks, 4, 'manual choice is preserved within the new part');
  assert.equal(timers.length, 6, 'manual choice does not schedule another close');
  assert.equal(restores, 0);
});

test('a rendered subtitle update can reopen the close window only once per part', () => {
  const context = {};
  vm.runInNewContext(`
    const MAX_SUBTITLE_CLOSE_ATTEMPTS = 3;
    let subtitleCloseAttemptsKey = 'part';
    let subtitleCloseAttempts = MAX_SUBTITLE_CLOSE_ATTEMPTS;
    let subtitleRenderedVisible = true;
    let subtitleRenderedSignature = 'old subtitle';
    let subtitleRenderedRetryWindowOpened = false;
    ${extractFunction('resetSubtitleCloseAttempts')}
    ${extractFunction('refreshSubtitleCloseAttemptWindow')}
    refreshSubtitleCloseAttemptWindow('part', 'new AI subtitle');
    this.firstAttempts = subtitleCloseAttempts;
    subtitleCloseAttempts = MAX_SUBTITLE_CLOSE_ATTEMPTS;
    refreshSubtitleCloseAttemptWindow('part', 'later subtitle line');
    this.secondAttempts = subtitleCloseAttempts;
  `, context);

  assert.equal(context.firstAttempts, 0, 'the first update to the reused layer gets fresh attempts');
  assert.equal(context.secondAttempts, 3, 'later subtitle lines cannot reopen the window');
});

test('subtitle unchanged mode preserves the existing restore behavior', () => {
  let restores = 0;
  const context = {
    URL,
    location: { href: 'https://www.bilibili.com/video/BV1' },
    getChineseSubtitleControls: () => ({ chinese: null, closeSwitch: null }),
    restoreChineseSubtitlePreference: () => restores++,
    cancelSubtitleCloseConfirmation() {}
  };
  vm.runInNewContext(`
    const MODE_CLOSED = 'closed';
    let subtitleDefaultMode = 'unchanged';
    let subtitleUserOverrideKey = null;
    ${extractFunction('getPlaybackKey')}
    ${extractFunction('applySubtitlePreference')}
    applySubtitlePreference();
  `, context);
  assert.equal(restores, 1);
});

test('navigation ignores incidental URL changes but resets overrides for a new part', () => {
  const location = { href: 'https://www.bilibili.com/video/BV1?p=1' };
  let scheduled = 0;
  let notices = 0;
  const context = {
    URL,
    location,
    WeakSet,
    startDefaultPreferenceRetries: () => scheduled++,
    startPlaylistPositionRetries: () => {},
    showInfo: () => notices++,
    cancelSubtitleCloseConfirmation() {},
    resetSubtitleCloseAttempts(_playbackKey, renderedSignature) {
      assert.equal(renderedSignature, '');
    },
    getChineseSubtitleControls: () => ({ renderedSubtitles: [] }),
    getRenderedSubtitleSignature: () => ''
  };
  vm.runInNewContext(`
    const STARTUP_NOTICE_VIDEO = 'video';
    let startupNoticeMode = STARTUP_NOTICE_VIDEO;
    let observedPlaybackKey = getPlaybackKey();
    let danmakuUserOverrideKey = observedPlaybackKey;
    let subtitleUserOverrideKey = observedPlaybackKey;
    let restoredSubtitleControls = new WeakSet();
    ${extractFunction('getPlaybackKey')}
    ${extractFunction('handlePlaybackNavigation')}
    this.navigate = handlePlaybackNavigation;
    this.getState = () => ({
      danmakuUserOverrideKey,
      subtitleUserOverrideKey,
      observedPlaybackKey
    });
  `, context);

  location.href = 'https://www.bilibili.com/video/BV1?p=1&t=80&spm_id_from=333#reply';
  context.navigate();
  assert.deepEqual({ ...context.getState() }, {
    danmakuUserOverrideKey: 'video:bv1|p=1',
    subtitleUserOverrideKey: 'video:bv1|p=1',
    observedPlaybackKey: 'video:bv1|p=1'
  });
  assert.equal(scheduled, 0);
  assert.equal(notices, 0);

  location.href = 'https://www.bilibili.com/video/BV1?p=2';
  context.navigate();
  assert.equal(context.getState().danmakuUserOverrideKey, null);
  assert.equal(context.getState().subtitleUserOverrideKey, null);
  assert.equal(context.getState().observedPlaybackKey, 'video:bv1|p=2');
  assert.equal(scheduled, 1);
  assert.equal(notices, 1);
});
