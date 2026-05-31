import { jest } from '@jest/globals';
import chrome from 'sinon-chrome/extensions';

globalThis.chrome = chrome;

// Simulate Firefox: chrome.debugger is Chromium-only. sinon-chrome ships a
// stub for it, so remove it before the background module loads.
chrome.debugger = undefined;

chrome.action = { enable: jest.fn(), disable: jest.fn(), setIcon: jest.fn() };
chrome.contextMenus = {
  ...(chrome.contextMenus || {}),
  onClicked: { addListener: jest.fn() },
};
chrome.notifications = {
  ...(chrome.notifications || {}),
  onClicked: { addListener: jest.fn() },
  create: jest.fn(),
  clear: jest.fn(),
};
chrome.storage = {
  ...(chrome.storage || {}),
  onChanged: { addListener: jest.fn() },
  local: {
    get: jest.fn((_keys, cb) => cb && cb({})),
    set: jest.fn((_items, cb) => cb && cb()),
    remove: jest.fn(),
  },
  sync: {
    get: jest.fn((_keys, cb) => cb && cb({})),
    set: jest.fn((_items, cb) => cb && cb()),
    remove: jest.fn(),
  },
};

const bg = await import('../../../src/background/index.js');
const store = bg.store;

function makePort(name, sender) {
  return {
    name,
    sender: sender ?? { tab: { id: 100 }, frameId: 0 },
    onMessage: {
      _listeners: [],
      addListener(fn) {
        this._listeners.push(fn);
      },
      removeListener(fn) {
        this._listeners = this._listeners.filter((l) => l !== fn);
      },
      trigger(msg) {
        for (const l of this._listeners) l(msg);
      },
    },
    onDisconnect: {
      _listeners: [],
      addListener(fn) {
        this._listeners.push(fn);
      },
      removeListener(fn) {
        this._listeners = this._listeners.filter((l) => l !== fn);
      },
      trigger() {
        for (const l of this._listeners) l();
      },
    },
    postMessage: jest.fn(),
    disconnect: jest.fn(),
  };
}

function relayInit(tabPort, instanceId) {
  tabPort.onMessage.trigger({ name: 'INIT_INSTANCE', instanceId });
  tabPort.onMessage.trigger({
    name: 'RELAY',
    message: {
      type: 'INIT',
      payload: JSON.stringify({ value: instanceId }),
      instanceId,
      source: '@devtools-page',
      libConfig: { name: `store-${instanceId}`, serialize: false, features: {} },
    },
  });
}

describe('asyncStack PREPARE must not corrupt the instances store', () => {
  afterAll(() => {
    chrome.flush();
    delete globalThis.chrome;
  });

  it('keeps `current` on a real instance and leaves no stateless phantom', () => {
    const tabPort = makePort('tab', { tab: { id: 100 }, frameId: 0 });
    chrome.runtime.onConnect.dispatch(tabPort);

    // Two stores connect via the raw API connect()+init() (the user's case).
    relayInit(tabPort, 1);
    relayInit(tabPort, 2);

    const afterInit = store.getState().instances;
    expect(afterInit.current).toBe('100/2');
    expect(afterInit.states['100/2']).toBeDefined();

    // The page calls window.asyncStack(); the content script forwards
    // { type: 'ASYNC_STACK_PREPARE' } over chrome.runtime.sendMessage. The
    // background's apiMiddleware `messaging` listener also receives it.
    const sendResponse = jest.fn();
    chrome.runtime.onMessage.dispatch(
      { type: 'ASYNC_STACK_PREPARE' },
      { tab: { id: 100 }, frameId: 0 },
      sendResponse,
    );

    // chrome.debugger is undefined under sinon-chrome (as in Firefox), so the
    // asyncStack handler reports the feature unsupported rather than throwing.
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ASYNC_STACK_ERROR', unsupported: true }),
    );

    const afterPrepare = store.getState().instances;
    // BUG: messaging treats it as an UPDATE_STATE and points `current` at a
    // phantom instance keyed by the bare tab id, with NO entry in `states`.
    expect(afterPrepare.current).toBe('100/2');
    expect(afterPrepare.states[100]).toBeUndefined();
    expect(afterPrepare.options[100]).toBeUndefined();

    // Reopening the panel re-sends the cached state for `current`; if
    // `current` is the stateless phantom this throws while destructuring
    // `states[current]`, so the panel never receives any state.
    const panelPort = makePort('monitor', { id: 'ext-id' });
    expect(() => chrome.runtime.onConnect.dispatch(panelPort)).not.toThrow();
    const stateCalls = panelPort.postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m && m.request && m.request.type === 'STATE');
    expect(stateCalls.length).toBeGreaterThan(0);
  });
});
