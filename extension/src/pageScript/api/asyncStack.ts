// window.asyncStack(): Promise<string>
//
// Captures the async stack trace at the call site. In Chrome the async chain
// is only visible to the DevTools protocol, not to plain `Error.stack`, so we
// route the request through the extension's chrome.debugger session in the
// background service worker.
//
// Protocol with the content script (and onward to background):
//   page -> contentScript: { type: 'ASYNC_STACK_PREPARE' }
//                          (sent on first call, and again after any debugger
//                          detach — the MV3 service worker can be unloaded
//                          while idle, which auto-detaches chrome.debugger)
//   contentScript -> page: { type: 'ASYNC_STACK_READY' | 'ASYNC_STACK_ERROR' }
//   page -> contentScript: nothing — the page emits a tagged console.warn,
//                          the background's debugger event listener picks it
//                          up and only then forwards a result.
//   contentScript -> page: { type: 'ASYNC_STACK_RESULT', id, stack }
//                          { type: 'ASYNC_STACK_ERROR', id?, message }
//                          { type: 'ASYNC_STACK_DETACHED' } — proactive
//                          invalidation when the background sees its debugger
//                          session end (idle unload, user cancel, tab nav).
//
// The marker prefix is a literal string the background filters by, so the
// debugger only round-trips a stack for explicit asyncStack() calls — every
// other console.* and uncaught exception is ignored by our listener.

const PAGE_SOURCE = '@devtools-page';
const EXT_SOURCE = '@devtools-extension';
export const ASYNC_STACK_MARKER = '__REDUX_DEVTOOLS_ASYNC_STACK__:';

// Capture timeout. The normal happy-path round-trip is well under 100ms
// once the debugger is attached; anything past ~1.2s almost certainly means
// the background's debugger session is gone (MV3 idle unload, user-cancelled
// attach banner, etc.) and we should re-prepare rather than keep waiting.
const CAPTURE_TIMEOUT_MS = 1500;
// Prepare timeout. Cold-start path: SW spinup + chrome.debugger.attach +
// Debugger.enable + setAsyncCallStackDepth — give it real budget.
const PREPARE_TIMEOUT_MS = 5000;

interface PendingCall {
  resolve: (stack: string) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingCall>();
let nextCallId = 1;
let preparePromise: Promise<void> | null = null;
let listenerInstalled = false;

interface AsyncStackPrepareMessage {
  readonly source: typeof PAGE_SOURCE;
  readonly type: 'ASYNC_STACK_PREPARE';
}

interface AsyncStackReadyMessage {
  readonly source: typeof EXT_SOURCE;
  readonly type: 'ASYNC_STACK_READY';
}

interface AsyncStackResultMessage {
  readonly source: typeof EXT_SOURCE;
  readonly type: 'ASYNC_STACK_RESULT';
  readonly id: string;
  readonly stack: string;
}

interface AsyncStackErrorMessage {
  readonly source: typeof EXT_SOURCE;
  readonly type: 'ASYNC_STACK_ERROR';
  readonly id?: string;
  readonly message: string;
}

interface AsyncStackDetachedMessage {
  readonly source: typeof EXT_SOURCE;
  readonly type: 'ASYNC_STACK_DETACHED';
}

type IncomingMessage =
  | AsyncStackReadyMessage
  | AsyncStackResultMessage
  | AsyncStackErrorMessage
  | AsyncStackDetachedMessage;

function resetPreparedState() {
  prepared = false;
  preparePromise = null;
}

function installListener() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== EXT_SOURCE) return;
    if (msg.type === 'ASYNC_STACK_RESULT') {
      const call = pending.get(msg.id);
      if (!call) return;
      pending.delete(msg.id);
      clearTimeout(call.timeoutId);
      call.resolve(msg.stack);
    } else if (msg.type === 'ASYNC_STACK_ERROR') {
      if (msg.id) {
        const call = pending.get(msg.id);
        if (call) {
          pending.delete(msg.id);
          clearTimeout(call.timeoutId);
          call.reject(new Error(msg.message));
        }
      } else {
        // Broadcast error: fail every in-flight call.
        for (const [id, call] of pending) {
          clearTimeout(call.timeoutId);
          call.reject(new Error(msg.message));
          pending.delete(id);
        }
      }
    } else if (msg.type === 'ASYNC_STACK_DETACHED') {
      // The background lost its debugger session. Any in-flight call is
      // already doomed (no listener will capture the marker), and the
      // cached `prepared` state is stale. Tear both down so the next call
      // re-prepares from scratch.
      resetPreparedState();
      for (const [id, call] of pending) {
        clearTimeout(call.timeoutId);
        call.reject(new Error('asyncStack: debugger detached'));
        pending.delete(id);
      }
    }
  });
}

