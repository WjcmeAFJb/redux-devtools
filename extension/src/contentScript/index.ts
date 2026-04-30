import '../chromeApiMock.js';
import {
  getOptions,
  isAllowed,
  Options,
  prefetchOptions,
  prepareOptionsForPage,
} from '../options/syncOptions.js';
import type { TabMessage } from '../background/store/apiMiddleware.js';
import type {
  PageScriptToContentScriptMessage,
  PageScriptToContentScriptMessageWithoutDisconnect,
  PageScriptToContentScriptMessageWithoutDisconnectOrInitInstance,
} from '../pageScript/api/index.js';
import { Action } from 'redux';
import {
  CustomAction,
  DispatchAction as AppDispatchAction,
} from '@redux-devtools/app';
import { LiftedState } from '@redux-devtools/instrument';

const source = '@devtools-extension';
const pageSource = '@devtools-page';
// Chrome message limit is 64 MB, but we're using 32 MB to include other object's parts
const maxChromeMsgSize = 32 * 1024 * 1024;
let connected = false;
let bg: chrome.runtime.Port | undefined;

declare global {
  interface Window {
    devToolsExtensionID?: string;
  }
}

interface StartAction {
  readonly type: 'START';
  readonly state: undefined;
  readonly id: undefined;
  readonly source: typeof source;
}

interface StopAction {
  readonly type: 'STOP';
  readonly state: undefined;
  readonly id: undefined;
  readonly source: typeof source;
  readonly failed?: boolean;
}

interface DispatchAction {
  readonly type: 'DISPATCH';
  readonly payload: AppDispatchAction;
  readonly state: string | undefined;
  readonly id: string;
  readonly source: typeof source;
}

interface ImportAction {
  readonly type: 'IMPORT';
  readonly payload: undefined;
  readonly state: string | undefined;
  readonly id: string;
  readonly source: typeof source;
}

interface ActionAction {
  readonly type: 'ACTION';
  readonly payload: string | CustomAction;
  readonly state: string | undefined;
  readonly id: string;
  readonly source: typeof source;
}

interface ExportAction {
  readonly type: 'EXPORT';
  readonly payload: undefined;
  readonly state: string | undefined;
  readonly id: string;
  readonly source: typeof source;
}

interface UpdateAction {
  readonly type: 'UPDATE';
  readonly state: string | undefined;
  readonly id: string;
  readonly source: typeof source;
}

interface OptionsAction {
  readonly type: 'OPTIONS';
  readonly options: Options;
  readonly id: undefined;
  readonly source: typeof source;
}

export type ContentScriptToPageScriptMessage =
  | StartAction
  | StopAction
  | DispatchAction
  | ImportAction
  | ActionAction
  | ExportAction
  | UpdateAction
  | OptionsAction;

interface ImportStatePayload<S, A extends Action<string>> {
  readonly type: 'IMPORT_STATE';
  readonly nextLiftedState: LiftedState<S, A, unknown> | readonly A[];
  readonly preloadedState?: S;
}

interface ImportStateDispatchAction<S, A extends Action<string>> {
  readonly type: 'DISPATCH';
  readonly payload: ImportStatePayload<S, A>;
}

export type ListenerMessage<S, A extends Action<string>> =
  | StartAction
  | StopAction
  | DispatchAction
  | ImportAction
  | ActionAction
  | ExportAction
  | UpdateAction
  | OptionsAction
  | ImportStateDispatchAction<S, A>;

function postToPageScript(message: ContentScriptToPageScriptMessage) {
  window.postMessage(message, '*');
}

function connect() {
  // Connect to the background script
  connected = true;
  const name = 'tab';
  if (window.devToolsExtensionID) {
    bg = chrome.runtime.connect(window.devToolsExtensionID, { name });
  } else {
    bg = chrome.runtime.connect({ name });
  }

  // Relay background script messages to the page script
  bg.onMessage.addListener((message: TabMessage) => {
    if ('action' in message) {
      if (message.type === 'DISPATCH') {
        postToPageScript({
          type: message.type,
          payload: message.action,
          state: message.state,
          id: message.id,
          source,
        });
      } else if (message.type === 'ACTION') {
        postToPageScript({
          type: message.type,
          payload: message.action,
          state: message.state,
          id: message.id,
          source,
        });
      } else {
        postToPageScript({
          type: message.type,
          payload: message.action,
          state: message.state,
          id: message.id,
          source,
        });
      }
    } else if (message.type === 'OPTIONS') {
      postToPageScript({
        type: message.type,
        options: prepareOptionsForPage(message.options),
        id: undefined,
        source,
      });
    } else {
      postToPageScript({
        type: message.type,
        state: message.state,
        id: message.id,
        source,
      });
    }
  });

  bg.onDisconnect.addListener(handleDisconnect);
}

function handleDisconnect() {
  window.removeEventListener('message', handleMessages);
  window.postMessage({ type: 'STOP', failed: true, source }, '*');
  bg = undefined;
}

interface SplitMessageBase {
  readonly type?: never;
}

interface SplitMessageStart extends SplitMessageBase {
  readonly instanceId: number;
  readonly source: typeof pageSource;
  readonly split: 'start';
}

interface SplitMessageChunk extends SplitMessageBase {
  readonly instanceId: number;
  readonly source: typeof pageSource;
  readonly split: 'chunk';
  readonly chunk: [string, string];
}

