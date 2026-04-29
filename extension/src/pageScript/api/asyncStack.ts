// window.asyncStack(): Promise<string>
//
// Captures the async stack trace at the call site. In Chrome the async chain
// is only visible to the DevTools protocol, not to plain `Error.stack`, so we
// route the request through the extension's chrome.debugger session in the
// background service worker.
//
// Protocol with the content script (and onward to background):
//   page -> contentScript: { type: 'ASYNC_STACK_PREPARE' }
//                          (sent on first call only — debugger attach is lazy)
//   contentScript -> page: { type: 'ASYNC_STACK_READY' | 'ASYNC_STACK_ERROR' }
//   page -> contentScript: nothing — the page emits a tagged console.warn,
//                          the background's debugger event listener picks it
//                          up and only then forwards a result.
//   contentScript -> page: { type: 'ASYNC_STACK_RESULT', id, stack }
//                          { type: 'ASYNC_STACK_ERROR', id?, message }
//
// The marker prefix is a literal string the background filters by, so the
// debugger only round-trips a stack for explicit asyncStack() calls — every
// other console.* and uncaught exception is ignored by our listener.

const PAGE_SOURCE = '@devtools-page';
const EXT_SOURCE = '@devtools-extension';
export const ASYNC_STACK_MARKER = '__REDUX_DEVTOOLS_ASYNC_STACK__:';

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

type IncomingMessage =
  | AsyncStackReadyMessage
  | AsyncStackResultMessage
  | AsyncStackErrorMessage;

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
    }
  });
}

function prepare(): Promise<void> {
  if (preparePromise) return preparePromise;
  installListener();
  preparePromise = new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', onReady);
      reject(
        new Error(
          'asyncStack: timed out waiting for the Redux DevTools extension ' +
            'background to attach the debugger. Is the extension installed ' +
            'and the page loaded under it?',
        ),
      );
    }, 5000);
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
let prepared = false;

async function ensurePrepared(): Promise<void> {
  if (prepared) return;
  await prepare();
  prepared = true;
}

export async function asyncStack(): Promise<string> {
  await ensurePrepared();
  const id = `${Date.now()}-${nextCallId++}`;
  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`asyncStack: timed out waiting for stack id=${id}`));
    }, 5000);
    pending.set(id, { resolve, reject, timeoutId });
    // The marker is what the background's debugger event listener filters
    // on — calling console.warn synchronously here means the stack the
    // debugger captures starts at this very call frame, with V8's async
    // continuation chain attached as parent stacks. We use console.warn
    // (not error/log) so the page's own log output remains untouched in
    // user code, and route through a marker prefix so we don't intercept
    // unrelated console output.
    // eslint-disable-next-line no-console
    console.warn(ASYNC_STACK_MARKER + id);
  });
}

asyncStack.warmup = async function warmup(): Promise<void> {
  await ensurePrepared();
};
