const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
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

function createElement({ visible = true, position = 'relative', text = '', rect } = {}) {
  let ownTextContent = text;
  const element = {
    parentNode: null,
    parentElement: null,
    style: {},
    descendants: [],
    children: [],
    isConnected: true,
    getClientRects: () => visible ? [{}] : [],
    getBoundingClientRect: () => rect || ({ top: 0, bottom: 400, width: 100, height: 40 }),
    querySelectorAll() {
      const nested = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
      return [...new Set([...this.descendants, ...nested])];
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    contains(candidate) {
      return candidate === this || this.children.some((child) => child.contains(candidate));
    },
    setAttribute(name, value) { this[name] = value; },
    removeChild(child) {
      this.children = this.children.filter((candidate) => candidate !== child);
      this.descendants = this.descendants.filter((candidate) => candidate !== child);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    },
    computedPosition: position,
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      child.parentElement = this;
      this.children.push(child);
      if (!this.descendants.includes(child)) this.descendants.push(child);
      return child;
    }
  };
  Object.defineProperty(element, 'textContent', {
    get() {
      return ownTextContent + this.children.map((child) => child.textContent).join('');
    },
    set(value) {
      ownTextContent = value;
    }
  });
  return element;
}

function setup({ selectors = {}, fullscreenElement = null } = {}) {
  const infoDiv = createElement();
  const nativeNoticeRow = createElement();
  const nativeNoticeItem = createElement();
  nativeNoticeItem.appendChild(infoDiv);
  nativeNoticeRow.appendChild(nativeNoticeItem);
  const fallback = createElement();
  const timers = [];
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() { this.disconnected = true; }
    trigger() { this.callback([]); }
  }
  const context = {
    document: {
      fullscreenElement,
      webkitFullscreenElement: null,
      body: fallback,
      documentElement: createElement()
    },
    window: {
      getComputedStyle: (element) => ({
        position: element.computedPosition,
        visibility: element.style.visibility || 'visible',
        display: element.style.display || 'block',
        opacity: element.style.opacity ?? '1'
      })
    },
    MutationObserver: FakeMutationObserver,
    infoDiv,
    nativeNoticeRow,
    nativeNoticeItem,
    hideTimer: null,
    nativeNoticeObserver: null,
    nativeNoticeStopTimer: null,
    nativeNoticeVisibilityTimer: null,
    initialPlayerStateNoticeVisible: false,
    queryPlayerElements: (selector) => selectors[selector] || [],
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout(timer) { timers[timer - 1].cancelled = true; }
  };
  vm.runInNewContext(`
    ${extractFunction('getOverlayContainer')}
    ${extractFunction('findNoticeContainer')}
    ${extractFunction('isHiddenNoticeElement')}
    ${extractFunction('findNativeNoticeList')}
    ${extractFunction('hasMatchingNativeNotice')}
    ${extractFunction('isPlayerStateNotice')}
    ${extractFunction('getUncoveredPlayerStateNotice')}
    ${extractFunction('positionNoticeAboveNativeNotices')}
    ${extractFunction('showInitialPlayerStateNotice')}
    ${extractFunction('mountInNativeNoticeList')}
    ${extractFunction('removeNoticeElement')}
    ${extractFunction('scheduleNoticeRemoval')}
    ${extractFunction('ensureInfoDivMounted')}
    ${extractFunction('stopWatchingForNativeNotice')}
    ${extractFunction('hideNoticeIfNativeAppears')}
    ${extractFunction('watchForNativeNotice')}
    ${extractFunction('showNotice')}
    this.api = {
      findNoticeContainer, hasMatchingNativeNotice, ensureInfoDivMounted,
      showInitialPlayerStateNotice, showNotice
    };
  `, context);
  return { ...context, fallback, timers, observers };
}

