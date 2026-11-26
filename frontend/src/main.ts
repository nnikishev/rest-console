import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { FileEditor } from './file-editor';
import './workspace.css';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const form = el<HTMLFormElement>('connection-form');
const connect = el<HTMLButtonElement>('connect');
const disconnect = el<HTMLButtonElement>('disconnect');
const password = el<HTMLInputElement>('password');
const key = el<HTMLInputElement>('key');
const dialog = el<HTMLDialogElement>('verify-dialog');
type Session = {
  id: number; title: string; terminal: Terminal; fit: FitAddon; node: HTMLDivElement;
  socket: WebSocket | null; connected: boolean; busy: boolean; pending: Record<string, unknown> | null;
  notice: string; error: boolean; hasOutput: boolean; path: string; files: { name: string; directory: boolean; size: number }[];
  services: string[]; servicesLoaded: boolean;
  requests: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: number }>;
};
const sessions: Session[] = [];
let active: Session;
let nextSession = 0;
let nextRequest = 0;
let verifying: Session | null = null;
let sftpVisible = false;
let commandsVisible = false;
type QuickCommand = { id?: number; category: string; name: string; command: string };
let customCommands: QuickCommand[] = [];
let saving = false;
let keyMode = false;
let savedKeyId: number | null = null;

type SavedConnection = {
  id: number; has_key: boolean; name: string; host: string; port: number; username: string; auth_method: 'password' | 'key';
};
const csrf = el<HTMLInputElement>('connection-form').querySelector<HTMLInputElement>('[name=csrfmiddlewaretoken]')!.value;
const localServer = JSON.parse(el('local-ssh-config').textContent || '{}');

