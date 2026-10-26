// ==UserScript==
// @name         B站播放器增强工具箱
// @namespace    https://www.bilibili.com/
// @version      3.2.0
// @description  自动跳片头片尾、选集显示 P 序号、C 键切换中文字幕、D 键切换弹幕开关，并优先使用新版画中画
// @author       mankaki (modified)
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/bangumi/play/*
// @match        *://www.bilibili.com/list/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        none
// @run-at       document-start
// @license      GPL-3.0
// ==/UserScript==

(function () {
  'use strict';

  const TOOLKIT_VERSION = '3.2.0';
  const KEY_HEAD = 'bili_skip_head';
  const KEY_TAIL = 'bili_skip_tail';
  const KEY_ENABLED = 'bili_skip_enabled';
  const KEY_SUBTITLE_ENABLED = 'bili_chinese_subtitle_enabled';
  const SETTINGS_STORAGE_PREFIX = 'bilibili_player_toolkit:';
  const KEY_STARTUP_NOTICE = `${SETTINGS_STORAGE_PREFIX}startup_notice`;
  const KEY_DANMAKU_DEFAULT = `${SETTINGS_STORAGE_PREFIX}danmaku_default`;
  const KEY_SUBTITLE_DEFAULT = `${SETTINGS_STORAGE_PREFIX}subtitle_default`;
  const MODE_UNCHANGED = 'unchanged';
  const MODE_CLOSED = 'closed';
  const MAX_SUBTITLE_CLOSE_ATTEMPTS = 3;
  const STARTUP_NOTICE_SHORTCUTS = 'shortcuts';
  const STARTUP_NOTICE_VIDEO = 'video';
  function getStoredValue(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function setStoredValue(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function readSetting(key, fallback, allowedValues) {
    const value = getStoredValue(key);
    return allowedValues.includes(value) ? value : fallback;
  }

  function writeSetting(key, value) {
    if (!setStoredValue(key, value)) {
      showNotice('设置保存失败，请检查浏览器站点存储权限');
      return false;
    }
    return true;
  }

  let startupNoticeMode = readSetting(
    KEY_STARTUP_NOTICE, STARTUP_NOTICE_SHORTCUTS,
    [STARTUP_NOTICE_SHORTCUTS, STARTUP_NOTICE_VIDEO]
  );
  let danmakuDefaultMode = readSetting(
    KEY_DANMAKU_DEFAULT, MODE_UNCHANGED, [MODE_UNCHANGED, MODE_CLOSED]
  );
  let subtitleDefaultMode = readSetting(
    KEY_SUBTITLE_DEFAULT, MODE_UNCHANGED, [MODE_UNCHANGED, MODE_CLOSED]
  );
  const storedSubtitlePreference = getStoredValue(KEY_SUBTITLE_ENABLED);
  let subtitleEnabled = storedSubtitlePreference === null
    ? null
    : storedSubtitlePreference === 'true';
  let restoredSubtitleControls = new WeakSet();
  let observedPlaybackKey = getPlaybackKey();
  let danmakuUserOverrideKey = null;
  let subtitleUserOverrideKey = null;
  const handledManualControlEvents = new WeakSet();
  const SUBTITLE_RENDER_SELECTOR = [
    '.bpx-player-subtitle-panel-text',
    '.bpx-player-subtitle-wrap .bpx-player-subtitle-item',
    '.bilibili-player-video-subtitle .subtitle-item'
  ].join(', ');
  const PLAYER_ENHANCEMENT_SELECTOR = [
    '.bpx-player-ctrl-subtitle',
    '.bpx-player-ctrl-subtitle-title',
    '.bpx-player-ctrl-subtitle-language-item',
    '.bpx-player-ctrl-subtitle-close-switch',
    '.bpx-player-dm-switch',
    '.bpx-player-ctrl-pip-menu-item',
    '.bpx-player-ctrl-eplist-episodes-content',
    '.bpx-player-ctrl-eplist-multi-menu-item',
    '.video-pod__body',
    '.simple-base-item.page-item',
    SUBTITLE_RENDER_SELECTOR
  ].join(', ');
  const DEFAULT_PREFERENCE_SELECTOR = [
    '.bpx-player-ctrl-subtitle-language-item',
    '.bpx-player-ctrl-subtitle-close-switch',
    '.bpx-player-dm-switch',
    '.bpx-player-dm-switch input[type="checkbox"]'
  ].join(', ');
  let enhancementUpdateFrame = null;
  let defaultPreferenceRetryTimers = [];
  let subtitleCloseConfirmationTimer = null;
  let subtitleCloseConfirmationKey = null;
  let subtitleCloseAttemptsKey = observedPlaybackKey;
  let subtitleCloseAttempts = 0;
  let subtitleRenderedVisible = false;
  let subtitleRenderedSignature = '';
  let subtitleRenderedRetryWindowOpened = false;
  let playlistPositionRetryTimers = [];
  let lastPlaylistPositionKey = null;
  let nextPlaylistElementId = 1;
  const playlistElementIds = new WeakMap();
  const observedPlaylistRoots = new WeakSet();

  const playerEnhancementCss = `
    /* 选集列表从 P1 开始计数 */
    .bpx-player-ctrl-eplist-episodes-content {
      counter-reset: bilibili-part;
    }

    .bpx-player-ctrl-eplist-multi-menu-item {
      counter-increment: bilibili-part;
    }

    .bpx-player-ctrl-eplist-multi-menu-item-text::before {
      content: "P" counter(bilibili-part) " ";
      color: currentColor;
      font-variant-numeric: tabular-nums;
    }
  `;

  const style = document.createElement('style');
  style.dataset.bilibiliPlayerToolkitVersion = TOOLKIT_VERSION;
  style.textContent = playerEnhancementCss;

  function injectPlayerEnhancementStyle() {
    const container = document.head || document.documentElement;
    if (container && !style.isConnected) {
      container.appendChild(style);
    }
  }

  injectPlayerEnhancementStyle();
  if (!style.isConnected) {
    document.addEventListener('DOMContentLoaded', injectPlayerEnhancementStyle, { once: true });
  }

  function updateNativeSubtitleTip() {
    queryPlayerElements('.bpx-player-ctrl-subtitle').forEach((button) => {
      if (button.getAttribute('aria-label') !== '字幕 (c)') {
        button.setAttribute('aria-label', '字幕 (c)');
      }
    });

    queryPlayerElements('.bpx-player-ctrl-subtitle-title').forEach((title) => {
      if (title.textContent !== '字幕 (c)') {
        title.textContent = '字幕 (c)';
      }
    });
  }

  function preferSubtitlePictureInPicture() {
    const items = queryPlayerElements('.bpx-player-ctrl-pip-menu-item');
    const modernMode = items.find((item) => /新版画中画/.test(item.textContent || ''));

    if (modernMode && !modernMode.classList.contains('bpx-state-active')) {
      modernMode.click();
    }
  }

  function getPlaybackKey() {
    const url = new URL(location.href);
    const path = url.pathname.replace(/\/+$/, '');
    const videoMatch = path.match(/^\/video\/(BV[\w]+|av\d+)/i);
    const bangumiMatch = path.match(/^\/bangumi\/play\/(ep\d+|ss\d+)/i);
    const listMatch = path.match(/^\/list\/([^/]+)/i);
    let pageKey = `page:${path}`;
    let parameterNames = [];

    if (videoMatch) {
      pageKey = `video:${videoMatch[1].toLowerCase()}`;
      parameterNames = ['cid'];
    } else if (bangumiMatch) {
      pageKey = `bangumi:${bangumiMatch[1].toLowerCase()}`;
      parameterNames = ['ep_id', 'cid'];
    } else if (listMatch) {
      pageKey = `list:${listMatch[1].toLowerCase()}`;
      parameterNames = ['bvid', 'aid', 'oid', 'cid'];
    }

    const playbackParameters = parameterNames
      .filter((name) => url.searchParams.has(name))
      .map((name) => `${name}=${url.searchParams.get(name)}`);
    if (videoMatch || listMatch) {
      playbackParameters.push(`p=${url.searchParams.get('p') || '1'}`);
    }
    return [pageKey, ...playbackParameters].join('|');
  }

  function getPlayerRoots() {
    const roots = [document];
    shadowHostObservers.forEach(({ host, root }) => {
      const shadowRoot = root || host.shadowRoot;
      if (host.isConnected && shadowRoot) roots.push(shadowRoot);
    });
    return roots;
  }

  function queryPlayerElements(selector) {
    return getPlayerRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
  }

  function findDanmakuSwitch() {
    for (const root of getPlayerRoots()) {
      for (const control of root.querySelectorAll('.bpx-player-dm-switch')) {
        const input = control.querySelector('input[type="checkbox"]');
        if (input && !input.disabled && control.getClientRects().length) return control;
      }
    }
    return null;
  }

  function closeDanmaku(control) {
    const input = control.querySelector('input[type="checkbox"]');
    const state = input.getAttribute('aria-checked');
    if (state === 'false' || (state === null && !input.checked)) return;

    input.click();
    // 新版原生循环为开启 → 精简 → 关闭；旧版两档开关无需额外点击。
    skipSimplifiedDanmakuState(input);
  }

  function skipSimplifiedDanmakuState(input) {
    if (input.getAttribute('aria-checked') === 'mixed') input.click();
  }

  function applyDefaultDanmakuPreference() {
    if (danmakuDefaultMode !== MODE_CLOSED) return;

    const playbackKey = getPlaybackKey();
    if (danmakuUserOverrideKey === playbackKey) return;

    const control = findDanmakuSwitch();
    if (!control) return;

    closeDanmaku(control);
  }

  const CURRENT_PLAYLIST_ITEM_SELECTOR = [
    '.bpx-player-ctrl-eplist-multi-menu-item.bpx-state-multi-active-item',
    '.bpx-player-ctrl-eplist-multi-menu-item.bpx-state-active',
    '.bpx-player-ctrl-eplist-multi-menu-item-active',
    '.bpx-player-ctrl-eplist-multi-menu-item[aria-current="true"]'
  ].join(', ');
  const CURRENT_RIGHT_PLAYLIST_ITEM_SELECTOR = '.video-pod__body .simple-base-item.page-item.active';

  function ensurePlaylistItemVisible(currentItem) {
    const scrollContainer = currentItem.closest('.bpx-player-ctrl-eplist-section-bottom');
    if (!scrollContainer || scrollContainer.clientHeight <= 0) return;

    currentItem.dataset.biliToolkitPositionChecked = TOOLKIT_VERSION;
    const itemRect = currentItem.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    const isVisible = itemRect.top >= containerRect.top
      && itemRect.bottom <= containerRect.bottom;
    if (isVisible) return;

    const targetScrollTop = scrollContainer.scrollTop
      + itemRect.top - containerRect.top
      - (scrollContainer.clientHeight - itemRect.height) / 2;
    const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
    scrollContainer.scrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));
    scrollContainer.dataset.biliToolkitPositioned = TOOLKIT_VERSION;
  }

  function ensureRightPlaylistItemVisible(currentItem) {
    const scrollContainer = currentItem.closest('.video-pod__body');
    if (!scrollContainer || scrollContainer.clientHeight <= 0) return;

    currentItem.dataset.biliToolkitPositionChecked = TOOLKIT_VERSION;
    const itemRect = currentItem.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    const isVisible = itemRect.top >= containerRect.top
      && itemRect.bottom <= containerRect.bottom;
    if (isVisible) return;

    const targetScrollTop = scrollContainer.scrollTop
      + itemRect.top - containerRect.top
      - (scrollContainer.clientHeight - itemRect.height) / 2;
    const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;

    // 只滚动右侧合集容器；instant 可绕过其 CSS smooth，且不会带动整个页面。
    scrollContainer.scrollTo({
      top: Math.max(0, Math.min(targetScrollTop, maxScrollTop)),
      behavior: 'instant'
    });
    scrollContainer.dataset.biliToolkitPositioned = TOOLKIT_VERSION;
  }

  function positionPlaylistAtCurrentItem() {
    document.querySelectorAll(CURRENT_PLAYLIST_ITEM_SELECTOR)
      .forEach(ensurePlaylistItemVisible);
    document.querySelectorAll(CURRENT_RIGHT_PLAYLIST_ITEM_SELECTOR)
      .forEach(ensureRightPlaylistItemVisible);
  }

  function getPlaylistPositionKey() {
    const currentItems = Array.from(document.querySelectorAll([
      CURRENT_PLAYLIST_ITEM_SELECTOR,
      CURRENT_RIGHT_PLAYLIST_ITEM_SELECTOR
    ].join(', ')));

    const getElementId = (element) => {
      if (!element) return 0;
      if (!playlistElementIds.has(element)) {
        playlistElementIds.set(element, nextPlaylistElementId++);
      }
      return playlistElementIds.get(element);
    };

    return [location.href, ...currentItems.map((item) => {
      const root = item.closest(
        '.bpx-player-ctrl-eplist-section-bottom, .video-pod__body'
      );
      const semanticId = item.getAttribute('data-cid') || item.textContent?.trim() || '';
      return `${getElementId(root)}:${getElementId(item)}:${semanticId}`;
    })].join('|');
  }

  function cancelPlaylistPositionRetries() {
    playlistPositionRetryTimers.forEach(clearTimeout);
    playlistPositionRetryTimers = [];
  }

  function startPlaylistPositionRetries(force = false) {
    const positionKey = getPlaylistPositionKey();
    if (!force && positionKey === lastPlaylistPositionKey) return;

    cancelPlaylistPositionRetries();
    lastPlaylistPositionKey = positionKey;

    // B站可能在播放器渲染数秒后再次把合集列表重置到顶部。
    [0, 100, 250, 500, 1000, 2000, 4000, 7000, 10000].forEach((delay) => {
      playlistPositionRetryTimers.push(setTimeout(positionPlaylistAtCurrentItem, delay));
    });
  }

  function updatePlayerEnhancements() {
    updateNativeSubtitleTip();
    preferSubtitlePictureInPicture();
    applySubtitlePreference();
    applyDefaultDanmakuPreference();
    positionPlaylistAtCurrentItem();
  }

  function mayContainPlayerEnhancement(node) {
    return node instanceof Element && (
      node.matches(PLAYER_ENHANCEMENT_SELECTOR) ||
      node.querySelector(PLAYER_ENHANCEMENT_SELECTOR)
    );
  }

  function mayContainDefaultPreferenceControl(node) {
    return node instanceof Element && (
      node.matches(DEFAULT_PREFERENCE_SELECTOR) ||
      node.querySelector(DEFAULT_PREFERENCE_SELECTOR)
    );
  }

  function isDefaultPreferenceStateMutation(mutation) {
    const renderedSubtitleTarget = mutation.type === 'characterData'
      ? mutation.target.parentElement
      : mutation.target;
    const isRenderedSubtitleChange = (mutation.type === 'childList'
      || mutation.type === 'characterData')
      && renderedSubtitleTarget instanceof Element
      && (
        renderedSubtitleTarget.matches(SUBTITLE_RENDER_SELECTOR) ||
        renderedSubtitleTarget.closest(SUBTITLE_RENDER_SELECTOR)
      );
    return isRenderedSubtitleChange || mutation.type === 'attributes'
      && mutation.target instanceof Element
      && (
        mutation.target.matches(DEFAULT_PREFERENCE_SELECTOR) ||
        mutation.target.closest(DEFAULT_PREFERENCE_SELECTOR)
      );
  }

  function schedulePlayerEnhancementUpdate() {
    if (enhancementUpdateFrame !== null) return;

    enhancementUpdateFrame = requestAnimationFrame(() => {
      enhancementUpdateFrame = null;
      updatePlayerEnhancements();
    });
  }

  function startDefaultPreferenceRetries() {
    defaultPreferenceRetryTimers.forEach(clearTimeout);
    defaultPreferenceRetryTimers = [];

    // 播放器会在控件出现后异步恢复弹幕或字幕状态，轮询设有上限。
    [0, 100, 250, 500, 1000, 2000, 4000, 7000].forEach((delay) => {
      defaultPreferenceRetryTimers.push(setTimeout(schedulePlayerEnhancementUpdate, delay));
    });
  }

  function getChineseSubtitleControls() {
    const items = queryPlayerElements('.bpx-player-ctrl-subtitle-language-item');
    const chinese = items.find((item) => {
      const language = item.getAttribute('data-lan') || '';
      const text = item.textContent || '';
      return /(^|[-_*])zh([-_*]|$)/i.test(language) || /中文|简体|繁体/.test(text);
    });
    const [closeSwitch] = queryPlayerElements('.bpx-player-ctrl-subtitle-close-switch');

    const renderedSubtitles = queryPlayerElements(SUBTITLE_RENDER_SELECTOR);

    return { chinese, closeSwitch, renderedSubtitles };
  }

  function isRenderedSubtitleVisible(element) {
    if (!(element.textContent || '').trim()) return false;
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
  }

  function getRenderedSubtitleSignature(renderedSubtitles) {
    return renderedSubtitles
      .filter(isRenderedSubtitleVisible)
      .map((element) => {
        const language = typeof element.getAttribute === 'function'
          ? element.getAttribute('data-lan') || element.getAttribute('lang') || ''
          : '';
        return `${language}\u0000${(element.textContent || '').trim()}`;
      })
      .join('\u0001');
  }

  function cancelSubtitleCloseConfirmation(playbackKey = null) {
    if (playbackKey !== null && subtitleCloseConfirmationKey !== playbackKey) return;
    if (subtitleCloseConfirmationTimer !== null) clearTimeout(subtitleCloseConfirmationTimer);
    subtitleCloseConfirmationTimer = null;
    subtitleCloseConfirmationKey = null;
  }

  function resetSubtitleCloseAttempts(playbackKey = getPlaybackKey(), renderedSignature = '') {
    subtitleCloseAttemptsKey = playbackKey;
    subtitleCloseAttempts = 0;
    subtitleRenderedVisible = renderedSignature !== '';
    subtitleRenderedSignature = renderedSignature;
    subtitleRenderedRetryWindowOpened = false;
  }

  function refreshSubtitleCloseAttemptWindow(playbackKey, renderedSignature) {
    if (subtitleCloseAttemptsKey !== playbackKey) resetSubtitleCloseAttempts(playbackKey);
    const isRendered = renderedSignature !== '';
    const renderedLayerAppeared = isRendered && !subtitleRenderedVisible;
    const reusedLayerChanged = isRendered && subtitleRenderedVisible
      && renderedSignature !== subtitleRenderedSignature
      && subtitleCloseAttempts >= MAX_SUBTITLE_CLOSE_ATTEMPTS;
    if (!subtitleRenderedRetryWindowOpened && (renderedLayerAppeared || reusedLayerChanged)) {
      // 切 P 后只允许字幕新出现或残留层内容更新时重开一次，避免逐条更新无限重试。
      subtitleRenderedRetryWindowOpened = true;
      subtitleCloseAttempts = 0;
      subtitleRenderedSignature = renderedSignature;
    }
    subtitleRenderedVisible = isRendered;
  }

  function confirmSubtitleClosed(playbackKey) {
    subtitleCloseConfirmationTimer = null;
    subtitleCloseConfirmationKey = null;
    if (subtitleDefaultMode !== MODE_CLOSED || getPlaybackKey() !== playbackKey
      || subtitleUserOverrideKey === playbackKey) return;

    const { closeSwitch, renderedSubtitles } = getChineseSubtitleControls();
    if (!closeSwitch) return;

    const isClosed = closeSwitch.classList.contains('bpx-state-active');
    const renderedSignature = getRenderedSubtitleSignature(renderedSubtitles);
    const isRendered = renderedSignature !== '';
    refreshSubtitleCloseAttemptWindow(playbackKey, renderedSignature);
    if ((!isClosed || isRendered) && subtitleCloseAttempts < MAX_SUBTITLE_CLOSE_ATTEMPTS) {
      subtitleCloseAttempts++;
      closeSwitch.click();
      // 点击可能只显示“字幕已关闭”提示而未改变 DOM；主动复核，不依赖外部 mutation。
      scheduleSubtitleCloseConfirmation(playbackKey, true);
    }
  }

  function scheduleSubtitleCloseConfirmation(playbackKey, verifyLastAttempt = false) {
    if (subtitleCloseAttemptsKey !== playbackKey) resetSubtitleCloseAttempts(playbackKey);
    if (!verifyLastAttempt && subtitleCloseAttempts >= MAX_SUBTITLE_CLOSE_ATTEMPTS) return;
    if (subtitleCloseConfirmationKey === playbackKey) return;
    cancelSubtitleCloseConfirmation();
    subtitleCloseConfirmationKey = playbackKey;
    // 切 P 时播放器会先沿用旧控件状态，再异步加载字幕列表和记忆的语言。
    subtitleCloseConfirmationTimer = setTimeout(() => {
      confirmSubtitleClosed(playbackKey);
    }, 500);
  }

  function applySubtitlePreference() {
    if (subtitleDefaultMode !== MODE_CLOSED) {
      cancelSubtitleCloseConfirmation();
      restoreChineseSubtitlePreference();
      return;
    }

    const playbackKey = getPlaybackKey();
    if (subtitleUserOverrideKey === playbackKey) {
      cancelSubtitleCloseConfirmation(playbackKey);
      return;
    }

    const { closeSwitch, renderedSubtitles } = getChineseSubtitleControls();
    if (!closeSwitch) return;

    const isClosed = closeSwitch.classList.contains('bpx-state-active');
    const renderedSignature = getRenderedSubtitleSignature(renderedSubtitles);
    const isRendered = renderedSignature !== '';
    refreshSubtitleCloseAttemptWindow(playbackKey, renderedSignature);
    if (!isClosed || isRendered) scheduleSubtitleCloseConfirmation(playbackKey);
    else cancelSubtitleCloseConfirmation(playbackKey);
  }

  function restoreChineseSubtitlePreference() {
    if (subtitleEnabled === null) return;

    const { chinese, closeSwitch } = getChineseSubtitleControls();
    if (!chinese || !closeSwitch || restoredSubtitleControls.has(closeSwitch)) return;

    // 每套播放器控件只恢复一次，之后尊重用户在原生菜单中的选择。
    restoredSubtitleControls.add(closeSwitch);

    const isClosed = closeSwitch.classList.contains('bpx-state-active');
    const isChineseActive = chinese.classList.contains('bpx-state-active');

    if (subtitleEnabled && (isClosed || !isChineseActive)) {
      chinese.click();
    } else if (!subtitleEnabled && !isClosed) {
      closeSwitch.click();
    }
  }

  function saveNativeSubtitleState() {
    const { closeSwitch } = getChineseSubtitleControls();
    if (!closeSwitch) return;

    subtitleEnabled = !closeSwitch.classList.contains('bpx-state-active');
    setStoredValue(KEY_SUBTITLE_ENABLED, subtitleEnabled);
    restoredSubtitleControls.add(closeSwitch);
  }

  function toggleChineseSubtitle() {
    const { chinese, closeSwitch } = getChineseSubtitleControls();

    if (!chinese || !closeSwitch) return;

    const isClosed = closeSwitch.classList.contains('bpx-state-active');
    const isChineseActive = chinese.classList.contains('bpx-state-active');
    subtitleEnabled = !(isChineseActive && !isClosed);
    setStoredValue(KEY_SUBTITLE_ENABLED, subtitleEnabled);
    restoredSubtitleControls.add(closeSwitch);
    subtitleUserOverrideKey = getPlaybackKey();

    if (subtitleEnabled) {
      chinese.click();
    } else {
      closeSwitch.click();
    }
  }

  function handleManualPlayerControlClick(event) {
    if (!event.isTrusted || handledManualControlEvents.has(event)) return;

    const subtitleControl = findControlInEvent(event,
      '.bpx-player-ctrl-subtitle-language-item, .bpx-player-ctrl-subtitle-close-switch'
    );
    const danmakuControl = danmakuDefaultMode === MODE_CLOSED
      ? findControlInEvent(event, '.bpx-player-dm-switch')
      : null;
    if (!subtitleControl && !danmakuControl) return;

    handledManualControlEvents.add(event);
    if (subtitleControl) {
      subtitleUserOverrideKey = getPlaybackKey();
      cancelSubtitleCloseConfirmation(subtitleUserOverrideKey);
      // B站在点击处理器中更新 active class，下一轮任务再读取最终状态。
      setTimeout(saveNativeSubtitleState, 0);
    }

    const input = danmakuControl?.querySelector('input[type="checkbox"]');
    if (!input) return;

    danmakuUserOverrideKey = getPlaybackKey();

    // 原生按钮从关闭状态开启后应停在“全部弹幕”，不保留“精简弹幕”。
    setTimeout(() => {
      skipSimplifiedDanmakuState(input);
    }, 0);
  }

  document.addEventListener('click', handleManualPlayerControlClick, true);

  // 修复因为 0 导致的 || 短路问题
  function getNumberFromStorage(key) {
    const val = getStoredValue(key);
    if (val === null || val === '') return null;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? null : parsed;
  }

  let headSec = getNumberFromStorage(KEY_HEAD);
  let tailSec = getNumberFromStorage(KEY_TAIL);
  let enabled = getStoredValue(KEY_ENABLED) === 'true';

  // 创建浮窗
  const infoDiv = document.createElement('div');
  Object.assign(infoDiv.style, {
    position: 'fixed', bottom: '80px', right: '20px',
    padding: '8px 12px', background: 'rgba(0,0,0,0.7)',
    color: '#fff', fontSize: '14px', borderRadius: '4px',
    zIndex: 999999, fontFamily: 'sans-serif',
    opacity: 0, pointerEvents: 'none', transition: 'opacity 0.5s'
  });

  let hideTimer = null;

  function getOverlayContainer() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement;
  }

  function ensureInfoDivMounted() {
    const targetContainer = getOverlayContainer();
    if (!targetContainer || infoDiv.parentNode === targetContainer) return;
    targetContainer.appendChild(infoDiv);
  }

  function showNotice(message) {
    ensureInfoDivMounted();
    infoDiv.textContent = message;
    infoDiv.style.opacity = '1';

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => infoDiv.style.opacity = '0', 3000);
  }

  function showInfo() {
    const head = headSec !== null ? formatTime(headSec) : '—';
    const tail = tailSec !== null ? formatTime(tailSec) : '—';
    const status = enabled ? '✅ 开启' : '❌ 关闭';

    showNotice(`片头: ${head}  片尾时长: ${tail}  状态: ${status}`);
  }

  function selectSetting(title, firstLabel, secondLabel, secondSelected) {
    const choice = prompt(
      `${title}\n\n1. ${firstLabel}\n2. ${secondLabel}\n\n请输入 1 或 2：`,
      secondSelected ? '2' : '1'
    );
    if (choice === null) return null;
    if (choice.trim() === '1') return false;
    if (choice.trim() === '2') return true;
    showNotice(`${title}：输入无效，设置未修改`);
    return null;
  }

  function configureStartupNotice() {
    const showOnVideoOpen = selectSetting(
      '启动提示', '仅在 O、Shift+M 等快捷键操作时显示', '打开视频即显示',
      startupNoticeMode === STARTUP_NOTICE_VIDEO
    );
    if (showOnVideoOpen === null) return;
    const nextMode = showOnVideoOpen ? STARTUP_NOTICE_VIDEO : STARTUP_NOTICE_SHORTCUTS;
    if (!writeSetting(KEY_STARTUP_NOTICE, nextMode)) return;
    startupNoticeMode = nextMode;
    showNotice(showOnVideoOpen ? '启动提示：打开视频即显示' : '启动提示：仅快捷键操作时显示');
  }

  function configureDanmakuDefault() {
    const closeByDefault = selectSetting(
      '弹幕默认状态', '不处理（保持 B 站状态）', '打开视频时默认关闭',
      danmakuDefaultMode === MODE_CLOSED
    );
    if (closeByDefault === null) return;
    const nextMode = closeByDefault ? MODE_CLOSED : MODE_UNCHANGED;
    if (!writeSetting(KEY_DANMAKU_DEFAULT, nextMode)) return;
    danmakuDefaultMode = nextMode;
    danmakuUserOverrideKey = null;
    startDefaultPreferenceRetries();
    showNotice(closeByDefault ? '弹幕：打开视频时默认关闭' : '弹幕：不处理');
  }

  function configureSubtitleDefault() {
    const closeByDefault = selectSetting(
      '字幕默认状态', '不处理（保持原有字幕记忆行为）', '打开视频时默认关闭',
      subtitleDefaultMode === MODE_CLOSED
    );
    if (closeByDefault === null) return;
    const nextMode = closeByDefault ? MODE_CLOSED : MODE_UNCHANGED;
    if (!writeSetting(KEY_SUBTITLE_DEFAULT, nextMode)) return;
    subtitleDefaultMode = nextMode;
    subtitleUserOverrideKey = null;
    restoredSubtitleControls = new WeakSet();
    cancelSubtitleCloseConfirmation();
    resetSubtitleCloseAttempts();
    startDefaultPreferenceRetries();
    showNotice(closeByDefault ? '字幕：打开视频时默认关闭' : '字幕：不处理');
  }

  function openSettings() {
    const choice = prompt(
      'B站播放器增强工具箱设置\n\n1. 启动提示\n2. 弹幕默认状态\n3. 字幕默认状态\n\n请输入 1、2 或 3：'
    );
    if (choice === null) return;
    const actions = {
      1: configureStartupNotice,
      2: configureDanmakuDefault,
      3: configureSubtitleDefault
    };
    const action = actions[choice.trim()];
    if (action) action();
    else showNotice('设置：输入无效，未作修改');
  }

  function formatTime(sec) {
    if (sec < 0) return '00:00';
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    return (h > 0 ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function parseTime(str) {
    if (!str || str.trim() === '') return null;
    const normalizedStr = str.replace(/：/g, ':').trim(); // 兼容中文全角冒号
    let sec = 0;
    if (normalizedStr.includes(':')) {
      const p = normalizedStr.split(':').map(Number).reverse();
      sec = (p[0] || 0) + (p[1] || 0) * 60 + (p[2] || 0) * 3600;
    } else {
      sec = parseFloat(normalizedStr);
    }
    return isNaN(sec) ? null : sec;
  }

  function clearTailSkipMarkers() {
    document.querySelectorAll('video[data-bili-skip-bound="true"]').forEach((video) => {
      video.dataset.biliSkipTail = '';
    });
    shadowHostObservers.forEach(({ host, root }) => {
      (root || host.shadowRoot)?.querySelectorAll('video[data-bili-skip-bound="true"]').forEach((video) => {
        video.dataset.biliSkipTail = '';
      });
    });
  }

  function setTimes() {
    let h = prompt('设置片头时间 (格式 mm:ss 或秒数，不跳请留空):', headSec !== null ? formatTime(headSec) : '');
    if (h === null) return;

    let t = prompt('设置片尾时长 (格式 mm:ss 或秒数，表示跳最后多少时间):', tailSec !== null ? formatTime(tailSec) : '');
    if (t === null) return;

    headSec = parseTime(h);
    tailSec = parseTime(t);

    if (headSec === null && tailSec === null) {
      enabled = false;
    } else {
      enabled = true;
    }

    setStoredValue(KEY_HEAD, headSec === null ? '' : headSec);
    setStoredValue(KEY_TAIL, tailSec === null ? '' : tailSec);
    setStoredValue(KEY_ENABLED, enabled);

    clearTailSkipMarkers();

    showInfo();
  }

  function closestCrossShadow(element, selector) {
    let current = element;
    while (current) {
      if (current instanceof Element) {
        const match = current.closest(selector);
        if (match) return match;
        const root = current.getRootNode();
        current = root instanceof ShadowRoot ? root.host : null;
      } else {
        current = null;
      }
    }
    return null;
  }

  function findControlInEvent(event, selector) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      const match = node.closest(selector);
      if (match) return match;
    }
    return event.target instanceof Element
      ? closestCrossShadow(event.target, selector)
      : null;
  }

  function handleVideoTimeUpdate(video) {
    if (!enabled) return;
    if (!video || video.tagName !== 'VIDEO') return;

    if (!closestCrossShadow(video, '.bpx-player-container, #bilibili-player, #bofqi')) return;

    if (isNaN(video.duration)) return;
    const currentTime = video.currentTime;
    const duration = video.duration;

    if (headSec !== null && currentTime < headSec) {
      video.currentTime = headSec;
    } else if (tailSec !== null && (duration - currentTime) <= tailSec) {
      if (!video.dataset.biliSkipTail) {
        video.currentTime = Math.max(video.currentTime, duration - 1);
        video.dataset.biliSkipTail = 'true';
      }
    } else {
      video.dataset.biliSkipTail = '';
    }
  }

  function bindVideo(video) {
    if (!video || video.dataset.biliSkipBound === 'true') return;
    video.dataset.biliSkipBound = 'true';
    video.addEventListener('timeupdate', () => handleVideoTimeUpdate(video));
  }

  function inspectElement(element) {
    if (element.tagName === 'VIDEO') {
      bindVideo(element);
    }
    observePlaylistRoot(element);
    if (element.shadowRoot) {
      observeShadowHost(element);
    }
  }

  function scanSubtree(root) {
    if (!root) return;
    if (root instanceof Element) {
      inspectElement(root);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      inspectElement(walker.currentNode);
    }
  }

  const shadowHostObservers = new Map();

  function observePlaylistRoot(element) {
    if (!element.matches(
      '.bpx-player-ctrl-eplist-section-bottom, .video-pod__body'
    ) || observedPlaylistRoots.has(element)) return;

    const observer = new MutationObserver((mutations) => {
      const currentItemChanged = mutations.some((mutation) => (
        mutation.type === 'attributes'
        && mutation.target instanceof Element
        && mutation.target.matches(
          '.bpx-player-ctrl-eplist-multi-menu-item, .simple-base-item.page-item'
        )
      ));
      if (!currentItemChanged) return;

      schedulePlayerEnhancementUpdate();
      startPlaylistPositionRetries();
    });
    observer.observe(element, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-current']
    });
    const cancelOnUserInteraction = (event) => {
      if (event.isTrusted) cancelPlaylistPositionRetries();
    };
    element.addEventListener('wheel', cancelOnUserInteraction, { passive: true });
    element.addEventListener('touchstart', cancelOnUserInteraction, { passive: true });
    element.addEventListener('pointerdown', cancelOnUserInteraction);
    observedPlaylistRoots.add(element);
  }

  function disconnectShadowHost(host) {
    const entry = shadowHostObservers.get(host);
    if (!entry) return;
    entry.observer.disconnect();
    entry.root.removeEventListener('click', handleManualPlayerControlClick, true);
    shadowHostObservers.delete(host);
  }

  function cleanupShadowHostObservers() {
    shadowHostObservers.forEach((_, host) => {
      if (!host.isConnected) {
        disconnectShadowHost(host);
      }
    });
  }

  function disconnectShadowHostsInSubtree(root) {
    if (!(root instanceof Element)) return;
    disconnectShadowHost(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      disconnectShadowHost(walker.currentNode);
    }
  }

  function scanAddedNodes(nodes) {
    const elements = [];
    nodes.forEach((node) => {
      if (node instanceof Element) {
        elements.push(node);
      }
    });
    const elementSet = new Set(elements);
    elements.forEach((element) => {
      let ancestor = element.parentElement;
      while (ancestor) {
        if (elementSet.has(ancestor)) return;
        ancestor = ancestor.parentElement;
      }
      scanSubtree(element);
    });
  }

  function observeShadowHost(host, root = host?.shadowRoot) {
    if (!host || !root || shadowHostObservers.has(host)) return;
    const observer = new MutationObserver((mutations) => {
      cleanupShadowHostObservers();
      const addedNodes = [];
      mutations.forEach((mutation) => {
        mutation.removedNodes?.forEach(disconnectShadowHostsInSubtree);
        mutation.addedNodes?.forEach((node) => addedNodes.push(node));
      });
      scanAddedNodes(addedNodes);
      if (addedNodes.some(mayContainPlayerEnhancement)) {
        schedulePlayerEnhancementUpdate();
        startPlaylistPositionRetries();
      }
      if (mutations.some(isDefaultPreferenceStateMutation)) {
        schedulePlayerEnhancementUpdate();
      }
      if (addedNodes.some(mayContainDefaultPreferenceControl)) {
        startDefaultPreferenceRetries();
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-checked', 'checked', 'class']
    });
    root.addEventListener('click', handleManualPlayerControlClick, true);
    shadowHostObservers.set(host, { observer, host, root });
    scanSubtree(root);
    if (root.querySelector(PLAYER_ENHANCEMENT_SELECTOR)) {
      schedulePlayerEnhancementUpdate();
      startPlaylistPositionRetries();
    }
    if (root.querySelector(DEFAULT_PREFERENCE_SELECTOR)) {
      startDefaultPreferenceRetries();
    }
  }

  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const shadowRoot = originalAttachShadow.call(this, init);
    observeShadowHost(this, shadowRoot);
    return shadowRoot;
  };

  const documentObserver = new MutationObserver((mutations) => {
    handlePlaybackNavigation();
    cleanupShadowHostObservers();
    const addedNodes = [];
    mutations.forEach((mutation) => {
      mutation.removedNodes?.forEach(disconnectShadowHostsInSubtree);
      mutation.addedNodes?.forEach((node) => addedNodes.push(node));
    });
    scanAddedNodes(addedNodes);
    if (addedNodes.some(mayContainPlayerEnhancement)) {
      schedulePlayerEnhancementUpdate();
      startPlaylistPositionRetries();
    }
    if (mutations.some(isDefaultPreferenceStateMutation)) {
      schedulePlayerEnhancementUpdate();
    }
    if (addedNodes.some(mayContainDefaultPreferenceControl)) {
      startDefaultPreferenceRetries();
    }
  });

  function handlePlaybackNavigation() {
    const playbackKey = getPlaybackKey();
    if (playbackKey === observedPlaybackKey) return;

    observedPlaybackKey = playbackKey;
    cancelSubtitleCloseConfirmation();
    const { renderedSubtitles } = getChineseSubtitleControls();
    resetSubtitleCloseAttempts(
      playbackKey, getRenderedSubtitleSignature(renderedSubtitles)
    );
    danmakuUserOverrideKey = null;
    subtitleUserOverrideKey = null;
    restoredSubtitleControls = new WeakSet();
    startDefaultPreferenceRetries();
    startPlaylistPositionRetries(true);
    if (startupNoticeMode === STARTUP_NOTICE_VIDEO) showInfo();
  }

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      handlePlaybackNavigation();
      return result;
    };
  }
  window.addEventListener('popstate', handlePlaybackNavigation);

  function startObservers() {
    scanSubtree(document);
    updatePlayerEnhancements();
    startDefaultPreferenceRetries();
    startPlaylistPositionRetries(true);
    if (document.documentElement) {
      documentObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-checked', 'checked', 'class']
      });
    }
  }

  window.addEventListener('load', positionPlaylistAtCurrentItem);
  window.addEventListener('pageshow', positionPlaylistAtCurrentItem);

  if (document.documentElement) {
    startObservers();
  } else {
    document.addEventListener('DOMContentLoaded', startObservers, { once: true });
  }

  function toggleDanmaku(control) {
    const input = control.querySelector('input[type="checkbox"]');
    input.click();
    // 新版原生循环为开启 → 精简 → 关闭；旧版两档开关无需额外点击。
    skipSimplifiedDanmakuState(input);
  }

  document.addEventListener('keydown', e => {
    // 穿透 B站 新版 Web Components(Shadow DOM) 获取真实的输入焦点
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
    if (e.isComposing) return;

    // 获取修饰键状态，防止误杀系统/浏览器级快捷键（比如 Ctrl+O 开文件、Cmd+M 窗口最小化）
    const hasModifier = e.ctrlKey || e.metaKey || e.altKey;

    if (e.code === 'KeyD' && !e.shiftKey && !hasModifier) {
      const control = findDanmakuSwitch();
      if (!control) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) {
        danmakuUserOverrideKey = getPlaybackKey();
        toggleDanmaku(control);
      }
      return;
    }
    if (e.repeat) return;

    if (e.key.toLowerCase() === 'm' && e.shiftKey && !hasModifier) {
      e.preventDefault();
      e.stopPropagation(); // 阻止事件冒泡，防止被 B站 内部的快捷键拦截器吞噬
      setTimes();
    }

    if (e.code === 'KeyO' && e.shiftKey && !hasModifier) {
      e.preventDefault();
      e.stopPropagation();
      openSettings();
      return;
    }

    // 只在纯按 'o' 时触发，如果是 Shift+O 等也排除掉
    if (e.key.toLowerCase() === 'o' && !e.shiftKey && !hasModifier) {
      e.preventDefault();
      e.stopPropagation();
      enabled = !enabled;
      setStoredValue(KEY_ENABLED, enabled);
      showInfo();
    }

    if (e.code === 'KeyC' && !e.shiftKey && !hasModifier) {
      e.preventDefault();
      e.stopPropagation();
      toggleChineseSubtitle();
    }
  }, true); // ★ 挂载在捕获阶段，第一时间拦截用户的按键动作

  if (startupNoticeMode === STARTUP_NOTICE_VIDEO) showInfo();
})();
