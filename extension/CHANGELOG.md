# remotedev-redux-devtools-extension

## 3.2.19

### Patch Changes

- feat(extension): `connect().disconnect()` to remove a single store from the
  devtools.

  `window.__REDUX_DEVTOOLS_EXTENSION__.disconnect()` disconnects the whole tab
  (every connected store), and the `connect()` handle's `unsubscribe()` only
  detached the page-side listener — the store stayed in the monitor's instance
  dropdown. There was no way to remove just one of several `connect()` stores.

  The object returned by `connect()` now also exposes `disconnect()`:

  ```js
  const a = window.__REDUX_DEVTOOLS_EXTENSION__.connect({ name: 'Store A' });
  const b = window.__REDUX_DEVTOOLS_EXTENSION__.connect({ name: 'Store B' });
  // …later, drop just Store B from devtools:
  b.disconnect();
  ```

  It removes that instance from the background store and every open panel while
  keeping sibling instances on the same tab; if the removed instance was
  selected/current, the monitor falls back to a remaining one. After
  `disconnect()`, that connection's `send()`/`init()` are no-ops (call
  `connect()` again to reconnect).

## 3.2.18

### Patch Changes

- fix(extension): stop `window.asyncStack()` from spamming "Uncaught (in
  promise)" errors in Firefox.

  `window.asyncStack()`/`warmup()` post an `ASYNC_STACK_PREPARE` message that
  the background turns into a `chrome.debugger.attach()` call. `chrome.debugger`
  is Chromium-only, so in Firefox the attach throws `can't access property
  "attach", chrome.debugger is undefined`. That error round-trips to the page
  and rejects `prepare()`; because callers rarely `.catch()` `asyncStack()` and
  the cached prepare promise is reset on every rejection, each call produced a
  fresh unhandled rejection.

  The background now reports the feature as unsupported (instead of attempting
  to attach) when `chrome.debugger` is absent, and the page caches that and
  degrades to the synchronous `Error().stack` — resolving with a usable (if
  shallower) stack and warning once — rather than rejecting.

- fix(extension): stop `ASYNC_STACK_PREPARE` from corrupting the instances
  store, which made multi-store panels hang on "loading" after reopen.

  The background runs two `chrome.runtime.onMessage` listeners — the store's
  `messaging` and the dedicated asyncStack handler — and both receive every
  `chrome.runtime.sendMessage`. The content script forwards
  `ASYNC_STACK_PREPARE` that way, so `messaging` saw it too and, lacking a
  guard, dispatched it as a malformed `UPDATE_STATE`. That pointed
  `instances.current` at a phantom instance keyed by the bare tab id, with no
  `states` entry. On the next panel connection the cached-state re-send threw
  while destructuring the missing state and the panel never received anything —
  so a reopened panel backed by raw-API `connect()` stores (which, unlike the
  store enhancer, do not re-relay on `START`) was stuck loading. First open
  usually worked because real updates moved `current` back to a real instance,
  so the failure looked intermittent.

  `messaging` now ignores `ASYNC_STACK_*` messages, and the on-connect re-send
  is guarded so a half-registered instance can never throw.

## 3.2.17

### Patch Changes

- fix(trace-tab): stop racing Chrome's "Open app …?" confirmation prompt
  when launching an external editor.

  The 3.2.16-era `openInEditor` (inherited unchanged from the upstream
  fork) opened the editor's custom-protocol URL by creating a real tab
  via `chrome.tabs.create` and removing the tab on the next
  `chrome.windows.onFocusChanged` event. Chrome surfaces an "Open app
  'Visual Studio Code'?" confirmation in that new tab, and the user has
  to click "Open" to accept. When devtools was undocked into its own
  window, clicking the prompt shifted window focus — which fired our
  listener, which removed the tab, which killed the prompt. The protocol
  never launched. (Even with devtools docked, a blank tab flashed open
  on every click.)

  We now navigate a hidden iframe to the protocol URL instead. Chrome's
  confirmation prompt is rendered at the window level and is not coupled
  to the iframe lifetime, so the prompt survives focus changes and no
  blank tab is left behind. Iframe is cleaned up after 10 s.

- docs(options): reword the projectPath hint. 3.2.16 claimed it could be
  left empty for Vite ("source maps already contain absolute paths"),
  but that only holds for plugin pipelines whose source maps actually
  emit absolute on-disk paths in `sources`. Many Vite setups emit
  URL-relative paths instead, in which case projectPath is still
  required. The hint now spells out both cases.

## 3.2.16

### Patch Changes

