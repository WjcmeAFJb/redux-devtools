// Background-side handler for window.asyncStack().
//
// The page script emits a tagged console.warn whose stack we want to read.
// We attach chrome.debugger to the page's tab on first request, enable the
// Runtime + Debugger domains with a deep async-call-stack limit, and listen
// for Runtime.consoleAPICalled events filtered to ONLY our marker prefix —
// so unrelated console.* calls and uncaught exceptions never round-trip a
// stack to the page. That is the optimization the feature spec asked for.
//
// Lifetime
// --------
// MV3 service workers are unloaded after ~30s of idle, and Chrome auto-
// detaches chrome.debugger when that happens — which would silently break
// every asyncStack() call after the first idle window (the page just emits
// a console.warn marker; if no debugger is attached, the marker is never
// captured). To keep asyncStack() reliable for the entire page lifetime
// we do three things:
//
//   1. While at least one tab has requested asyncStack, run a self-ping
//      interval that calls a chrome.* API every 20s. Each call resets the
//      SW idle timer, so the SW never reaches the 30s idle threshold and
//      Chrome never unloads it. This is the documented MV3 keep-alive
//      pattern (see crbug.com/1316588 discussion).
//
//   2. Register a periodic chrome.alarm as a backup wake source. If the
//      SW is killed for a reason that bypasses the keep-alive (browser
//      restart, OOM, extension reload), the alarm wakes the SW back up
//      within ~1 minute and the module-init path re-attaches.
//
//   3. Persist the set of currently-attached tab ids to
//      chrome.storage.session so that on module init we can re-attach
//      chrome.debugger to every tab that asked for asyncStack before the
//      SW died. The page never has to know the SW restarted.

const ASYNC_STACK_MARKER = '__REDUX_DEVTOOLS_ASYNC_STACK__:';
const PROTOCOL_VERSION = '1.3';
const MAX_ASYNC_DEPTH = 32;
const STORAGE_KEY = 'asyncStack:attachedTabs';
const KEEP_ALIVE_INTERVAL_MS = 20_000;
const HEARTBEAT_ALARM = 'asyncStack:heartbeat';
const HEARTBEAT_PERIOD_MIN = 1;

type DebuggeeTab = chrome.debugger.Debuggee & { tabId: number };

interface RemoteObject {
  readonly type?: string;
  readonly value?: unknown;
}

interface CallFrame {
  readonly functionName?: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  readonly scriptId?: string;
}

interface StackTrace {
  readonly description?: string;
  readonly callFrames?: CallFrame[];
  readonly parent?: StackTrace;
  readonly parentId?: { id: string; debuggerId?: string };
}

interface ConsoleAPICalledParams {
  readonly type: string;
  readonly args: RemoteObject[];
  readonly stackTrace?: StackTrace;
}

interface AttachedTabState {
  // Resolved once Debugger.enable + setAsyncCallStackDepth have settled.
  readonly readyPromise: Promise<void>;
}

const attached = new Map<number, AttachedTabState>();

async function persistAttachedTabs(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY]: Array.from(attached.keys()),
    });
  } catch {
    // chrome.storage.session is available on every Chrome that supports
    // MV3 SWs; if the write fails we just lose the cross-restart restore
    // for this entry. The page-side timeout-and-retry handles that case.
  }
}

async function readAttachedTabs(): Promise<number[]> {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    return Array.isArray(value)
      ? value.filter((v): v is number => typeof v === 'number')
      : [];
  } catch {
    return [];
  }
}

async function attach(tabId: number): Promise<void> {
  const target: DebuggeeTab = { tabId };
  await chrome.debugger.attach(target, PROTOCOL_VERSION);
  // Order matters: Runtime must be enabled before consoleAPICalled fires
  // for events generated after attach. setAsyncCallStackDepth is the
  // knob that turns on async parent capture for both the Debugger and
  // Runtime domains in V8.
  await chrome.debugger.sendCommand(target, 'Runtime.enable');
  await chrome.debugger.sendCommand(target, 'Debugger.enable');
  await chrome.debugger.sendCommand(target, 'Debugger.setAsyncCallStackDepth', {
    maxDepth: MAX_ASYNC_DEPTH,
  });
}