async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(path, {
    method, credentials: 'same-origin', headers: { 'X-CSRFToken': csrf, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Не удалось выполнить действие. Проверьте поля и авторизацию.');
  }
  return response.json();
}
function fillConnection(connection: { host: string; port: number; username: string; auth_method?: string; name?: string; id?: number; has_key?: boolean }) {
  if (saving) return;
  if (active.connected || active.busy) newSession();
  el<HTMLInputElement>('host').value = connection.host;
  el<HTMLInputElement>('port').value = String(connection.port);
  el<HTMLInputElement>('username').value = connection.username;
  el<HTMLInputElement>('bookmark-name').value = connection.name || '';
  password.value = '';
  key.value = '';
  savedKeyId = connection.has_key && connection.id ? connection.id : null;
  el<HTMLInputElement>('save-key').checked = false;
  el('saved-key-status').textContent = savedKeyId ? 'Ключ сохранён. Для замены в текущем сеансе выберите другой файл.' : '';
  el('key-name').textContent = savedKeyId ? 'Используется сохранённый ключ' : 'Выберите приватный ключ';
  setMode(connection.auth_method === 'key');
  message('Параметры заполнены. Укажите пароль или приватный ключ и нажмите «Подключиться».');
  (connection.username ? password : el<HTMLInputElement>('username')).focus();
}
async function loadBookmarks() {
  const data = await api('/api/connections/');
  const list = el('bookmarks-list');
  list.replaceChildren();
  if (!data.connections.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Закладок пока нет.';
    list.append(empty);
  }
  for (const connection of data.connections as SavedConnection[]) {
    const row = document.createElement('div');
    row.className = 'bookmark-row';
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'bookmark-select';
    const title = document.createElement('strong');
    title.textContent = connection.name;
    const detail = document.createElement('span');
    detail.textContent = `${connection.username}@${connection.host}:${connection.port} · ${connection.auth_method === 'key' ? (connection.has_key ? 'сохранённый ключ' : 'ключ') : 'пароль'}`;
    select.append(title, detail);
    select.disabled = saving;
    select.onclick = () => fillConnection(connection);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quiet';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Удалить закладку ${connection.name}`);
    remove.onclick = async () => {
      if (!window.confirm(`Удалить закладку «${connection.name}»?`)) return;
      remove.disabled = true;
      try { await api(`/api/connections/${connection.id}/`, 'DELETE'); await loadBookmarks(); }
      catch (error) { message((error as Error).message, true); remove.disabled = false; }
    };
    row.append(select, remove);
    list.append(row);
  }
}
for (const id of ['host', 'port', 'username']) {
  el(id).addEventListener('input', () => {
    savedKeyId = null;
    el('saved-key-status').textContent = '';
    el('key-name').textContent = key.files?.[0]?.name || 'Выберите приватный ключ';
  });
}
el('local-server').onclick = () => fillConnection(localServer);
el('save-bookmark').onclick = async () => {
  if (saving) return;
  const button = el<HTMLButtonElement>('save-bookmark');
  const name = el<HTMLInputElement>('bookmark-name').value.trim();
  if (!name) { message('Укажите название закладки.', true); return; }
  if (!form.reportValidity()) return;
  saving = true;
  button.disabled = true;
  try {
    const saveKey = keyMode && el<HTMLInputElement>('save-key').checked;
    const file = key.files?.[0];
    if (saveKey && !file) throw new Error('Для сохранения ключа выберите файл приватного ключа.');
    if (saveKey && file && file.size > 65536) throw new Error('Размер ключа не должен превышать 64 КБ.');
    await api('/api/connections/', 'POST', {
      name, host: el<HTMLInputElement>('host').value.trim(), port: Number(el<HTMLInputElement>('port').value),
      save_key: saveKey, ...(saveKey && file ? { key: await file.text() } : {}),
      username: el<HTMLInputElement>('username').value.trim(), auth_method: keyMode ? 'key' : 'password',
    });
    await loadBookmarks();
    message(saveKey ? 'Подключение и зашифрованный ключ сохранены. Парольная фраза не сохраняется.' : 'Подключение сохранено без ключа и пароля.');
  } catch (error) { message((error as Error).message, true); }
  finally { saving = false; button.disabled = false; }
};
loadBookmarks().catch(error => message(error.message, true));

function message(text: string, error = false) {
  el('message').textContent = text;
  el('message').classList.toggle('error', error);
}
function render() {
  el('session-tabs').replaceChildren();
  for (const session of sessions) {
    const row = document.createElement('div');
    row.className = 'session-tab';
    const button = document.createElement('button');
    button.textContent = `${session.connected ? '●' : session.busy ? '◌' : '○'} ${session.title}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(session === active));
    button.onclick = () => activate(session);
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', `Закрыть ${session.title}`);
    close.onclick = () => closeSession(session);
    row.append(button, close);
    el('session-tabs').append(row);
  }
  connect.disabled = active.busy;
  connect.firstChild!.textContent = active.connected ? 'Подключить в новой вкладке ' : 'Подключиться ';
  disconnect.disabled = !active.connected;
  el('status').textContent = active.connected ? 'CONNECTED' : active.busy ? 'CONNECTING' : 'OFFLINE';
  el('status').classList.toggle('online', active.connected);
  el('session-title').textContent = active.title;
  el('empty').hidden = active.connected || active.hasOutput;
  message(active.notice, active.error);
}
function send(session: Session, data: unknown) {
  if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(data));
}
function resize() {
  if (!active || !active.node.clientWidth || !active.node.clientHeight) return;
  active.fit.fit();
  el('size').textContent = `${active.terminal.cols} × ${active.terminal.rows}`;
  if (active.connected) send(active, { type: 'resize', cols: active.terminal.cols, rows: active.terminal.rows });
}
function activate(session: Session) {
  active = session;
  for (const item of sessions) item.node.hidden = item !== active;
  render();
  renderFiles();
  renderCommands();
  if (commandsVisible && session.connected && !session.servicesLoaded) void loadServices(session);
  if (sftpVisible && session.connected) void listFiles(session);
  requestAnimationFrame(() => { resize(); active.terminal.focus(); });
}
function newSession() {
  const terminal = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000,
    fontFamily: 'Consolas, "Liberation Mono", monospace',
    theme: { background: '#111416', foreground: '#dce3df', cursor: '#b5ed89' } });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  const node = document.createElement('div');
  node.className = 'terminal-instance';
  el('terminal').append(node);
  terminal.open(node);
  const session: Session = { id: ++nextSession, title: 'Новая сессия', terminal, fit, node,
    socket: null, connected: false, busy: false, pending: null, notice: 'Введите данные подключения.',
    error: false, hasOutput: false, path: '.', files: [], services: [], servicesLoaded: false, requests: new Map() };
  terminal.onData(data => { if (session.connected) send(session, { type: 'input', data }); });
  sessions.push(session);
  activate(session);
  return session;
}
function clearRequests(session: Session) {
  for (const request of session.requests.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('Соединение закрыто.'));
  }
  session.requests.clear();
}
function closeSession(session: Session) {
  if ((session.connected || session.busy) && !confirm('Закрыть вкладку и завершить SSH-сессию?')) return;
  if (verifying === session) { verifying = null; dialog.close(); }
  session.pending = null;
  session.socket?.close();
  clearRequests(session);
  sessions.splice(sessions.indexOf(session), 1);
  session.terminal.dispose();
  session.node.remove();
  if (!sessions.length) newSession();
  else activate(active === session ? sessions[sessions.length - 1] : active);
  showVerification();
}
function notice(session: Session, text: string, error = false) {
  session.notice = text;
  session.error = error;
  render();
  renderCommands();
}
function showVerification() {
  if (verifying) return;
  const session = sessions.find(item => item.busy && item.pending?.fingerprint);
  if (!session) return;
  verifying = session;
  el('fingerprint').textContent = `${session.title}\n${session.pending!.fingerprint}`;
  dialog.showModal();
}
function setMode(useKey: boolean) {
  keyMode = useKey;
  el('key-fields').hidden = !useKey;
  el('password-label').textContent = useKey ? 'Парольная фраза (если есть)' : 'Пароль';
  for (const [id, selected] of [['password-tab', !useKey], ['key-tab', useKey]] as const) {
    el(id).classList.toggle('active', selected);
    el(id).setAttribute('aria-pressed', String(selected));
  }
}
el('password-tab').onclick = () => setMode(false);
el('key-tab').onclick = () => setMode(true);
key.onchange = () => { el('key-name').textContent = key.files?.[0]?.name || 'Выберите приватный ключ'; };

form.onsubmit = async event => {
  event.preventDefault();
  if (active.busy) return;
  const session = active.connected ? newSession() : active;
  session.busy = true;
  render();
  try {
    const file = key.files?.[0];
    if (keyMode && !file && !savedKeyId) throw new Error('Выберите приватный ключ.');
    if (file && file.size > 65536) throw new Error('Размер ключа не должен превышать 64 КБ.');
    const host = el<HTMLInputElement>('host').value.trim();
    const username = el<HTMLInputElement>('username').value.trim();
    const payload = { type: 'connect', host, username, port: Number(el<HTMLInputElement>('port').value),
      ...(keyMode && !file && savedKeyId ? { saved_connection_id: savedKeyId } : {}),
      password: password.value, key: keyMode && file ? await file.text() : '',
      cols: session.terminal.cols, rows: session.terminal.rows };
    if (!sessions.includes(session)) return;
    session.pending = payload;
    password.value = '';
    key.value = '';
    el<HTMLInputElement>('save-key').checked = false;
    session.socket?.close();
    session.title = `${username}@${host}`;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal/`);
    session.socket = ws;
    session.terminal.reset();
    session.hasOutput = false;
    session.files = []; session.path = '.';
    session.services = []; session.servicesLoaded = false;
    renderFiles();
    notice(session, 'Устанавливаем защищённое соединение…');
    ws.onopen = () => send(session, session.pending);
    ws.onmessage = event => {
      if (session.socket !== ws || !sessions.includes(session)) return;
      const data = JSON.parse(event.data);
      if (data.type === 'sftp') {
        const request = session.requests.get(data.id);
        if (request) {
          clearTimeout(request.timer); session.requests.delete(data.id);
          if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
        }
      } else if (data.type === 'verify') {
        if (session.pending) session.pending.fingerprint = data.fingerprint;
        showVerification();
      } else if (data.type === 'connected') {
        session.pending = null; session.connected = true; session.busy = false;
        notice(session, 'Соединение установлено.');
        if (session === active) { resize(); session.terminal.focus(); if (sftpVisible) void listFiles(session); if (commandsVisible) void loadServices(session); }
      } else if (data.type === 'output') {
        session.hasOutput = true;
        session.terminal.write(data.data);
      } else if (data.type === 'error' || data.type === 'closed') {
        session.pending = null; session.connected = false; session.busy = false;
        clearRequests(session);
        if (verifying === session) { verifying = null; dialog.close(); showVerification(); }
        notice(session, data.message || 'Сессия завершена.', data.type === 'error');
      }
    };
    ws.onclose = () => {
      if (session.socket !== ws || !sessions.includes(session)) return;
      session.pending = null; session.connected = false; session.busy = false;
      clearRequests(session);
      if (verifying === session) { verifying = null; dialog.close(); showVerification(); }
      notice(session, 'WebSocket закрыт. Подключитесь заново.');
    };
    ws.onerror = () => notice(session, 'Ошибка WebSocket. Проверьте авторизацию и подключение.', true);
  } catch (error) {
    session.pending = null; session.busy = false;
    notice(session, error instanceof Error ? error.message : 'Ошибка подключения.', true);
  }
};
el('trust-host').onclick = () => {
  const session = verifying;
  verifying = null; dialog.close();
  if (session?.pending) { send(session, session.pending); delete session.pending.fingerprint; }
  showVerification();
};
function reject() {
  const session = verifying;
  verifying = null; dialog.close();
  if (session) { session.pending = null; session.busy = false; session.socket?.close(); }
  render(); showVerification();
}
el('reject-host').onclick = reject;
dialog.addEventListener('cancel', event => { event.preventDefault(); reject(); });
disconnect.onclick = () => send(active, { type: 'disconnect' });
el('new-session').onclick = () => { newSession(); setMenu(true); };
function setMenu(open: boolean) {
  el('connection-menu').hidden = !open;
  el('toggle-menu').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('menu-closed', !open);
  requestAnimationFrame(resize);
}
el('toggle-menu').onclick = () => setMenu(el('connection-menu').hidden);

