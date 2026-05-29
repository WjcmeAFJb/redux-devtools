import { resolveSourcePath } from '../src/openFile.js';
import StackFrame from '../src/react-error-overlay/utils/stack-frame.js';

function frame(
  compiled: string | null,
  source: string | null,
): StackFrame {
  return new StackFrame(
    null,
    compiled,
    1,
    1,
    null,
    null,
    source,
    1,
    1,
    null,
  );
}

describe('resolveSourcePath', () => {
  it('treats a Vite absolute source-map path as an absolute fs path', () => {
    // Vite dev server: served URL is short, source map contains the full disk path.
    const f = frame(
      'http://localhost:5173/src/some/path/file.tsx?t=12345678',
      '/home/user/my-project/src/some/path/file.tsx',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/home/user/my-project/src/some/path/file.tsx',
      isAbsolute: true,
    });
  });

  it('treats a URL-pathname source as project-relative', () => {
    const f = frame(
      'http://localhost:5173/src/some/path/file.tsx?t=12345678',
      '/src/some/path/file.tsx',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/src/some/path/file.tsx',
      isAbsolute: false,
    });
  });

  it('uses the URL pathname when the source map only contains a basename suffix', () => {
    // Reproduces the user's reported bug: source map only had `file.tsx`, so the
    // editor used to open `/projectPath/file.tsx` instead of the full path.
    const f = frame(
      'http://localhost:5173/src/some/path/file.tsx?t=12345678',
      '/file.tsx',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/src/some/path/file.tsx',
      isAbsolute: false,
    });
  });

  it('resolves a relative source path against the compiled URL directory', () => {
    const f = frame(
      'http://localhost:5173/src/some/path/file.tsx?t=12345678',
      'file.tsx',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/src/some/path/file.tsx',
      isAbsolute: false,
    });
  });

  it('resolves ../ in relative source paths', () => {
    const f = frame(
      'http://localhost:5173/dist/main.js',
      '../src/file.tsx',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/src/file.tsx',
      isAbsolute: false,
    });
  });

  it('handles webpack:// scheme by stripping it', () => {
    const f = frame(
      'http://localhost:5173/dist/main.js',
      'webpack:///./src/file.tsx',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/src/file.tsx',
      isAbsolute: false,
    });
  });

  it('normalizes the ~/ tilde-prefix to /node_modules/', () => {
    const f = frame(
      'http://localhost:5173/dist/main.js',
      '/~/some-pkg/index.js',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/node_modules/some-pkg/index.js',
      isAbsolute: false,
    });
  });

  it('detects file:// URLs as absolute fs paths', () => {
    const f = frame(
      'http://localhost:5173/src/file.tsx',
      'file:///home/user/project/src/file.tsx',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/home/user/project/src/file.tsx',
      isAbsolute: true,
    });
  });

  it('detects Windows-style absolute paths', () => {
    const f = frame(
      'http://localhost:5173/src/file.tsx',
      'C:\\Users\\me\\project\\src\\file.tsx',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: 'C:\\Users\\me\\project\\src\\file.tsx',
      isAbsolute: true,
    });
  });

  it('strips ?query and #fragment from absolute-looking paths too', () => {
    const f = frame(
      'http://localhost:5173/src/file.tsx?t=12345678',
      '/src/file.tsx?t=12345678',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/src/file.tsx',
      isAbsolute: false,
    });
  });

  it('falls back to the compiled URL pathname when there is no original path', () => {
    const f = frame(
      'http://localhost:5173/src/file.tsx?t=12345678',
      null,
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/src/file.tsx',
      isAbsolute: false,
    });
  });

  it('treats a source path with a different file but same depth as project-relative', () => {
    // Source map can point to a different file than the served compiled URL
    // (e.g. when the compiled file inlines/imports the source). Trust the source map.
    const f = frame(
      'http://localhost:5173/src/foo.tsx?t=1',
      '/src/bar.tsx',
    );
    expect(resolveSourcePath(f)).toEqual({
      path: '/src/bar.tsx',
      isAbsolute: false,
    });
  });
});
