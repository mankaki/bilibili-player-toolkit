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

test('default-close handles AI-only subtitles and respects manual changes per video', () => {
  let closed = true;
  let clicks = 0;
  let restores = 0;
  const closeSwitch = {
    classList: { contains: () => closed },
    click() {
      clicks++;
      closed = true;
    }
  };
  const location = { href: 'https://www.bilibili.com/video/BV1' };
  const context = {
    URL,
    location,
    getChineseSubtitleControls: () => ({ chinese: null, closeSwitch }),
    restoreChineseSubtitlePreference: () => restores++
  };
  vm.runInNewContext(`
    const MODE_CLOSED = 'closed';
    let subtitleDefaultMode = MODE_CLOSED;
    let subtitleUserOverrideKey = null;
    ${extractFunction('getPlaybackKey')}
    ${extractFunction('applySubtitlePreference')}
    this.apply = applySubtitlePreference;
    this.overrideCurrentVideo = () => { subtitleUserOverrideKey = getPlaybackKey(); };
  `, context);

  context.apply();
  assert.equal(clicks, 0, 'an initially closed AI-only subtitle needs no action');

  closed = false;
  context.apply();
  assert.equal(clicks, 1, 'a delayed initial-page restore is closed again');

  closed = false;
  context.overrideCurrentVideo();
  context.apply();
  assert.equal(clicks, 1, 'manual choice is preserved within the same video');

  location.href = 'https://www.bilibili.com/video/BV2';
  context.apply();
  assert.equal(clicks, 2, 'SPA navigation applies the default to the next video');
  assert.equal(restores, 0);
});

test('subtitle unchanged mode preserves the existing restore behavior', () => {
  let restores = 0;
  const context = {
    URL,
    location: { href: 'https://www.bilibili.com/video/BV1' },
    getChineseSubtitleControls: () => ({ chinese: null, closeSwitch: null }),
    restoreChineseSubtitlePreference: () => restores++
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
    showInfo: () => notices++
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
