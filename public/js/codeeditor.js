// Code editor for the file manager: Monaco, the editor VS Code is built on (MIT). Loaded on first
// use from /vendor/monaco (node_modules/monaco-editor/min), so it costs nothing until a file is
// opened and works offline. The language comes from the file name, like VS Code.
import { prefs } from './core.js';

let monacoP = null;

export function loadMonaco() {
  monacoP ??= new Promise((resolve, reject) => {
    const boot = () => {
      window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    if (window.require?.config) return boot();
    const s = document.createElement('script');
    s.src = '/vendor/monaco/vs/loader.js';
    s.onload = boot;
    s.onerror = () => reject(new Error('The code editor could not be loaded'));
    document.head.appendChild(s);
  }).then((monaco) => {
    setup(monaco);
    return monaco;
  });
  monacoP.catch(() => (monacoP = null));
  return monacoP;
}

const isDark = () => document.documentElement.dataset.theme !== 'light';
export const themeName = () => (isDark() ? 'sdc-dark' : 'sdc-light');

// SQL colours for the database query editor (only SQL tokens end in ".sql").
const SQL_DARK = [
  { token: 'keyword.sql', foreground: 'c084fc', fontStyle: 'bold' },
  { token: 'operator.sql', foreground: 'f472b6' },
  { token: 'predefined.sql', foreground: '38bdf8' },
  { token: 'string.sql', foreground: '4ade80' },
  { token: 'string.double.sql', foreground: '4ade80' },
  { token: 'number.sql', foreground: 'fb923c' },
  { token: 'comment.sql', foreground: '71717a', fontStyle: 'italic' },
  { token: 'comment.quote.sql', foreground: '71717a', fontStyle: 'italic' },
  { token: 'identifier.quote.sql', foreground: 'fcd34d' },
  { token: 'delimiter.sql', foreground: 'a1a1aa' },
  { token: 'delimiter.parenthesis.sql', foreground: 'e4e4e7' },
];
const SQL_LIGHT = [
  { token: 'keyword.sql', foreground: '7c3aed', fontStyle: 'bold' },
  { token: 'operator.sql', foreground: 'db2777' },
  { token: 'predefined.sql', foreground: '0284c7' },
  { token: 'string.sql', foreground: '16a34a' },
  { token: 'string.double.sql', foreground: '16a34a' },
  { token: 'number.sql', foreground: 'ea580c' },
  { token: 'comment.sql', foreground: 'a1a1aa', fontStyle: 'italic' },
  { token: 'comment.quote.sql', foreground: 'a1a1aa', fontStyle: 'italic' },
  { token: 'identifier.quote.sql', foreground: 'b45309' },
  { token: 'delimiter.sql', foreground: '71717a' },
];

function setup(monaco) {
  // VS Code's Dark+/Light+ colours, on the app's own surfaces.
  monaco.editor.defineTheme('sdc-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: SQL_DARK,
    colors: {
      'editor.background': '#0c0c0f',
      'editorGutter.background': '#0c0c0f',
      'editorLineNumber.foreground': '#52525b',
      'editorLineNumber.activeForeground': '#d4d4d8',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.lineHighlightBorder': '#00000000',
      'minimap.background': '#0c0c0f',
      'scrollbarSlider.background': '#ffffff1a',
      'scrollbarSlider.hoverBackground': '#ffffff2e',
    },
  });
  monaco.editor.defineTheme('sdc-light', {
    base: 'vs',
    inherit: true,
    rules: SQL_LIGHT,
    colors: {
      'editor.background': '#ffffff',
      'editorLineNumber.foreground': '#a1a1aa',
      'editorLineNumber.activeForeground': '#27272a',
      'editor.lineHighlightBackground': '#0000000a',
      'editor.lineHighlightBorder': '#00000000',
    },
  });
  // Files are opened one by one from a server, without their project: imports and types can't be
  // resolved, so only syntax errors are worth flagging (no "cannot find module" noise).
  const ts = monaco.typescript || monaco.languages.typescript;
  for (const d of [ts?.javascriptDefaults, ts?.typescriptDefaults]) {
    d?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSuggestionDiagnostics: true, noSyntaxValidation: false });
  }
  // Follow the app's light/dark theme.
  new MutationObserver(() => monaco.editor.setTheme(themeName())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/**
 * Create an editor in mount for a file. Returns a handle:
 *   { value(), setReadOnly(bool), focus(), language, dispose(), onChange(fn), onSave(fn), onCursor(fn) }
 */
export async function createCodeEditor(mount, { path, text, readOnly = true }) {
  const monaco = await loadMonaco();
  const uri = monaco.Uri.from({ scheme: 'sdc', path: `/${Math.random().toString(36).slice(2)}${path}` });
  const model = monaco.editor.createModel(text, undefined, uri);
  const editor = monaco.editor.create(mount, {
    model,
    readOnly,
    theme: themeName(),
    automaticLayout: true,
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: Number(prefs.get('fontSize')) || 13,
    lineHeight: 1.6,
    minimap: { enabled: true, renderCharacters: false, scale: 1, maxColumn: 80 },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    cursorBlinking: 'smooth',
    renderLineHighlight: 'all',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    stickyScroll: { enabled: true },
    padding: { top: 10, bottom: 10 },
    fixedOverflowWidgets: true,
    tabSize: 2,
    detectIndentation: true,
    wordWrap: 'off',
    domReadOnly: false,
    readOnlyMessage: { value: 'Click **Edit** to change this file.' },
  });
  const language = model.getLanguageId();
  const langName = monaco.languages.getLanguages().find((l) => l.id === language)?.aliases?.[0] || language;
  const handle = {
    language: langName,
    value: () => model.getValue(),
    setReadOnly: (v) => editor.updateOptions({ readOnly: v }),
    focus: () => editor.focus(),
    setFontSize: (n) => editor.updateOptions({ fontSize: n }),
    onChange: (fn) => model.onDidChangeContent(() => fn()),
    onSave: (fn) => editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, fn),
    onCursor: (fn) => editor.onDidChangeCursorPosition((e) => fn(e.position.lineNumber, e.position.column)),
    lineCount: () => model.getLineCount(),
    dispose() {
      editor.dispose();
      model.dispose();
    },
  };
  return handle;
}