- fix(trace-tab): preserve intermediate directories when opening stack-trace
  entries in an external editor; auto-detect absolute paths in source maps.

  Two related issues with the "open in external editor" feature were fixed:

  1. **Lost intermediate path segments.** When a source map only carried a
     partial source (e.g. just `file.tsx`), `openInEditor` used to concatenate
     it directly onto the configured `projectPath`, so a stack entry for
     `http://localhost:5173/src/some/path/file.tsx?t=12345678:565:30` opened
     `/home/user/workspace/file.tsx` instead of
     `/home/user/workspace/src/some/path/file.tsx`. The path is now resolved
     against the served URL's pathname, which is the source of truth for
     project-relative paths in dev-server setups (Vite, etc.). Cache-buster
     query strings (`?t=…`, `#…`) are stripped consistently.

  2. **`projectPath` is now optional when source maps already contain
     absolute filesystem paths** (the Vite default — sources like
     `/home/user/project/src/file.tsx`). The new resolver compares the source
     against the served URL pathname to tell an absolute fs path apart from a
     URL pathname, and skips prepending `projectPath` in the absolute case.
     This means users juggling several projects no longer need to keep
     editing the project root setting between them.

## 3.2.15

### Patch Changes

- fix(extension): restore store detection in Firefox (regression since the asyncStack feature)

  `background/asyncStack.ts` registered `chrome.debugger.onEvent` /
  `chrome.debugger.onDetach` listeners at module load **without a guard**.
  `chrome.debugger` is Chromium-only — it is `undefined` in Firefox — so the
  line threw a `TypeError` while the background service worker was
  initializing. Because the throw happened before
  `chrome.runtime.onMessage.addListener` ran, the message handler the panel
  uses to discover connected stores was never registered, and Firefox
  reported no stores at all.

  Both registrations are now guarded with optional chaining
  (`chrome.debugger?.onEvent?.addListener(...)`), matching the existing
  `chrome.alarms`/`chrome.tabs` guards in the same file. The background
  script now loads cleanly in Firefox; `window.asyncStack()` remains a
  Chrome-only feature there (it requires `chrome.debugger`), which is the
  intended behavior.

## 3.2.14

### Patch Changes

- fix(extension): pass the dispatched action to a `trace` function

  When `config.trace` is a function, the `connect()` API now calls it with
  the action being dispatched, matching the documented
  `(action) => string` signature and the behavior of the store-enhancer
  path (which already forwarded the action via `instrument`). Previously
  the `connect()` path invoked `trace()` with no arguments, so callers had
  no way to vary the captured stack per-action (filter, drop, or
  substitute by action type/payload). The action is unwrapped from any
  structural action and normalized so a string action is passed as
  `{ type }`. Returning a falsy value still falls back to / disables the
  trace as before.

## 3.2.13

### Patch Changes

- fix(extension): keep window.asyncStack() working for the full page lifetime

  The Manifest V3 service worker is unloaded after ~30s of idle, which
  auto-detaches `chrome.debugger`. The original asyncStack feature did
  not account for this: the page-side `prepared` flag was cached after
  the first successful attach and never reset, so once the SW idled out
  every subsequent `asyncStack()` call timed out at 5 seconds. This
  matched the reported "works a few times then fails every time" symptom.

  Root-cause fix — make the SW stay alive while asyncStack is in use:

  - Self-ping a chrome.\* API every 20s while at least one tab has
    requested asyncStack. Each call resets the SW idle timer, so Chrome
    never unloads the SW and chrome.debugger stays attached.
  - Persist the set of attached tab ids to `chrome.storage.session`. On
    SW restart, module init reads the list and re-attaches to every
    listed tab, so a SW death the keep-alive could not prevent (browser
    restart, extension reload, OOM) is invisible to the page.
  - Register a periodic `chrome.alarms` heartbeat as a backstop wake
    source for the SW-killed-with-no-other-event case. New `alarms`
    permission is added to the chrome / edge / firefox manifests.

  Defense-in-depth (keeps working even if a guard fails):

  - Background sends `ASYNC_STACK_DETACHED` on `chrome.debugger.onDetach`
    (e.g., the user cancels the debugger banner) so the page invalidates
    its cached prepare state immediately rather than waiting for the
    next call to time out.
  - Page-side capture timeout shortened from 5s to 1.5s, and on timeout
    the page resets prepare and retries once. With the keep-alive in
    place this path is rarely hit, but it ensures recovery even in the
    paranoid case where every other guard misses.

## 3.2.12

### Patch Changes

- Updated dependencies [3f90241]
- Updated dependencies [d61d31a]
- Updated dependencies [804e729]
- Updated dependencies [12849a4]
- Updated dependencies [804d6bd]
- Updated dependencies [6481386]
  - @redux-devtools/instrument@3.0.0
  - @redux-devtools/ui@3.0.0
  - @redux-devtools/slider-monitor@7.0.0
  - @redux-devtools/core@5.0.0
  - @redux-devtools/app@8.0.0
  - @redux-devtools/serialize@1.0.0
  - @redux-devtools/utils@4.0.0

## 3.2.11

### Patch Changes

- Updated dependencies [6163276]
  - @redux-devtools/app@7.0.0
  - @redux-devtools/slider-monitor@6.0.0
  - @redux-devtools/ui@2.0.0

## 3.2.10

### Patch Changes

- @redux-devtools/app@6.2.2

