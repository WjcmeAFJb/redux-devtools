import StackFrame from './react-error-overlay/utils/stack-frame.js';

const isFF = navigator.userAgent.includes('Firefox');

function openResource(
  fileName: string,
  lineNumber: number,
  stackFrame: StackFrame,
) {
  const adjustedLineNumber = Math.max(lineNumber - 1, 0);
  chrome.devtools.panels.openResource(fileName, adjustedLineNumber, ((result: {
    isError?: boolean;
  }) => {
    //console.log("openResource callback args: ", callbackArgs);
    if (result.isError) {
      const { fileName: finalFileName, lineNumber: finalLineNumber } =
        stackFrame;
      const adjustedLineNumber = Math.max(finalLineNumber! - 1, 0);
      chrome.devtools.panels.openResource(
        finalFileName!,
        adjustedLineNumber,
        (/* result */) => {
          // console.log("openResource result: ", result);
        },
      );
    }
  }) as () => void);
}

function openAndCloseTab(url: string) {
  chrome.tabs.create({ url }, (tab) => {
    const removeTab = () => {
      chrome.windows.onFocusChanged.removeListener(removeTab);
      if (tab && tab.id) {
        chrome.tabs.remove(tab.id, () => {
          if (chrome.runtime.lastError) console.log(chrome.runtime.lastError);
          else if (chrome.devtools && chrome.devtools.inspectedWindow) {
            void chrome.tabs.update(chrome.devtools.inspectedWindow.tabId, {
              active: true,
            });
          }
        });
      }
    };
    if (chrome.windows) chrome.windows.onFocusChanged.addListener(removeTab);
  });
}

function openInIframe(url: string) {
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.display = 'none';
  document.body.appendChild(iframe);
  setTimeout(() => iframe.parentNode!.removeChild(iframe), 3000);
}