function ensureAttached(tabId: number): Promise<void> {
  let state = attached.get(tabId);
  if (state) return state.readyPromise;
  const readyPromise = attach(tabId).then(
    () => {
      void persistAttachedTabs();
      void ensureLifetimeGuards();
    },
    (err) => {
      attached.delete(tabId);
      void persistAttachedTabs();
      throw err;
    },
  );
  state = { readyPromise };
  attached.set(tabId, state);
  return readyPromise;
}

function detach(tabId: number) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  void persistAttachedTabs();
  void ensureLifetimeGuards();
  // Best-effort detach — tab may already be gone.
  void chrome.debugger.detach({ tabId }).catch(() => undefined);
}

// Tell the page that the cached prepared state is stale. Without this
// signal the page would only discover the detach when the next capture
// times out (the marker would land in a tab whose debugger is no longer
// attached). The page resets its `prepared` flag on receipt and the next
// asyncStack() call goes through prepare() again.
function notifyDetached(tabId: number) {
  sendToTab(tabId, { type: 'ASYNC_STACK_DETACHED' });
}

function formatFrame(frame: CallFrame): string {
  const name = frame.functionName?.trim() || '<anonymous>';
  const url = frame.url || '<eval>';
  const line = (frame.lineNumber ?? 0) + 1;
  const col = (frame.columnNumber ?? 0) + 1;
  return `    at ${name} (${url}:${line}:${col})`;
}

function formatStack(stackTrace: StackTrace | undefined): string {
  if (!stackTrace) return '';
  const out: string[] = [];
  let segment: StackTrace | undefined = stackTrace;
  let isFirst = true;
  while (segment) {
    if (!isFirst) {
      // CDP uses descriptions like "Promise.then", "setTimeout", "async
      // function" to label what scheduled the next-older frames.
      const tag = segment.description?.trim() || 'async';
      out.push(`--- ${tag} ---`);
    }
    for (const frame of segment.callFrames || []) {
      out.push(formatFrame(frame));
    }
    segment = segment.parent;
    isFirst = false;
  }
  return out.join('\n');
}

// Collapse the marker frame off the top of the stack so callers see the
// stack of the function that called window.asyncStack(), not the internals
// of asyncStack itself. We strip any leading frames whose source URL is
// our own page.bundle.js — function names there are minified and the
// frames are pure plumbing (console.warn callsite, the Promise executor
// in asyncStack, the asyncStack wrapper itself).
function trimWrapperFrames(stack: string): string {
  const lines = stack.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isFrame = /^\s*at /.test(line);
    if (!isFrame) break;
    if (
      line.includes('/page.bundle.js') ||
      line.includes('/content.bundle.js') ||
      line.includes('/background.bundle.js')
    ) {
      i++;
      continue;
    }
    break;
  }
  // Likewise, drop a leading async-segment marker that's now the first
  // line — it would just dangle without frames above it.
  while (i < lines.length && /^---\s/.test(lines[i])) i++;
  return lines.slice(i).join('\n');
}