test('notice mounts in the visible video area at the native toast position', () => {
  const staleArea = createElement({ visible: false });
  const videoArea = createElement();
  const playerContainer = createElement();
  const context = setup({
    selectors: {
      '.bpx-player-video-area': [staleArea, videoArea],
      '.bpx-player-container': [playerContainer]
    }
  });

  context.api.showNotice('弹幕已开启');

  assert.equal(context.infoDiv.parentNode, videoArea);
  assert.equal(context.infoDiv.style.position, 'absolute');
  assert.equal(context.infoDiv.style.left, '10px');
  assert.equal(context.infoDiv.style.bottom, '60px');
  assert.equal(context.infoDiv.style.right, 'auto');
  assert.equal(context.infoDiv.style.opacity, '1');
  assert.equal(context.timers[0].delay, 3000);
  context.timers[0].callback();
  assert.equal(context.infoDiv.style.opacity, '0');
});

test('notice container fallbacks cover fullscreen, web fullscreen, and widescreen players', () => {
  for (const selector of [
    '.bpx-player-video-area',
    '.bpx-player-container',
    '#bilibili-player'
  ]) {
    const container = createElement();
    const context = setup({ selectors: { [selector]: [container] } });
    context.api.showNotice('播放器状态');
    assert.equal(context.infoDiv.parentNode, container, selector);
  }
});

test('notice mounting does not change a static player container position', () => {
  const videoArea = createElement({ position: 'static' });
  const playerContainer = createElement({ position: 'relative' });
  const context = setup({
    selectors: {
      '.bpx-player-video-area': [videoArea],
      '.bpx-player-container': [playerContainer]
    }
  });

  context.api.showNotice('播放器状态');

  assert.equal(context.infoDiv.parentNode, playerContainer);
  assert.equal(videoArea.style.position, undefined);
  assert.equal(playerContainer.style.position, undefined);
});

test('notice remounts after an SPA player rebuild', () => {
  const firstArea = createElement();
  const secondArea = createElement();
  const selectors = { '.bpx-player-video-area': [firstArea] };
  const context = setup({ selectors });

  context.api.showNotice('第一次');
  assert.equal(context.infoDiv.parentNode, firstArea);

  firstArea.getClientRects = () => [];
  selectors['.bpx-player-video-area'] = [firstArea, secondArea];
  context.api.showNotice('第二次');
  assert.equal(context.infoDiv.parentNode, secondArea);
});

test('notice falls back to the original fixed window position without a player', () => {
  const fullscreenElement = createElement();
  const context = setup({ fullscreenElement });

  context.api.showNotice('设置已保存');

  assert.equal(context.infoDiv.parentNode, fullscreenElement);
  assert.equal(context.infoDiv.style.position, 'fixed');
  assert.equal(context.infoDiv.style.right, '20px');
  assert.equal(context.infoDiv.style.bottom, '80px');
});

test('notice is an independent item beside three native toasts and is removed after fading', () => {
  const videoArea = createElement();
  const nativeToastList = createElement();
  const nativeToastWrap = createElement();
  nativeToastWrap.appendChild(nativeToastList);
  const nativeRows = ['字幕已关闭', '已为您定位至 00:12 从头播放', '已静音开播']
    .map((text) => createElement({ text }));
  nativeRows.forEach((row) => nativeToastList.appendChild(row));
  const context = setup({
    selectors: {
      '.bpx-player-video-area': [videoArea],
      '.bpx-player-toast-wrap': [nativeToastWrap],
      '.bpx-player-toast-auto': [nativeToastList]
    }
  });

  context.api.showNotice('设置已保存');

  assert.deepEqual(nativeToastList.children.slice(0, 3), nativeRows);
  assert.equal(nativeToastList.children[3], context.nativeNoticeRow);
  assert.equal(context.nativeNoticeRow.parentNode, nativeToastList);
  assert.equal(context.infoDiv.parentNode, context.nativeNoticeItem);

  context.timers[0].callback();
  assert.equal(context.nativeNoticeRow.style.opacity, '0');
  assert.equal(context.timers[1].delay, 500);
  context.timers[1].callback();
  assert.equal(context.nativeNoticeRow.parentNode, null);
  assert.deepEqual(nativeToastList.children, nativeRows);
});

