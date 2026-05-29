/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Strips dev-server cache busters (e.g. Vite's `?t=12345678`) and URL
// fragments so the display matches what the editor will open.
function stripQuery(name: string): string {
  return name.replace(/[?#].*$/, '');
}

function getPrettyURL(
  sourceFileName: string | null | undefined,
  sourceLineNumber: number | null | undefined,
  sourceColumnNumber: number | null | undefined,
  fileName: string | null | undefined,
  lineNumber: number | null | undefined,
  columnNumber: number | null | undefined,
  compiled: boolean,
): string {
  let prettyURL;
  if (!compiled && sourceFileName && typeof sourceLineNumber === 'number') {
    const cleanSourceFileName = stripQuery(sourceFileName);
    // Remove everything up to the first /src/ or /node_modules/
    const trimMatch = /^[/|\\].*?[/|\\]((src|node_modules)[/|\\].*)/.exec(
      cleanSourceFileName,
    );
    if (trimMatch && trimMatch[1]) {
      prettyURL = trimMatch[1];
    } else {
      prettyURL = cleanSourceFileName;
    }
    prettyURL += `:${sourceLineNumber}`;
    // Note: we intentionally skip 0's because they're produced by cheap Webpack maps
    if (sourceColumnNumber) {
      prettyURL += `:${sourceColumnNumber}`;
    }
  } else if (fileName && typeof lineNumber === 'number') {
    prettyURL = `${stripQuery(fileName)}:${lineNumber}`;
    // Note: we intentionally skip 0's because they're produced by cheap Webpack maps
    if (columnNumber) {
      prettyURL += `:${columnNumber}`;
    }
  } else {
    prettyURL = 'unknown';
  }
  return prettyURL.replace('webpack://', '.');
}

export { getPrettyURL };
export default getPrettyURL;