function sftpRequest(session: Session, data: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!session.connected) { reject(new Error('Сначала подключитесь к SSH.')); return; }
    const id = ++nextRequest;
    const timer = window.setTimeout(() => { session.requests.delete(id); reject(new Error('Тайм-аут SFTP.')); }, 60000);
    session.requests.set(id, { resolve, reject, timer });
    send(session, { type: 'sftp', id, ...data });
  });
}
function sftpMessage(session: Session, text: string) {
  if (session === active) el('sftp-message').textContent = text;
}
async function listFiles(session: Session, path = session.path) {
  sftpMessage(session, 'Загрузка каталога…');
  try {
    const result = await sftpRequest(session, { action: 'list', path });
    session.path = result.path; session.files = result.entries;
    if (session === active) renderFiles();
    sftpMessage(session, `${session.files.length} записей`);
  } catch (error) { sftpMessage(session, (error as Error).message); }
}
function joinPath(path: string, name: string) { return `${path.replace(/\/$/, '')}/${name}`; }
let previewVersion = 0;
const previewDialog = el<HTMLDialogElement>('preview-dialog');
const editor = new FileEditor(el('preview-content'));
const saveFileButton = el<HTMLButtonElement>('preview-save');
let editing: { session: Session; path: string; revision: string; original: string; crlf: boolean } | null = null;
let fileSaving = false;
function editorDirty() { return editing !== null && editor.value !== editing.original; }
function updateEditor() {
  saveFileButton.disabled = fileSaving || editor.readOnly || !editorDirty();
  const position = editor.position;
  el('editor-position').textContent = `Строка ${position.line}, столбец ${position.column} · Всего строк: ${editor.lines}${editorDirty() ? ' · Есть изменения' : ''}`;
  el<HTMLInputElement>('editor-line').max = String(editor.lines);
}
function closeEditor() {
  if (fileSaving) return;
  if (editorDirty() && !confirm('Закрыть файл без сохранения изменений?')) return;
  previewDialog.close();
}
el('preview-close').onclick = closeEditor;
previewDialog.addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
previewDialog.addEventListener('close', () => {
  previewVersion++; editing = null; editor.value = ''; updateEditor();
});
function positionEditor() {
  if (!previewDialog.open) return;
  const rect = document.querySelector('.terminal-panel')!.getBoundingClientRect();
  Object.assign(previewDialog.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}
new ResizeObserver(positionEditor).observe(document.querySelector('.terminal-panel')!);
window.addEventListener('resize', positionEditor);
el('preview-wrap').onclick = () => {
  const wrap = editor.wrap === 'off'; editor.wrap = wrap ? 'soft' : 'off';
  el('preview-wrap').setAttribute('aria-pressed', String(wrap));
};
editor.oninput = updateEditor;
editor.onclick = updateEditor;
editor.onkeyup = updateEditor;
editor.onkeydown = event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); void saveEditedFile();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
    event.preventDefault();
    el<HTMLInputElement>('editor-line').focus(); el<HTMLInputElement>('editor-line').select();
  } else if (event.key === 'Tab' && !editor.readOnly) {
    event.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); updateEditor();
  }
};
async function saveEditedFile() {
  const target = editing;
  if (!target || saveFileButton.disabled) return;
  if (!confirm(`Сохранить изменения на ${target.session.title}?\n${target.path}`)) return;
  fileSaving = true; editor.readOnly = true; updateEditor();
  const value = editor.value;
  el('preview-note').textContent = 'Сохранение…';
  try {
    const text = target.crlf ? value.replace(/\n/g, '\r\n') : value;
    const result = await sftpRequest(target.session, { action: 'save', path: target.path, revision: target.revision, text });
    target.revision = result.revision; target.original = value;
    el('preview-note').textContent = 'Сохранено на сервере · UTF-8';
  } catch (error) { el('preview-note').textContent = (error as Error).message; }
  finally { fileSaving = false; editor.readOnly = false; updateEditor(); }
}
el<HTMLFormElement>('editor-goto').onsubmit = event => {
  event.preventDefault();
  const input = el<HTMLInputElement>('editor-line');
  if (input.reportValidity()) editor.goToLine(Number(input.value));
};
saveFileButton.onclick = () => { void saveEditedFile(); };
window.addEventListener('beforeunload', event => {
  if (editorDirty() || fileSaving) { event.preventDefault(); event.returnValue = ''; }
});
async function previewFile(session: Session, path: string) {
  if (fileSaving || (editorDirty() && !confirm('Открыть другой файл без сохранения изменений?'))) return;
  const version = ++previewVersion;
  editing = null; editor.readOnly = true; editor.value = ''; updateEditor();
  el('editor-language').textContent = editor.setLanguage(path);
  el('preview-title').textContent = `${session.title} · ${path}`;
  el('preview-note').textContent = 'Загрузка…';
  if (!previewDialog.open) previewDialog.showModal();
  positionEditor();
  try {
    const result = await sftpRequest(session, { action: 'preview', path });
    if (version !== previewVersion || !previewDialog.open) return;
    const bytes = Uint8Array.from(atob(result.content), char => char.charCodeAt(0));
    let text: string;
    let valid = true;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { text = new TextDecoder('utf-8').decode(bytes); valid = false; }
    const binary = /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
    const crlf = text.includes('\r\n');
    const mixedNewlines = /\r(?!\n)/.test(text) || (crlf && /(?<!\r)\n/.test(text));
    editor.value = text;
    if (valid && !binary && !result.truncated && !mixedNewlines && result.revision) {
      editing = { session, path, revision: result.revision, original: editor.value, crlf };
      editor.readOnly = false;
      el('preview-note').textContent = 'Редактирование · UTF-8 · Сохранение на сервер: Ctrl+S';
    } else {
      el('preview-note').textContent = `Только чтение${result.truncated ? ` · Файл обрезан до ${Math.round(result.limit / 1024)} КиБ` : ''}${!valid || binary ? ' · Бинарный файл или кодировка не UTF-8' : ''}${mixedNewlines ? ' · Смешанные переводы строк' : ''}`;
    }
    updateEditor(); editor.focus();
  } catch (error) {
    if (version === previewVersion) el('preview-note').textContent = (error as Error).message;
  }
}
function renderFiles() {
  el<HTMLInputElement>('sftp-path').value = active.path;
  el('sftp-message').textContent = active.connected ? '' : 'Подключитесь к SSH для работы с файлами.';
  const list = el('sftp-files'); list.replaceChildren();
  const session = active;
  for (const file of session.files) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const button = document.createElement('button');
    button.className = 'file-entry';
    button.textContent = `${file.directory ? '📁' : '▤'} ${file.name}${file.directory ? '' : ` · ${file.size} Б`}`;
    button.disabled = !session.connected;
    const path = joinPath(session.path, file.name);
    button.onclick = () => {
      if (file.directory) void listFiles(session, path);
      else void previewFile(session, path);
    };
    const download = document.createElement('button');
    download.className = 'file-download quiet';
    download.textContent = '↓ Скачать';
    download.setAttribute('aria-label', `Скачать ${file.name}${file.directory ? ' как ZIP' : ''}`);
    download.disabled = !session.connected;
    download.onclick = async () => {
      download.disabled = true;
      sftpMessage(session, file.directory ? 'Создание ZIP (символические ссылки пропускаются)…' : 'Скачивание…');
      try {
        const result = await sftpRequest(session, { action: file.directory ? 'archive' : 'download', path });
        const bytes = Uint8Array.from(atob(result.content), char => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const link = document.createElement('a'); link.href = url; link.download = result.name;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        sftpMessage(session, file.directory ? 'ZIP скачан. Символические ссылки и специальные файлы пропущены.' : 'Файл скачан.');
      } catch (error) { sftpMessage(session, (error as Error).message); }
      finally { download.disabled = !session.connected; }
    };
    row.append(button, download);
    list.append(row);
  }
}
el('toggle-sftp').onclick = () => {
  sftpVisible = !sftpVisible;
  if (sftpVisible) {
    commandsVisible = false; el('commands-panel').hidden = true;
    el('toggle-commands').setAttribute('aria-expanded', 'false');
  }
  el('sftp-panel').hidden = !sftpVisible;
  el('toggle-sftp').setAttribute('aria-expanded', String(sftpVisible));
  if (sftpVisible && active.connected) void listFiles(active);
  requestAnimationFrame(resize);
};
el<HTMLFormElement>('sftp-form').onsubmit = event => {
  event.preventDefault(); void listFiles(active, el<HTMLInputElement>('sftp-path').value);
};
el('sftp-parent').onclick = () => { void listFiles(active, joinPath(active.path, '..')); };
el<HTMLInputElement>('sftp-upload').onchange = async event => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; const session = active;
  input.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { sftpMessage(session, 'Максимальный размер файла — 5 МиБ.'); return; }
  if (!confirm(`Загрузить «${file.name}» в ${session.path}?`)) return;
  const path = joinPath(session.path, file.name);
  sftpMessage(session, 'Загрузка файла…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    await sftpRequest(session, { action: 'upload', path, content: btoa(binary) });
    await listFiles(session);
  } catch (error) { sftpMessage(session, (error as Error).message); }
};
async function loadCommands() {
  const result = await api('/api/quick-commands/');
  customCommands = result.commands;
  renderCommands();
}
function commandsMessage(session: Session, text: string) {
  if (session === active) el('commands-message').textContent = text;
}
async function loadServices(session: Session) {
  commandsMessage(session, 'Читаем /etc/systemd/system…');
  try {
    const result = await sftpRequest(session, { action: 'services' });
    session.services = result.services; session.servicesLoaded = true;
    if (session === active) renderCommands();
    commandsMessage(session, `Найдено сервисов: ${session.services.length}`);
  } catch (error) { commandsMessage(session, (error as Error).message); }
}
function renderCommands() {
  const list = el('commands-list'); list.replaceChildren();
  const session = active;
  const commands: QuickCommand[] = [
    ...session.services.flatMap(service => [
      { category: 'Статус сервисов', name: service,
        command: `sudo systemctl status '${service}' --no-pager -l` },
      { category: 'Последние логи · 150 строк', name: service,
        command: `sudo journalctl -u '${service}' -n 150 --no-pager` },
      { category: 'Следить за логами', name: service,
        command: `sudo journalctl -u '${service}' -n 150 -f --no-pager` },
    ]), ...customCommands,
  ];
  const query = el<HTMLInputElement>('command-search').value.trim().toLocaleLowerCase();
  const categories = new Map<string, QuickCommand[]>();
  for (const command of commands) {
    if (!`${command.category} ${command.name} ${command.command}`.toLocaleLowerCase().includes(query)) continue;
    const group = categories.get(command.category) || [];
    group.push(command); categories.set(command.category, group);
  }
  for (const [category, items] of categories) {
    const group = document.createElement('details'); group.className = 'command-group'; group.open = true;
    const heading = document.createElement('summary'); heading.textContent = `${category} (${items.length})`;
    group.append(heading);
    for (const command of items) {
      const row = document.createElement('div'); row.className = 'command-row';
      const run = document.createElement('button'); run.className = 'command-run'; run.disabled = !session.connected;
      const title = document.createElement('strong'); title.textContent = `▶ ${command.name}`;
      const code = document.createElement('code'); code.textContent = command.command;
      run.append(title, code);
      run.onclick = () => {
        if (active !== session || !session.connected) return;
        if (!confirm(`Отправить команду в ${session.title}?\n\n${command.command}\n\nУбедитесь, что терминал находится в командной оболочке, а не в редакторе или запросе пароля.`)) return;
        send(session, { type: 'input', data: command.command + '\r' });
        session.terminal.focus();
        commandsMessage(session, 'Команда отправлена. Если sudo запросит пароль, введите его в терминале.');
      };
      row.append(run);
      if (command.id !== undefined) {
        const remove = document.createElement('button'); remove.className = 'quiet'; remove.textContent = '×';
        remove.setAttribute('aria-label', `Удалить команду ${command.name}`);
        remove.onclick = async () => {
          if (!confirm(`Удалить команду «${command.name}»?`)) return;
          try { await api(`/api/quick-commands/${command.id}/`, 'DELETE'); await loadCommands(); }
          catch (error) { commandsMessage(session, (error as Error).message); }
        };
        row.append(remove);
      }
      group.append(row);
    }
    list.append(group);
  }
  if (!categories.size) {
    const empty = document.createElement('p'); empty.className = 'hint';
    empty.textContent = 'Команд не найдено. Загрузите сервисы или добавьте свою команду.'; list.append(empty);
  }
  const datalist = el('command-categories'); datalist.replaceChildren();
  for (const category of new Set(customCommands.map(command => command.category))) {
    const option = document.createElement('option'); option.value = category; datalist.append(option);
  }
}
el('command-search').oninput = renderCommands;
el('refresh-services').onclick = () => { void loadServices(active); };
el('toggle-commands').onclick = () => {
  commandsVisible = !commandsVisible;
  el('commands-panel').hidden = !commandsVisible;
  el('toggle-commands').setAttribute('aria-expanded', String(commandsVisible));
  if (commandsVisible) {
    sftpVisible = false; el('sftp-panel').hidden = true;
    el('toggle-sftp').setAttribute('aria-expanded', 'false');
    renderCommands();
    if (active.connected && !active.servicesLoaded) void loadServices(active);
  }
  requestAnimationFrame(resize);
};
el<HTMLFormElement>('command-form').onsubmit = async event => {
  event.preventDefault();
  const button = el<HTMLButtonElement>('command-save'); button.disabled = true;
  try {
    await api('/api/quick-commands/', 'POST', {
      category: el<HTMLInputElement>('command-category').value.trim(),
      name: el<HTMLInputElement>('command-name').value.trim(),
      command: el<HTMLInputElement>('command-text').value,
    });
    el<HTMLInputElement>('command-name').value = ''; el<HTMLInputElement>('command-text').value = '';
    await loadCommands(); commandsMessage(active, 'Команда сохранена.');
  } catch (error) { commandsMessage(active, (error as Error).message); }
  finally { button.disabled = false; }
};
newSession();
loadCommands().catch(error => commandsMessage(active, error.message));
new ResizeObserver(resize).observe(el('terminal'));
window.addEventListener('beforeunload', () => { for (const session of sessions) session.socket?.close(); });
