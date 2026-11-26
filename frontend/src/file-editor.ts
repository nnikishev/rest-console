import { basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { toml } from '@codemirror/legacy-modes/mode/toml';

// Small bridge to keep the SFTP save/revision workflow independent of CodeMirror.
export class FileEditor {
  private language = new Compartment();
  private readonlyMode = new Compartment();
  private wrapping = new Compartment();
  private locked = true;
  private wrapMode = 'off';
  private extensions: Extension[];
  readonly view: EditorView;
  oninput: (() => void) | null = null;
  onclick: (() => void) | null = null;
  onkeyup: (() => void) | null = null;
  onkeydown: ((event: KeyboardEvent) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.extensions = [
      basicSetup, keymap.of([indentWithTab]),
      this.language.of([]), this.readonlyMode.of(EditorState.readOnly.of(true)), this.wrapping.of([]),
      EditorView.theme({
        '&': { height: '100%', backgroundColor: '#111416', color: '#dce3df' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Liberation Mono", monospace', fontSize: '14px', lineHeight: '1.65' },
        '.cm-content': { padding: '12px 0', caretColor: '#b5ed89' },
        '.cm-gutters': { backgroundColor: '#1c241e', color: '#829789', borderRight: '1px solid #39443d' },
        '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#b5ed890d' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#354439 !important' },
        '.cm-cursor': { borderLeftColor: '#b5ed89' },
        '.cm-panels': { backgroundColor: '#202a23', color: '#dce3df' },
      }, { dark: true }),
      EditorView.updateListener.of(update => {
        if (update.docChanged || update.selectionSet) this.oninput?.();
      }),
      EditorView.domEventHandlers({
        keydown: event => { this.onkeydown?.(event); return event.defaultPrevented; },
        keyup: () => { this.onkeyup?.(); },
        click: () => { this.onclick?.(); },
      }),
    ];
    this.view = new EditorView({ parent, state: EditorState.create({ extensions: this.extensions }) });
  }
  get value() { return this.view.state.doc.toString(); }
  set value(text: string) {
    const language = this.view.state;
    const document = text.replace(/\r\n?/g, '\n');
    // A fresh state prevents Undo from exposing the previous file's contents.
    const lang = this.language.get(language) || [];
    this.view.setState(EditorState.create({ doc: document, extensions: this.extensions }));
    this.view.dispatch({ effects: [this.language.reconfigure(lang),
      this.readonlyMode.reconfigure(EditorState.readOnly.of(this.locked)),
      this.wrapping.reconfigure(this.wrapMode === 'off' ? [] : EditorView.lineWrapping)] });
  }
  get selectionStart() { return this.view.state.selection.main.from; }
  get selectionEnd() { return this.view.state.selection.main.to; }
  get readOnly() { return this.locked; }
  set readOnly(value: boolean) {
    this.locked = value;
    this.view.dispatch({ effects: this.readonlyMode.reconfigure(EditorState.readOnly.of(value)) });
  }
  get wrap() { return this.wrapMode; }
  set wrap(value: string) {
    this.wrapMode = value;
    this.view.dispatch({ effects: this.wrapping.reconfigure(value === 'off' ? [] : EditorView.lineWrapping) });
  }
  setRangeText(text: string, from: number, to: number, _mode: string) {
    this.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  }
  focus() { this.view.focus(); }
  get lines() { return this.view.state.doc.lines; }
  get position() {
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    return { line: line.number, column: head - line.from + 1 };
  }
  goToLine(number: number) {
    const line = this.view.state.doc.line(Math.max(1, Math.min(this.lines, number)));
    this.view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    this.focus();
  }
  setLanguage(path: string) {
    const name = path.split('/').pop()!.toLowerCase();
    const ext = name.split('.').pop();
    let extension: Extension = [];
    let label = 'Текст';
    if (name === '.env' || name.startsWith('.env.') || ext === 'env') { extension = StreamLanguage.define(shell); label = 'ENV'; }
    else if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(ext!)) { extension = javascript({ typescript: ['ts', 'tsx'].includes(ext!), jsx: ['jsx', 'tsx'].includes(ext!) }); label = 'JavaScript / TypeScript'; }
    else if (ext === 'py') { extension = python(); label = 'Python'; }
    else if (['json', 'jsonl'].includes(ext!)) { extension = json(); label = 'JSON'; }
    else if (['html', 'htm'].includes(ext!)) { extension = html(); label = 'HTML'; }
    else if (ext === 'css') { extension = css(); label = 'CSS'; }
    else if (['yaml', 'yml'].includes(ext!)) { extension = yaml(); label = 'YAML'; }
    else if (ext === 'sql') { extension = sql(); label = 'SQL'; }
    else if (ext === 'toml') { extension = StreamLanguage.define(toml); label = 'TOML'; }
    else if (['sh', 'bash', 'zsh'].includes(ext!) || ['.bashrc', '.profile', '.zshrc'].includes(name)) { extension = StreamLanguage.define(shell); label = 'Shell'; }
    else if (['ini', 'conf', 'cfg', 'properties', 'service', 'socket', 'timer'].includes(ext!)) { extension = StreamLanguage.define(properties); label = 'Конфигурация'; }
    this.view.dispatch({ effects: this.language.reconfigure(extension) });
    return label;
  }
}