test('script-owned native row is not mistaken for a matching native toast', () => {
  const videoArea = createElement();
  const nativeToastList = createElement();
  const nativeToastWrap = createElement();
  nativeToastWrap.appendChild(nativeToastList);
  const context = setup({
    selectors: {
      '.bpx-player-video-area': [videoArea],
      '.bpx-player-toast-wrap': [nativeToastWrap],
      '.bpx-player-toast-auto': [nativeToastList]
    }
  });

  context.api.showNotice('弹幕已关闭');
  assert.equal(context.api.hasMatchingNativeNotice('弹幕已关闭'), false);
  context.observers[0].trigger();
  assert.equal(context.infoDiv.style.opacity, '1');
  assert.equal(context.nativeNoticeRow.parentNode, nativeToastList);
});

test('fallback stays above the highest native toast and follows stack mutations', () => {
  const videoArea = createElement({ rect: { top: 100, bottom: 500, width: 700, height: 400 } });
  const nativeToastWrap = createElement();
  nativeToastWrap.descendants.push(
    createElement({ text: '字幕已关闭', rect: { top: 400, bottom: 440 } }),
    createElement({ text: '已为您定位至 00:12 从头播放', rect: { top: 350, bottom: 390 } }),
    createElement({ text: '已静音开播', rect: { top: 300, bottom: 340 } })
  );
  const context = setup({
    selectors: {
      '.bpx-player-video-area': [videoArea],
      '.bpx-player-toast-wrap': [nativeToastWrap]
    }
  });

  context.api.showNotice('设置已保存');
  assert.equal(context.infoDiv.style.bottom, '208px');

  nativeToastWrap.descendants.push(
    createElement({ text: '新增原生提示', rect: { top: 250, bottom: 290 } })
  );
  context.observers[0].trigger();
  assert.equal(context.infoDiv.style.bottom, '258px');
});

test('matching native subtitle or danmaku toast suppresses the script notice', () => {
  const videoArea = createElement();
  const nativeToastItem = createElement({ text: '字幕 已关闭' });
  const nativeToast = createElement();
  nativeToast.descendants.push(nativeToastItem);
  const context = setup({
    selectors: {
      '.bpx-player-video-area': [videoArea],
      '.bpx-player-toast-wrap': [nativeToast]
    }
  });

  context.infoDiv.style.opacity = '1';
  context.api.showNotice('字幕已关闭');

  assert.equal(context.infoDiv.parentNode, context.nativeNoticeItem);
  assert.equal(context.nativeNoticeRow.parentNode, null);
  assert.equal(context.infoDiv.style.opacity, '0');
  assert.equal(context.timers.length, 0);
  assert.equal(context.api.hasMatchingNativeNotice('弹幕已关闭'), false);
  assert.equal(context.api.hasMatchingNativeNotice('字幕已开启'), false);
});

test('native toast rows do not combine subjects and states across items', () => {
  const nativeToastWrap = createElement();
  const nativeToastList = createElement();
  const subtitleRow = createElement({ text: '字幕已关闭' });
  const danmakuRow = createElement({ text: '弹幕已开启' });
  nativeToastList.appendChild(subtitleRow);
  nativeToastList.appendChild(danmakuRow);
  nativeToastWrap.appendChild(nativeToastList);
  const context = setup({
    selectors: { '.bpx-player-toast-wrap': [nativeToastWrap] }
  });

  assert.equal(nativeToastList.textContent, '字幕已关闭弹幕已开启');
  assert.equal(context.api.hasMatchingNativeNotice('字幕已开启'), false);
  assert.equal(context.api.hasMatchingNativeNotice('弹幕已关闭'), false);
  assert.equal(context.api.hasMatchingNativeNotice('字幕已关闭'), true);
  assert.equal(context.api.hasMatchingNativeNotice('弹幕已开启'), true);
});