## 3.2.9

### Patch Changes

- Updated dependencies [91f21b2]
  - @redux-devtools/core@4.1.1
  - @redux-devtools/slider-monitor@5.1.1
  - @redux-devtools/utils@3.1.1
  - @redux-devtools/app@6.2.1

## 3.2.8

### Patch Changes

- Updated dependencies [6830118]
  - react-json-tree@0.20.0
  - @redux-devtools/app@6.2.0
  - @redux-devtools/slider-monitor@6.0.0
  - @redux-devtools/ui@1.4.0
  - @redux-devtools/core@4.1.0
  - @redux-devtools/utils@4.0.0

## 3.2.7

### Patch Changes

- b25bf13: Send state from background when monitor connects

## 3.2.6

### Patch Changes

- 50d7682: Fix DevTools from losing connection

## 3.2.5

### Patch Changes

- eb3ac09: Add logging to background service worker

## 3.2.4

### Patch Changes

- f1d6158: Fix mocking Chrome API for Electron

## 3.2.3

### Patch Changes

- fd9f950: Fix monitoring on opening panel
- e49708d: Fix manifest.json for Edge

## 3.2.1

### Patch Changes

- abd03a7: Fix: only send data to extension if DevTools are open

## 3.2.0

### Minor Changes

- 83b2c19: Upgrade to Manifest V3

## 3.1.11

### Patch Changes

- 73688e1: Fix releasing Firefox extension

## 3.1.10

### Patch Changes

- 2163bc3: Split large messages sent from background page to devpanel

## 3.1.9

### Patch Changes

- Updated dependencies [bbb1a40]
  - react-json-tree@0.19.0
  - @redux-devtools/slider-monitor@5.0.1
  - @redux-devtools/ui@1.3.2

## 3.1.8

### Patch Changes

- 191d419: Convert d3 packages to ESM
- Updated dependencies [191d419]
  - @redux-devtools/app@6.0.1

## 3.1.7

### Patch Changes

- Updated dependencies [5cfe3e5]
- Updated dependencies [decc035]
  - @redux-devtools/app@6.0.0
  - @redux-devtools/slider-monitor@5.0.0
  - @redux-devtools/core@4.0.0
  - @redux-devtools/utils@3.0.0

## 3.1.6

### Patch Changes

- Updated dependencies [158ba2c]
  - @redux-devtools/app@5.0.0

## 3.1.5

### Patch Changes

- 65205f90: Replace Action<unknown> with Action<string>
- Updated dependencies [65205f90]
  - @redux-devtools/app@4.0.1
  - @redux-devtools/core@3.13.2

## 3.1.4

### Patch Changes

- Updated dependencies [e57bcb39]
  - @redux-devtools/app@4.0.0

## 3.1.3

### Patch Changes

- bca76009: Fix missing CSS for code editor

## 3.1.2

### Patch Changes

- 64ed81b0: Fix extension in Firefox and Chrome Incognito

## 3.1.1

### Patch Changes

- d18525b5: Increase min-width of popup
- Updated dependencies [57751ff9]
  - @redux-devtools/app@3.0.0

## 3.1.0

### Minor Changes

- d54adb76: Option to sort State Tree keys alphabetically
  Option to disable collapsing of object keys

### Patch Changes

- @redux-devtools/app@2.2.2

## 3.0.19

### Patch Changes

- 450cde6e: Fix responsive layout

## 3.0.18

### Patch Changes

- Updated dependencies [81926f32]
  - react-json-tree@0.18.0
  - @redux-devtools/app@2.2.1

## 3.0.17

### Patch Changes

- 1aa6c4f7: Fix remounting root for devpanel

## 3.0.16

### Patch Changes

- 20ebf725: Remove source map from page wrap bundle

## 3.0.14

### Patch Changes

- 24f60a7a: bump min popup window width to 760px #1126 #1129

## 3.0.13

### Patch Changes

- Updated dependencies [8a7eae4]
  - react-json-tree@0.17.0
  - @redux-devtools/app@2.2.0
  - @redux-devtools/slider-monitor@4.0.0
  - @redux-devtools/ui@1.3.0
  - @redux-devtools/core@3.13.0
  - @redux-devtools/utils@2.0.0

## 3.0.12

### Patch Changes

- Updated dependencies [4891bf6]
  - @redux-devtools/core@3.12.0
  - @redux-devtools/slider-monitor@3.1.2
  - @redux-devtools/utils@1.2.1
  - @redux-devtools/app@2.1.4

## 3.0.11

### Patch Changes

- ab3c0e2: Avoid persisting the selected action index between sessions
- Updated dependencies [ab3c0e2]
- Updated dependencies [4c9a890]
  - @redux-devtools/app@2.1.3
  - react-json-tree@0.16.2

## 3.0.10

### Patch Changes

- 55cc37e: Fix filter to show state-controlled search value
- Updated dependencies [55cc37e]
  - @redux-devtools/app@2.1.2