interface SplitMessageEnd extends SplitMessageBase {
  readonly instanceId: number;
  readonly source: typeof pageSource;
  readonly split: 'end';
}

export type SplitMessage =
  | SplitMessageStart
  | SplitMessageChunk
  | SplitMessageEnd;

function tryCatch<S, A extends Action<string>>(
  fn: (
    args:
      | PageScriptToContentScriptMessageWithoutDisconnect<S, A>
      | SplitMessage,
  ) => void,
  args: PageScriptToContentScriptMessageWithoutDisconnect<S, A>,
) {
  try {
    return fn(args);
  } catch (err) {
    if (
      (err as Error).message ===
      'Message length exceeded maximum allowed length.'
    ) {
      const instanceId = (args as any).instanceId;
      const newArgs = {
        split: 'start',
      };
      const toSplit: [string, string][] = [];
      let size = 0;
      let arg;
      Object.keys(args).map((key) => {
        arg = args[key as keyof typeof args];
        if (typeof arg === 'string') {
          size += arg.length;
          if (size > maxChromeMsgSize) {
            toSplit.push([key, arg]);
            return;
          }
        }
        newArgs[key as keyof typeof newArgs] = arg;
      });
      fn(newArgs as SplitMessage);
      for (let i = 0; i < toSplit.length; i++) {
        for (let j = 0; j < toSplit[i][1].length; j += maxChromeMsgSize) {
          fn({
            instanceId,
            source: pageSource,
            split: 'chunk',
            chunk: [toSplit[i][0], toSplit[i][1].substr(j, maxChromeMsgSize)],
          });
        }
      }
      return fn({ instanceId, source: pageSource, split: 'end' });
    }
    handleDisconnect();
    /* eslint-disable no-console */
    if (process.env.NODE_ENV !== 'production') {
      console.error('Failed to send message', err);
    }
    /* eslint-enable no-console */
  }
}

interface InitInstanceContentScriptToBackgroundMessage {
  readonly name: 'INIT_INSTANCE';
  readonly instanceId: number;
}

interface RelayMessage<S, A extends Action<string>> {
  readonly name: 'RELAY';
  readonly message:
    | PageScriptToContentScriptMessageWithoutDisconnectOrInitInstance<S, A>
    | SplitMessage;
}

export type ContentScriptToBackgroundMessage<S, A extends Action<string>> =
  | InitInstanceContentScriptToBackgroundMessage
  | RelayMessage<S, A>;

function postToBackground<S, A extends Action<string>>(
  message: ContentScriptToBackgroundMessage<S, A>,
) {
  bg!.postMessage(message);
}

function send<S, A extends Action<string>>(
  message:
    | PageScriptToContentScriptMessageWithoutDisconnect<S, A>
    | SplitMessage,
) {
  if (!connected) connect();
  if (message.type === 'INIT_INSTANCE') {
    getOptions((options) => {
      postToPageScript({
        type: 'OPTIONS',
        options: prepareOptionsForPage(options),
        id: undefined,
        source,
      });
    });
    postToBackground({ name: 'INIT_INSTANCE', instanceId: message.instanceId });
  } else {
    postToBackground({ name: 'RELAY', message });
  }
}

// Resend messages from the page to the background script
function handleMessages<S, A extends Action<string>>(
  event: MessageEvent<PageScriptToContentScriptMessage<S, A>>,
) {
  if (!isAllowed()) return;
  if (!event || event.source !== window || typeof event.data !== 'object') {
    return;
  }
  const message = event.data;
  if (message.source !== pageSource) return;
  if ((message as any).type === 'ASYNC_STACK_PREPARE') {
    handleAsyncStackPrepare();
    return;
  }
  if (message.type === 'DISCONNECT') {
    if (bg) {
      bg.disconnect();
      connected = false;
    }
    return;
  }

  tryCatch(send, message);
}

// Background-routed asyncStack support. The page script asks for the
// debugger to be attached via window.postMessage; we forward the request
// over chrome.runtime.sendMessage and route the response back to the page.
// Captured stacks themselves are pushed back from the background through
// chrome.tabs.sendMessage and arrive on chrome.runtime.onMessage.
function handleAsyncStackPrepare() {
  chrome.runtime.sendMessage(
    { type: 'ASYNC_STACK_PREPARE' },
    (response: unknown) => {
      // chrome.runtime.lastError can fire if the background is asleep or
      // the extension is disabled; surface that as an error to the page.
      const err = chrome.runtime.lastError;
      if (err) {
        window.postMessage(
          {
            source,
            type: 'ASYNC_STACK_ERROR',
            message: err.message ?? 'background unreachable',
          },
          '*',
        );
        return;
      }
      if (response && typeof response === 'object') {
        window.postMessage({ source, ...(response as object) }, '*');
      }
    },
  );
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (!msg || typeof msg !== 'object') return;
  const type = (msg as { type?: string }).type;
  if (
    type !== 'ASYNC_STACK_RESULT' &&
    type !== 'ASYNC_STACK_ERROR' &&
    type !== 'ASYNC_STACK_DETACHED'
  ) {
    return;
  }
  window.postMessage({ source, ...(msg as object) }, '*');
});

prefetchOptions();

window.addEventListener('message', handleMessages, false);