function prepare(): Promise<void> {
  if (preparePromise) return preparePromise;
  installListener();
  preparePromise = new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', onReady);
      preparePromise = null;
      reject(
        new Error(
          'asyncStack: timed out waiting for the Redux DevTools extension ' +
            'background to attach the debugger. Is the extension installed ' +
            'and the page loaded under it?',
        ),
      );
    }, PREPARE_TIMEOUT_MS);
    function onReady(event: MessageEvent<IncomingMessage>) {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.source !== EXT_SOURCE) return;
      if (msg.type === 'ASYNC_STACK_READY') {
        window.removeEventListener('message', onReady);
        clearTimeout(timeoutId);
        resolve();
      } else if (msg.type === 'ASYNC_STACK_ERROR' && !msg.id) {
        window.removeEventListener('message', onReady);
        clearTimeout(timeoutId);
        // Reset so a future attempt can retry.
        preparePromise = null;
        reject(new Error(msg.message));
      }
    }
    window.addEventListener('message', onReady);
    const prepareMsg: AsyncStackPrepareMessage = {
      source: PAGE_SOURCE,
      type: 'ASYNC_STACK_PREPARE',
    };
    window.postMessage(prepareMsg, '*');
  });
  return preparePromise;
}

// Whether the chrome.debugger attach has completed. The first call to
// asyncStack always involves an awaited message round-trip with the
// background, and that round-trip resolves through a host `message` event
// — V8 cannot carry the user's async-parent chain across such a host
// boundary, so the FIRST call after page load has a stack that only
// reaches as far as the message handler. Once `prepared` flips, the
// `await prepare()` below sees an already-resolved cached promise, which
// V8 traces back to the awaiter exactly the same way it does for
// `await Promise.resolve()` — and the user's chain is preserved.
//
// Callers that need a complete stack on the very first call should call
// `await window.asyncStack.warmup()` once during initialization.
//
// `prepared` is also flipped back to false when the background tells us
// (via ASYNC_STACK_DETACHED) that its debugger session has gone away, or
// when a capture times out — the latter handles the case where the MV3
// service worker was unloaded silently and we never got a detach event.
let prepared = false;

async function ensurePrepared(): Promise<void> {
  if (prepared) return;
  await prepare();
  prepared = true;
}

function captureOnce(): Promise<string> {
  const id = `${Date.now()}-${nextCallId++}`;
  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`asyncStack: timed out waiting for stack id=${id}`));
    }, CAPTURE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timeoutId });
    // The marker is what the background's debugger event listener filters
    // on — calling console.warn synchronously here means the stack the
    // debugger captures starts at this very call frame, with V8's async
    // continuation chain attached as parent stacks. We use console.warn
    // (not error/log) so the page's own log output remains untouched in
    // user code, and route through a marker prefix so we don't intercept
    // unrelated console output.
    console.warn(ASYNC_STACK_MARKER + id);
  });
}

function isCaptureTimeout(err: unknown): boolean {
  return (
    err instanceof Error && err.message.startsWith('asyncStack: timed out ')
  );
}

export async function asyncStack(): Promise<string> {
  await ensurePrepared();
  try {
    return await captureOnce();
  } catch (err) {
    // A capture timeout almost always means the background's debugger
    // session is gone (MV3 idle unload, user cancelled the attach banner,
    // tab navigated and the listener was torn down). Drop the cached
    // prepare state, re-prepare, and retry once. The retry path crosses
    // the message-handler host boundary so the async parent chain may be
    // truncated for this single recovery call, but subsequent calls work
    // with a full chain again because `prepared` is back to true.
    if (!isCaptureTimeout(err)) throw err;
    resetPreparedState();
    await ensurePrepared();
    return await captureOnce();
  }
}

asyncStack.warmup = async function warmup(): Promise<void> {
  await ensurePrepared();
};