test('script notice is removed when the matching native toast appears later', () => {
  const videoArea = createElement();
  const selectors = {
    '.bpx-player-video-area': [videoArea],
    '.bpx-player-toast-wrap': []
  };
  const context = setup({ selectors });

  context.api.showNotice('弹幕已关闭');
  assert.equal(context.infoDiv.style.opacity, '1');

  const nativeToastItem = createElement({ text: '弹幕 已关闭' });
  const nativeToast = createElement();
  nativeToast.descendants.push(nativeToastItem);
  selectors['.bpx-player-toast-wrap'] = [nativeToast];
  context.observers[0].trigger();

  assert.equal(context.infoDiv.style.opacity, '0');
  assert.equal(context.timers[0].cancelled, true, 'the normal fade timer is cleared');
  assert.equal(context.observers[0].disconnected, false, 'the observer stays active during the fade');
  assert.equal(context.timers[2].delay, 500);
  context.timers[2].callback();
  assert.equal(context.observers[0].disconnected, true);
});

test('native subtitle toast does not shorten the initial danmaku notice', () => {
  const videoArea = createElement();
  const selectors = {
    '.bpx-player-video-area': [videoArea],
    '.bpx-player-toast-wrap': []
  };
  const context = setup({ selectors });

  context.api.showNotice('弹幕已关闭');

  const nativeToastItem = createElement({
    text: '字幕 已关闭', rect: { top: 300, bottom: 340 }
  });
  const nativeToast = createElement();
  nativeToast.descendants.push(nativeToastItem);
  selectors['.bpx-player-toast-wrap'] = [nativeToast];
  context.observers[0].trigger();

  assert.equal(context.infoDiv.textContent, '弹幕已关闭');
  assert.equal(context.infoDiv.style.opacity, '1');
  assert.equal(context.infoDiv.style.bottom, '108px');
  assert.equal(context.timers[0].cancelled, undefined, 'the three-second timer is preserved');

  context.timers[0].callback();
  assert.equal(context.infoDiv.style.opacity, '0');
});

test('combined player state notice only yields the matching item to a native toast', () => {
  const videoArea = createElement();
  const selectors = {
    '.bpx-player-video-area': [videoArea],
    '.bpx-player-toast-wrap': []
  };
  const context = setup({ selectors });

  context.api.showInitialPlayerStateNotice(['弹幕已关闭']);
  context.api.showInitialPlayerStateNotice(['字幕已关闭']);
  assert.equal(context.timers[0].cancelled, true, 'combining restarts the three-second timer');
  assert.equal(context.timers[2].delay, 3000);
  assert.equal(context.infoDiv.textContent, '弹幕已关闭 · 字幕已关闭');
  assert.equal(context.infoDiv.style.opacity, '1');

  const nativeToastItem = createElement({
    text: '字幕 已关闭', rect: { top: 300, bottom: 340 }
  });
  const nativeToast = createElement();
  nativeToast.descendants.push(nativeToastItem);
  selectors['.bpx-player-toast-wrap'] = [nativeToast];
  context.observers[1].trigger();

  assert.equal(context.infoDiv.textContent, '弹幕已关闭');
  assert.equal(context.infoDiv.style.opacity, '1');
  assert.equal(context.infoDiv.style.bottom, '108px');
  assert.equal(context.timers[2].cancelled, undefined, 'the restarted timer is preserved');

  nativeToastItem.style.opacity = '0';
  context.timers[3].callback();
  assert.equal(context.infoDiv.textContent, '弹幕已关闭', 'the covered item is not shown again');
  assert.equal(context.infoDiv.style.bottom, '60px');
});

