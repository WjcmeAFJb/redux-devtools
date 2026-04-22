import { jest } from '@jest/globals';

// Background must see a sinon-chrome mock instead of the sinon-chrome
// that the global test setup wires up, because we need to dispatch
// onConnect/onMessage events manually.
import chrome from 'sinon-chrome/extensions';

globalThis.chrome = chrome;

// sinon-chrome targets an older schema and doesn't ship `chrome.action`
// (MV3) or `chrome.contextMenus.onClicked`; mock them minimally so the
// background service worker can load.
chrome.action = {
  enable: jest.fn(),
  disable: jest.fn(),
  setIcon: jest.fn(),
};
chrome.contextMenus = {
  ...(chrome.contextMenus || {}),
  onClicked: {
    addListener: jest.fn(),
  },
};
chrome.notifications = {
  ...(chrome.notifications || {}),
  onClicked: {
    addListener: jest.fn(),
  },
  create: jest.fn(),
  clear: jest.fn(),
};
chrome.storage = {
  ...(chrome.storage || {}),
  onChanged: {
    addListener: jest.fn(),
  },
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

// Import for side effects: creates the store and registers
// chrome.runtime.onConnect/onMessage listeners.
await import('../../../src/background/index.js');

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

describe('background apiMiddleware', () => {
  afterAll(() => {
    chrome.flush();
    delete globalThis.chrome;
  });

  it('forwards libConfig.serialize to a panel that opens after the tab has sent INIT', () => {
    // 1. Tab connects (content script opens port `name: 'tab'`)
    const tabPort = makePort('tab', { tab: { id: 100 }, frameId: 0 });
    chrome.runtime.onConnect.dispatch(tabPort);

    // 2. Content script sends INIT_INSTANCE (no libConfig)
    tabPort.onMessage.trigger({
      name: 'INIT_INSTANCE',
      instanceId: 1,
    });

    // 3. Content script relays the tab's INIT message, which DOES carry
    //    libConfig with serialize: true (this is what the raw API's init()
    //    helper emits in pageScript/api/index.ts).
    tabPort.onMessage.trigger({
      name: 'RELAY',
      message: {
        type: 'INIT',
        payload: JSON.stringify({
          value: { data: { iso: '2024-01-01' }, __serializedType__: 'Date' },
        }),
        instanceId: 1,
        source: '@devtools-page',
        libConfig: {
          actionCreators: JSON.stringify([]),
          name: 'raw-api-test',
          features: {
            lock: true,
            export: true,
            import: true,
            persist: true,
            pause: true,
            reorder: true,
            jump: true,
            skip: true,
            dispatch: true,
            sync: true,
            test: true,
          },
          serialize: true,
          type: undefined,
        },
      },
    });

    // 4. Panel opens later — content script opens a second port named `monitor-*`.
    const panelPort = makePort('monitor-1', { id: 'chrome-extension-id' });
    chrome.runtime.onConnect.dispatch(panelPort);

    // 5. Assert that the cached-state STATE message the background
    //    sent to the fresh panel carries a libConfig with serialize: true.
    const stateCalls = panelPort.postMessage.mock.calls
      .map((c) => c[0])
      .filter((msg) => msg && msg.request && msg.request.type === 'STATE');
    expect(stateCalls.length).toBeGreaterThan(0);
    const stateMsg = stateCalls[0];
    expect(stateMsg.request.libConfig).toBeDefined();
    expect(stateMsg.request.libConfig.serialize).toBe(true);
  });
});