function stripUrlAndQuery(p: string): string {
  let result = p.replace(/^https?:\/\/[^/]*/, '');
  result = result.replace(/^webpack:\/\/[^/]*/, '');
  result = result.replace(/^\w+:\/\//, '');
  result = result.replace(/[?#].*$/, '');
  result = result.replace(/^\/\.\//, '/');
  return result;
}

function resolveRelative(baseDir: string, relative: string): string {
  if (!baseDir.endsWith('/')) baseDir += '/';
  while (relative.startsWith('./')) relative = relative.substring(2);
  let resolved = baseDir + relative;
  for (;;) {
    const m = /\/[^/]+\/\.\.\//.exec(resolved);
    if (!m) break;
    resolved =
      resolved.substring(0, m.index) + '/' + resolved.substring(m.index + m[0].length);
  }
  return resolved;
}

interface ResolvedPath {
  /** The resolved path. Either an absolute filesystem path or a path relative to the project root. */
  readonly path: string;
  /** When true, `path` is an absolute filesystem path; do not prepend the project root. */
  readonly isAbsolute: boolean;
}

export function resolveSourcePath(stackFrame: StackFrame): ResolvedPath {
  const compiled =
    stackFrame.fileName ||
    (stackFrame as unknown as { finalFileName?: string }).finalFileName ||
    '';
  // Webpack convention: ~/ at the start of a source path means /node_modules/
  let original = (stackFrame._originalFileName || '').replace(
    /^\/~\//,
    '/node_modules/',
  );

  if (/^[a-zA-Z]:[\\/]/.test(original)) {
    return { path: original, isAbsolute: true };
  }
  if (/^file:\/\//.test(original)) {
    return {
      path: original.replace(/^file:\/\/(localhost)?/, ''),
      isAbsolute: true,
    };
  }
  if (/^https?:\/\//.test(original) || /^\w+:\/\//.test(original)) {
    return { path: stripUrlAndQuery(original), isAbsolute: false };
  }

  original = original.replace(/[?#].*$/, '');
  const compiledPath = stripUrlAndQuery(compiled);

  if (!original) {
    return { path: compiledPath, isAbsolute: false };
  }

  if (!original.startsWith('/') && !original.startsWith('\\')) {
    const baseDir = compiledPath.substring(
      0,
      compiledPath.lastIndexOf('/') + 1,
    );
    return { path: resolveRelative(baseDir, original), isAbsolute: false };
  }

  // `original` starts with `/`: either an absolute filesystem path (e.g. Vite
  // dev-mode source maps store the on-disk path) or a path relative to the
  // project root that happens to match the dev server URL. Compare against the
  // served URL's pathname to tell them apart.
  if (compiledPath) {
    if (
      original.length > compiledPath.length &&
      original.endsWith(compiledPath)
    ) {
      return { path: original, isAbsolute: true };
    }
    if (
      original.length < compiledPath.length &&
      compiledPath.endsWith(original)
    ) {
      // The source map only carries a partial suffix (often just the basename);
      // the served URL has the full project-relative path.
      return { path: compiledPath, isAbsolute: false };
    }
    return { path: original, isAbsolute: false };
  }

  // Without a served URL to compare against, the absolute-looking path is our
  // only signal — trust it as an absolute filesystem path.
  return { path: original, isAbsolute: true };
}

function openInEditor(
  editor: string,
  projectPath: string,
  stackFrame: StackFrame,
) {
  const trimmedProjectPath = projectPath.replace(/\/$/, '');
  const { path: resolvedPath, isAbsolute } = resolveSourcePath(stackFrame);
  const fullPath = isAbsolute
    ? resolvedPath
    : `${trimmedProjectPath}${resolvedPath}`;
  const line = stackFrame._originalLineNumber || stackFrame.lineNumber || '0';
  const column =
    stackFrame._originalColumnNumber || stackFrame.columnNumber || '0';
  let url;

  switch (editor) {
    case 'vscode':
    case 'code':
      url = `vscode://file/${fullPath}:${line}:${column}`;
      break;
    case 'atom':
      url = `atom://core/open/file?filename=${fullPath}&line=${line}&column=${column}`;
      break;
    case 'webstorm':
    case 'phpstorm':
    case 'idea':
      url = `${editor}://open?file=${fullPath}&line=${line}&column=${column}`;
      break;
    default:
      // sublime, emacs, macvim, textmate + custom like https://github.com/eclemens/atom-url-handler
      url = `${editor}://open/?url=file://${fullPath}&line=${line}&column=${column}`;
  }
  if (chrome.devtools && !isFF) {
    if (chrome.tabs) openAndCloseTab(url);
    else window.open(url);
  } else {
    openInIframe(url);
  }
}

export default function openFile(
  fileName: string,
  lineNumber: number,
  stackFrame: StackFrame,
) {
  if (!chrome || !chrome.storage) return; // TODO: Pass editor settings for using outside of browser extension
  const storage = isFF
    ? chrome.storage.local
    : chrome.storage.sync || chrome.storage.local;
  storage.get(
    ['useEditor', 'editor', 'projectPath'],
    function ({ useEditor, editor, projectPath }) {
      const hasEditor =
        useEditor && typeof editor === 'string' && /^\w{1,30}$/.test(editor);
      // projectPath is only required when the source map doesn't already point
      // at an absolute filesystem path (e.g. Vite includes absolute source
      // paths by default, so users don't need to configure projectPath there).
      const canSkipProjectPath = resolveSourcePath(stackFrame).isAbsolute;
      if (hasEditor && (projectPath || canSkipProjectPath)) {
        openInEditor(
          editor.toLowerCase(),
          (projectPath as string) || '',
          stackFrame,
        );
      } else {
        if (
          chrome.devtools &&
          chrome.devtools.panels &&
          !!chrome.devtools.panels.openResource
        ) {
          openResource(fileName, lineNumber, stackFrame);
        } else if (chrome.runtime && (chrome.runtime.openOptionsPage || isFF)) {
          if (chrome.devtools && isFF) {
            chrome.devtools.inspectedWindow.eval(
              'confirm("Set the editor to open the file in?")',
              (result) => {
                if (!result) return;
                void chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
              },
            );
          } else if (confirm('Set the editor to open the file in?')) {
            void chrome.runtime.openOptionsPage();
          }
        }
      }
    },
  );
}
