import { jest } from '@jest/globals';
import chrome from 'sinon-chrome/extensions';

globalThis.chrome = chrome;

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
const { REMOVE_SINGLE_INSTANCE } = await import('../../../src/store/instances.js');

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

// Simulates conn.disconnect(): the page posts { type: 'REMOVE', instanceId },
// which the content script relays to the background over the tab port.
function relayRemove(tabPort, instanceId) {
  tabPort.onMessage.trigger({
    name: 'RELAY',
    message: { type: 'REMOVE', instanceId, source: '@devtools-page' },
  });
}

describe('per-instance removal via conn.disconnect()', () => {
  afterAll(() => {
    chrome.flush();
    delete globalThis.chrome;
  });

  it('removes one connect() instance, keeps siblings, then clears to default', () => {
    const tabPort = makePort('tab', { tab: { id: 100 }, frameId: 0 });
    chrome.runtime.onConnect.dispatch(tabPort);
    relayInit(tabPort, 1);
    relayInit(tabPort, 2);

    const panelPort = makePort('monitor', { id: 'ext-id' });
    chrome.runtime.onConnect.dispatch(panelPort);

    // Both stores are registered under the one tab connection.
    let inst = store.getState().instances;
    expect(inst.connections['100']).toEqual(['100/1', '100/2']);
    expect(inst.states['100/1']).toBeDefined();
    expect(inst.states['100/2']).toBeDefined();
    expect(inst.current).toBe('100/2');

    // Remove just instance 2.
    relayRemove(tabPort, 2);

    inst = store.getState().instances;
    expect(inst.states['100/2']).toBeUndefined();
    expect(inst.options['100/2']).toBeUndefined();
    expect(inst.connections['100']).toEqual(['100/1']); // sibling kept
    expect(inst.states['100/1']).toBeDefined();
    expect(inst.current).toBe('100/1'); // moved off the removed instance

    // The open panel was told to drop exactly that instance.
    const removeCalls = panelPort.postMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m && m.type === REMOVE_SINGLE_INSTANCE);
    expect(removeCalls.map((m) => m.id)).toEqual(['100/2']);

    // Removing the last instance clears the connection and resets current.
    relayRemove(tabPort, 1);
    inst = store.getState().instances;
    expect(inst.states['100/1']).toBeUndefined();
    expect(inst.connections['100']).toBeUndefined();
    expect(inst.current).toBe('default');
  });
});