test('native toast during the final fade removes the script notice', () => {
  const videoArea = createElement();
  const selectors = {
    '.bpx-player-video-area': [videoArea],
    '.bpx-player-toast-wrap': []
  };
  const context = setup({ selectors });

  context.api.showNotice('弹幕已关闭');
  context.timers[0].callback();
  assert.equal(context.infoDiv.style.opacity, '0');
  assert.equal(context.timers[2].delay, 500);
  assert.equal(context.observers[0].disconnected, false);

  const nativeToastItem = createElement({ text: '弹幕 已关闭' });
  const nativeToast = createElement();
  nativeToast.descendants.push(nativeToastItem);
  selectors['.bpx-player-toast-wrap'] = [nativeToast];
  context.observers[0].trigger();

  assert.equal(context.timers[2].cancelled, true);
  assert.equal(context.observers[0].disconnected, false);
  assert.equal(context.timers[3].delay, 500);
  context.timers[3].callback();
  assert.equal(context.observers[0].disconnected, true);
});

test('native toast becoming visible without a DOM mutation removes the script notice', () => {
  const videoArea = createElement();
  const nativeToastItem = createElement({ text: '字幕 已关闭' });
  nativeToastItem.style.opacity = '0';
  const nativeToast = createElement();
  nativeToast.descendants.push(nativeToastItem);
  const context = setup({
    selectors: {
      '.bpx-player-video-area': [videoArea],
      '.bpx-player-toast-wrap': [nativeToast]
    }
  });

  context.api.showNotice('字幕已关闭');
  assert.equal(context.infoDiv.style.opacity, '1');
  assert.equal(context.timers[1].delay, 100);

  nativeToastItem.style.opacity = '1';
  context.timers[1].callback();

  assert.equal(context.infoDiv.style.opacity, '0');
  assert.equal(context.timers[0].cancelled, true);
  assert.equal(context.observers[0].disconnected, false);
  assert.equal(context.timers[2].delay, 500);
  context.timers[2].callback();
  assert.equal(context.observers[0].disconnected, true);
});

test('native subtitle language-switch toast counts as an enabled notice', () => {
  const nativeToastItem = createElement({ text: '字幕已切换至 中文' });
  const nativeToast = createElement();
  nativeToast.descendants.push(nativeToastItem);
  const context = setup({
    selectors: { '.bpx-player-toast-wrap': [nativeToast] }
  });

  assert.equal(context.api.hasMatchingNativeNotice('字幕已开启'), true);
});

test('hidden stale native toast does not suppress a new script notice', () => {
  const videoArea = createElement();
  const nativeToastItem = createElement({ text: '字幕 已关闭' });
  nativeToastItem.style.opacity = '0';
  const nativeToast = createElement();
  nativeToast.descendants.push(nativeToastItem);
  const context = setup({
    selectors: {
      '.bpx-player-video-area': [videoArea],
      '.bpx-player-toast-wrap': [nativeToast]
    }
  });

  context.api.showNotice('字幕已关闭');

  assert.equal(context.infoDiv.parentNode, videoArea);
  assert.equal(context.infoDiv.style.opacity, '1');
});

test('native toast inside a transparent parent does not suppress a script notice', () => {
  const videoArea = createElement();
  const nativeToastItem = createElement({ text: '字幕 已关闭' });
  const nativeToast = createElement();
  nativeToast.style.opacity = '0';
  nativeToast.descendants.push(nativeToastItem);
  nativeToastItem.parentNode = nativeToast;
  const context = setup({
    selectors: {
      '.bpx-player-video-area': [videoArea],
      '.bpx-player-toast-wrap': [nativeToast]
    }
  });

  context.api.showNotice('字幕已关闭');

  assert.equal(nativeToastItem.getClientRects().length, 1);
  assert.equal(context.infoDiv.parentNode, videoArea);
  assert.equal(context.infoDiv.style.opacity, '1');
});