function sendToTab(tabId: number, message: unknown) {
  // Best-effort — no callback handler needed. If the content script isn't
  // listening (page navigated, tab closed, etc.) the message is dropped.
  void chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

// Keep-alive: while at least one tab has requested asyncStack, ping a
// chrome.* API every 20s. Each call resets the MV3 SW idle timer
// (default 30s), so Chrome never unloads us — and chrome.debugger never
// gets auto-detached out from under the page. The interval is reset
// every time we re-enter this function (e.g., on attach), so we don't
// stack timers across SW restarts.
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepAlive() {
  if (keepAliveTimer != null) return;
  keepAliveTimer = setInterval(() => {
    // getPlatformInfo is cheap, doesn't require any permission, and
    // counts as activity for the SW idle timer. Errors are not
    // meaningful here — we just need the API call itself.
    void chrome.runtime.getPlatformInfo().catch(() => undefined);
  }, KEEP_ALIVE_INTERVAL_MS);
}

function stopKeepAlive() {
  if (keepAliveTimer == null) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// Heartbeat alarm: backstop for the rare case the SW is killed despite
// the keep-alive (browser restart, extension reload, OOM). Alarms wake
// the SW even when the JS VM has been torn down, and on wake the
// module-init path below re-attaches the debugger to all stored tabs.
async function ensureLifetimeGuards(): Promise<void> {
  if (attached.size > 0) {
    startKeepAlive();
    try {
      const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
      if (!existing) {
        await chrome.alarms.create(HEARTBEAT_ALARM, {
          periodInMinutes: HEARTBEAT_PERIOD_MIN,
        });
      }
    } catch {
      // chrome.alarms unavailable (e.g., test environment) — keep-alive
      // alone is still effective for the live-session case.
    }
  } else {
    stopKeepAlive();
    try {
      await chrome.alarms.clear(HEARTBEAT_ALARM);
    } catch {
      // no-op
    }
  }
}

// Restore attach state when the SW comes back up. Module init runs
// every time the SW wakes (initial install, browser start, post-idle
// wake by alarm, etc.) — so this is where we paper over SW death from
// the page's point of view. The page's `prepared = true` flag stays
// valid because by the time the page's next console.warn fires, the
// debugger is reattached and listening again.
async function restoreAttachedTabs(): Promise<void> {
  const tabIds = await readAttachedTabs();
  if (tabIds.length === 0) return;
  await Promise.all(
    tabIds.map(async (tabId) => {
      try {
        await ensureAttached(tabId);
      } catch {
        // Tab closed, navigated, or debugger banner refused — drop it
        // from the persisted set so we don't keep retrying forever.
        attached.delete(tabId);
        await persistAttachedTabs();
      }
    }),
  );
  await ensureLifetimeGuards();
}

void restoreAttachedTabs();

if (typeof chrome.alarms?.onAlarm?.addListener === 'function') {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== HEARTBEAT_ALARM) return;
    // Just having the handler run wakes the SW; restoreAttachedTabs has
    // already executed at module init, so attach state is current. We
    // also re-establish the keep-alive interval in case it was lost.
    if (attached.size > 0) startKeepAlive();
  });
}

// chrome.debugger is Chromium-only — undefined in Firefox. Guard the
// registration (like the chrome.alarms/chrome.tabs handlers above): without
// it, this line throws at background load and aborts the rest of the module,
// including the chrome.runtime.onMessage listener the panel relies on to
// detect connected stores. asyncStack() is simply unavailable in Firefox.
chrome.debugger?.onEvent?.addListener(
  (source, method, untypedParams) => {
    if (method !== 'Runtime.consoleAPICalled') return;
    const tabId = source.tabId;
    if (tabId == null) return;

    const params = untypedParams as ConsoleAPICalledParams | undefined;
    if (!params || params.type !== 'warning') return;
    const firstArg = params.args?.[0];
    if (firstArg?.type !== 'string') return;
    const value = firstArg.value;
    if (typeof value !== 'string' || !value.startsWith(ASYNC_STACK_MARKER)) {
      return;
    }
    const id = value.slice(ASYNC_STACK_MARKER.length);
    try {
      const stack = trimWrapperFrames(formatStack(params.stackTrace));
      sendToTab(tabId, { type: 'ASYNC_STACK_RESULT', id, stack });
    } catch (err) {
      sendToTab(tabId, {
        type: 'ASYNC_STACK_ERROR',
        id,
        message: (err as Error).message,
      });
    }
  },
);

chrome.debugger?.onDetach?.addListener((source) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  // Only notify if we believed we were attached — avoids a notification
  // for an attach we already cleaned up via tab close.
  const wasAttached = attached.has(tabId);
  attached.delete(tabId);
  void persistAttachedTabs();
  void ensureLifetimeGuards();
  if (wasAttached) notifyDetached(tabId);
});

if (typeof chrome.tabs?.onRemoved?.addListener === 'function') {
  chrome.tabs.onRemoved.addListener((tabId) => detach(tabId));
}

chrome.runtime.onMessage.addListener(
  (
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (!msg || typeof msg !== 'object') return undefined;
    const type = (msg as { type?: string }).type;
    if (type !== 'ASYNC_STACK_PREPARE') return undefined;
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({
        type: 'ASYNC_STACK_ERROR',
        message: 'asyncStack: missing sender tab id',
      });
      return undefined;
    }
    ensureAttached(tabId).then(
      () => sendResponse({ type: 'ASYNC_STACK_READY' }),
      (err: Error) =>
        sendResponse({
          type: 'ASYNC_STACK_ERROR',
          message: err.message || String(err),
        }),
    );
    // Returning true keeps the sendResponse channel open across the await.
    return true;
  },
);

export {};
