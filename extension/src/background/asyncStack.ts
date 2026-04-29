// Background-side handler for window.asyncStack().
//
// The page script emits a tagged console.warn whose stack we want to read.
// We attach chrome.debugger to the page's tab on first request, enable the
// Runtime + Debugger domains with a deep async-call-stack limit, and listen
// for Runtime.consoleAPICalled events filtered to ONLY our marker prefix —
// so unrelated console.* calls and uncaught exceptions never round-trip a
// stack to the page. That is the optimization the feature spec asked for.

const ASYNC_STACK_MARKER = '__REDUX_DEVTOOLS_ASYNC_STACK__:';
const PROTOCOL_VERSION = '1.3';
const MAX_ASYNC_DEPTH = 32;

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
  const readyPromise = attach(tabId).catch((err) => {
    attached.delete(tabId);
    throw err;
  });
  state = { readyPromise };
  attached.set(tabId, state);
  return readyPromise;
}

function detach(tabId: number) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  // Best-effort detach — tab may already be gone.
  void chrome.debugger.detach({ tabId }).catch(() => undefined);
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

chrome.debugger.onEvent.addListener(
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

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
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
