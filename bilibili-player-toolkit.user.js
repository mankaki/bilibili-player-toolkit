// ==UserScript==
// @name         B站播放器增强工具箱
// @namespace    https://www.bilibili.com/
// @version      3.1.0
// @description  自动跳片头片尾、选集显示 P 序号、C 键切换中文字幕，并优先使用新版画中画
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

  const KEY_HEAD = 'bili_skip_head';
  const KEY_TAIL = 'bili_skip_tail';
  const KEY_ENABLED = 'bili_skip_enabled';
  const KEY_SUBTITLE_ENABLED = 'bili_chinese_subtitle_enabled';
  const storedSubtitlePreference = localStorage.getItem(KEY_SUBTITLE_ENABLED);
  let subtitleEnabled = storedSubtitlePreference === null
    ? null
    : storedSubtitlePreference === 'true';
  const restoredSubtitleControls = new WeakSet();
  const PLAYER_ENHANCEMENT_SELECTOR = [
    '.bpx-player-ctrl-subtitle',
    '.bpx-player-ctrl-subtitle-title',
    '.bpx-player-ctrl-subtitle-language-item',
    '.bpx-player-ctrl-subtitle-close-switch',
    '.bpx-player-ctrl-pip-menu-item'
  ].join(', ');
  let enhancementUpdateFrame = null;

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
    document.querySelectorAll('.bpx-player-ctrl-subtitle').forEach((button) => {
      if (button.getAttribute('aria-label') !== '字幕 (c)') {
        button.setAttribute('aria-label', '字幕 (c)');
      }
    });

    document.querySelectorAll('.bpx-player-ctrl-subtitle-title').forEach((title) => {
      if (title.textContent !== '字幕 (c)') {
        title.textContent = '字幕 (c)';
      }
    });
  }

  function preferSubtitlePictureInPicture() {
    const items = Array.from(document.querySelectorAll('.bpx-player-ctrl-pip-menu-item'));
    const modernMode = items.find((item) => /新版画中画/.test(item.textContent || ''));

    if (modernMode && !modernMode.classList.contains('bpx-state-active')) {
      modernMode.click();
    }
  }

  function updatePlayerEnhancements() {
    updateNativeSubtitleTip();
    preferSubtitlePictureInPicture();
    restoreChineseSubtitlePreference();
  }

  function mayContainPlayerEnhancement(node) {
    return node instanceof Element && (
      node.matches(PLAYER_ENHANCEMENT_SELECTOR) ||
      node.querySelector(PLAYER_ENHANCEMENT_SELECTOR)
    );
  }

  function schedulePlayerEnhancementUpdate() {
    if (enhancementUpdateFrame !== null) return;

    enhancementUpdateFrame = requestAnimationFrame(() => {
      enhancementUpdateFrame = null;
      updatePlayerEnhancements();
    });
  }

  function getChineseSubtitleControls() {
    const items = Array.from(document.querySelectorAll('.bpx-player-ctrl-subtitle-language-item'));
    const chinese = items.find((item) => {
      const language = item.getAttribute('data-lan') || '';
      const text = item.textContent || '';
      return /(^|[-_*])zh([-_*]|$)/i.test(language) || /中文|简体|繁体/.test(text);
    });
    const closeSwitch = document.querySelector('.bpx-player-ctrl-subtitle-close-switch');

    return { chinese, closeSwitch };
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
    localStorage.setItem(KEY_SUBTITLE_ENABLED, subtitleEnabled);
    restoredSubtitleControls.add(closeSwitch);
  }

  function toggleChineseSubtitle() {
    const { chinese, closeSwitch } = getChineseSubtitleControls();

    if (!chinese || !closeSwitch) return;

    const isClosed = closeSwitch.classList.contains('bpx-state-active');
    const isChineseActive = chinese.classList.contains('bpx-state-active');
    subtitleEnabled = !(isChineseActive && !isClosed);
    localStorage.setItem(KEY_SUBTITLE_ENABLED, subtitleEnabled);
    restoredSubtitleControls.add(closeSwitch);

    if (subtitleEnabled) {
      chinese.click();
    } else {
      closeSwitch.click();
    }
  }

  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;

    const subtitleControl = event.target.closest(
      '.bpx-player-ctrl-subtitle-language-item, .bpx-player-ctrl-subtitle-close-switch'
    );
    if (!subtitleControl) return;

    // B站在点击处理器中更新 active class，下一轮任务再读取最终状态。
    setTimeout(saveNativeSubtitleState, 0);
  }, true);

  // 修复因为 0 导致的 || 短路问题
  function getNumberFromStorage(key) {
    const val = localStorage.getItem(key);
    if (val === null || val === '') return null;
    const parsed = parseFloat(val);
    return isNaN(parsed) ? null : parsed;
  }

  let headSec = getNumberFromStorage(KEY_HEAD);
  let tailSec = getNumberFromStorage(KEY_TAIL);
  let enabled = localStorage.getItem(KEY_ENABLED) === 'true';

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

  function showInfo() {
    const head = headSec !== null ? formatTime(headSec) : '—';
    const tail = tailSec !== null ? formatTime(tailSec) : '—';
    const status = enabled ? '✅ 开启' : '❌ 关闭';

    ensureInfoDivMounted();

    infoDiv.textContent = `片头: ${head}  片尾时长: ${tail}  状态: ${status}`;
    infoDiv.style.opacity = '1';

    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => infoDiv.style.opacity = '0', 3000);
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
    shadowHostObservers.forEach((entry) => {
      entry.host.shadowRoot?.querySelectorAll('video[data-bili-skip-bound="true"]').forEach((video) => {
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

    localStorage.setItem(KEY_HEAD, headSec === null ? '' : headSec);
    localStorage.setItem(KEY_TAIL, tailSec === null ? '' : tailSec);
    localStorage.setItem(KEY_ENABLED, enabled);

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

  function disconnectShadowHost(host) {
    const entry = shadowHostObservers.get(host);
    if (!entry) return;
    entry.observer.disconnect();
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

  function observeShadowHost(host) {
    if (!host || !host.shadowRoot || shadowHostObservers.has(host)) return;
    const observer = new MutationObserver((mutations) => {
      cleanupShadowHostObservers();
      const addedNodes = [];
      mutations.forEach((mutation) => {
        mutation.removedNodes.forEach(disconnectShadowHostsInSubtree);
        mutation.addedNodes.forEach((node) => addedNodes.push(node));
      });
      scanAddedNodes(addedNodes);
    });
    observer.observe(host.shadowRoot, { childList: true, subtree: true });
    shadowHostObservers.set(host, { observer, host });
    scanSubtree(host.shadowRoot);
  }

  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const shadowRoot = originalAttachShadow.call(this, init);
    observeShadowHost(this);
    return shadowRoot;
  };

  const documentObserver = new MutationObserver((mutations) => {
    cleanupShadowHostObservers();
    const addedNodes = [];
    mutations.forEach((mutation) => {
      mutation.removedNodes.forEach(disconnectShadowHostsInSubtree);
      mutation.addedNodes.forEach((node) => addedNodes.push(node));
    });
    scanAddedNodes(addedNodes);
    if (addedNodes.some(mayContainPlayerEnhancement)) {
      schedulePlayerEnhancementUpdate();
    }
  });

  function startObservers() {
    scanSubtree(document);
    updatePlayerEnhancements();
    if (document.documentElement) {
      documentObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.documentElement) {
    startObservers();
  } else {
    document.addEventListener('DOMContentLoaded', startObservers, { once: true });
  }

  document.addEventListener('keydown', e => {
    // 穿透 B站 新版 Web Components(Shadow DOM) 获取真实的输入焦点
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
    if (e.repeat) return;

    // 获取修饰键状态，防止误杀系统/浏览器级快捷键（比如 Ctrl+O 开文件、Cmd+M 窗口最小化）
    const hasModifier = e.ctrlKey || e.metaKey || e.altKey;

    if (e.key.toLowerCase() === 'm' && e.shiftKey && !hasModifier) {
      e.preventDefault();
      e.stopPropagation(); // 阻止事件冒泡，防止被 B站 内部的快捷键拦截器吞噬
      setTimes();
    }

    // 只在纯按 'o' 时触发，如果是 Shift+O 等也排除掉
    if (e.key.toLowerCase() === 'o' && !e.shiftKey && !hasModifier) {
      e.preventDefault();
      e.stopPropagation();
      enabled = !enabled;
      localStorage.setItem(KEY_ENABLED, enabled);
      showInfo();
    }

    if (e.code === 'KeyC' && !e.shiftKey && !hasModifier) {
      e.preventDefault();
      e.stopPropagation();
      toggleChineseSubtitle();
    }
  }, true); // ★ 挂载在捕获阶段，第一时间拦截用户的按键动作

  showInfo();
})();
