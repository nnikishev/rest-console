import { formatBytes } from './format';
import { transfer, transferIcons } from './sftp-transfer';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { clearHistory, renderDashboard } from './monitor-dashboard';
import { FileEditor } from './file-editor';
import './workspace.css';
import './monitor-dashboard.css';
import { icon, actionIcon, decorateIcons } from './icons';
import { initGroups } from './connection-groups';
import './connection-groups.css';
import { initUsers } from './users';
import './connections.css';
import './navigation.css';
import './connection-dialog.css';
import './sftp-transfer.css';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const connectionDialog = el<HTMLDialogElement>('connection-dialog');
let editingConnectionId: number | null = null;
let connectionAttempt = false;
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
let monitorVisible = false;
const monitorSamples = new Map<number, { cpu_total: number; cpu_idle: number }>();
const monitorBusy = new Set<number>();
type QuickCommand = { id?: number; category: string; name: string; command: string };
let customCommands: QuickCommand[] = [];
let saving = false;
let keyMode = false;
let savedKeyId: number | null = null;

type SavedConnection = {
  id: number; group: number | null; has_key: boolean; name: string; host: string; port: number; username: string; auth_method: 'password' | 'key';
};
const csrf = el<HTMLInputElement>('connection-form').querySelector<HTMLInputElement>('[name=csrfmiddlewaretoken]')!.value;


async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(path, {
    method, credentials: 'same-origin', headers: { 'X-CSRFToken': csrf, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ? `${data.error}${data.fields ? ' ' + Object.values(data.fields).flat().join(' ') : ''}` : 'Не удалось выполнить действие. Проверьте поля и авторизацию.');
  }
  return response.json();
}
function openConnectionDialog(edit = false) {
  el('connection-dialog-title').textContent = editingConnectionId ? (edit ? 'Изменить подключение' : 'Подключение к серверу') : 'Новое подключение';
  el<HTMLDetailsElement>('bookmark-options').open = edit;
  actionIcon(el('save-bookmark'), 'save', editingConnectionId ? 'Сохранить изменения' : 'Сохранить подключение');
  el('connection-message').textContent = '';
  connectionDialog.showModal();
}
function closeConnectionDialog() {
  if (saving) return;
  if (connectionAttempt && active.busy) { active.pending = null; active.busy = false; active.socket?.close(); render(); }
  password.value = ''; key.value = ''; connectionAttempt = false;
  connectionDialog.close();
}
el('connection-dialog-close').onclick = closeConnectionDialog;
connectionDialog.addEventListener('cancel', event => { event.preventDefault(); closeConnectionDialog(); });
function fillConnection(connection: { host: string; port: number; username: string; auth_method?: string; name?: string; id?: number; has_key?: boolean; group?: number | null }, edit = false, show = true) {
  if (saving) return;
  el<HTMLSelectElement>('connection-group').value = String(connection.group || '');
  editingConnectionId = connection.id || null;
  el<HTMLInputElement>('remove-key').checked = false;
  el('remove-key-option').hidden = !connection.has_key;
  el<HTMLInputElement>('host').value = connection.host;
  el<HTMLInputElement>('port').value = String(connection.port);
  el<HTMLInputElement>('username').value = connection.username;
  el<HTMLInputElement>('bookmark-name').value = connection.name || '';
  password.value = '';
  password.type = 'password';
  el('toggle-password').textContent = 'Показать';
  el('toggle-password').setAttribute('aria-pressed', 'false');
  el('toggle-password').setAttribute('aria-label', 'Показать пароль');
  key.value = '';
  savedKeyId = connection.has_key && connection.id ? connection.id : null;
  el<HTMLInputElement>('save-key').checked = false;
  el('saved-key-status').textContent = savedKeyId ? 'Ключ сохранён. Для замены в текущем сеансе выберите другой файл.' : '';
  el('key-name').textContent = savedKeyId ? 'Используется сохранённый ключ' : 'Выберите приватный ключ';
  setMode(connection.auth_method === 'key');
  if (show) {
    openConnectionDialog(edit);
    message(savedKeyId ? 'Сервер выбран. Используется сохранённый ключ; укажите парольную фразу, если нужна.' : 'Сервер выбран. Укажите SSH-пароль или приватный ключ.');
    (connection.username ? password : el<HTMLInputElement>('username')).focus();
  }
}
const authDialog = el<HTMLDialogElement>('connection-auth-dialog');
let authConnection: SavedConnection | null = null;
function connectSaved(connection: SavedConnection) {
  if (saving || active.busy) return;
  fillConnection(connection, false, false);
  authConnection = connection;
  if (connection.auth_method === 'key' && connection.has_key) {
    form.requestSubmit();
    return;
  }
  showConnectionAuth(connection);
}
function showConnectionAuth(connection: SavedConnection) {
  el('connection-auth-message').textContent = '';
  authConnection = connection;
  el('connection-auth-title').textContent = `Подключение · ${connection.name}`;
  el('connection-auth-target').textContent = `${connection.username}@${connection.host}:${connection.port}`;
  el('connection-auth-key-fields').hidden = connection.auth_method !== 'key' || connection.has_key;
  el('connection-auth-password-label').textContent = connection.auth_method === 'key' ? 'Парольная фраза (если есть)' : 'SSH-пароль';
  el<HTMLInputElement>('connection-auth-password').value = '';
  el<HTMLInputElement>('connection-auth-key').value = '';
  if (!authDialog.open) authDialog.showModal();
  el<HTMLInputElement>('connection-auth-password').focus();
}
function closeConnectionAuth() {
  el<HTMLInputElement>('connection-auth-password').value = '';
  el<HTMLInputElement>('connection-auth-key').value = '';
  authDialog.close(); authConnection = null;
}
el('connection-auth-close').onclick = closeConnectionAuth;
authDialog.addEventListener('cancel', event => { event.preventDefault(); closeConnectionAuth(); });
el<HTMLFormElement>('connection-auth-form').onsubmit = event => {
  event.preventDefault();
  if (!authConnection || active.busy) return;
  fillConnection(authConnection, false, false);
  password.value = el<HTMLInputElement>('connection-auth-password').value;
  const files = el<HTMLInputElement>('connection-auth-key').files;
  if (files) key.files = files;
  authDialog.close();
  el<HTMLInputElement>('connection-auth-password').value = '';
  el<HTMLInputElement>('connection-auth-key').value = '';
  form.requestSubmit();
};
function filterBookmarks() {
  const query = el<HTMLInputElement>('bookmark-search').value.trim().toLocaleLowerCase();
  let found = 0;
  document.querySelectorAll<HTMLElement>('.bookmark-row').forEach(row => {
    row.hidden = !row.dataset.search!.includes(query);
    if (!row.hidden) found++;
  });
  document.querySelectorAll<HTMLDetailsElement>('.connection-group').forEach(group => {
    const visible = Array.from(group.querySelectorAll<HTMLElement>('.bookmark-row')).filter(row => !row.hidden).length;
    group.hidden = !!query && !visible;
    if (query && visible) group.open = true;
    group.querySelector('.group-count')!.textContent = String(visible);
  });
  const empty = document.getElementById('bookmark-search-empty');
  if (empty) empty.hidden = found > 0 || !query;
}
el('bookmark-search').oninput = filterBookmarks;
el('reset-connection').onclick = () => {
  if (saving) return;
  form.reset(); editingConnectionId = null; el('remove-key-option').hidden = true;
  savedKeyId = null; password.type = 'password';
  el('toggle-password').textContent = 'Показать';
  el('toggle-password').setAttribute('aria-pressed', 'false');
  el('toggle-password').setAttribute('aria-label', 'Показать пароль');
  el('saved-key-status').textContent = '';
  el('key-name').textContent = 'Выберите приватный ключ';
  el<HTMLDetailsElement>('bookmark-options').open = false;
  setMode(false); openConnectionDialog(); message('Новое подключение. Укажите адрес сервера и SSH-учётные данные.');
  el<HTMLInputElement>('host').focus();
};
el('toggle-password').onclick = () => {
  const visible = password.type === 'password'; password.type = visible ? 'text' : 'password';
  el('toggle-password').textContent = visible ? 'Скрыть' : 'Показать';
  el('toggle-password').setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
  el('toggle-password').setAttribute('aria-pressed', String(visible));
};
let connectionGroups: { id: number; name: string }[] = [];
const collapsedGroups = new Set<string>();
async function loadBookmarks() {
  const [data, groupData] = await Promise.all([api('/api/connections/'), api('/api/connection-groups/')]);
  connectionGroups = groupData.groups;
  const groupSelect = el<HTMLSelectElement>('connection-group');
  const selected = groupSelect.value;
  groupSelect.replaceChildren(new Option('Другие (без группы)', ''));
  for (const group of connectionGroups) groupSelect.add(new Option(group.name, String(group.id)));
  groupSelect.value = selected;
  if (groupSelect.selectedIndex < 0) groupSelect.value = '';
  const list = el('bookmarks-list');
  list.replaceChildren();
  const containers = new Map<number | null, HTMLElement>();
  for (const group of [...connectionGroups, { id: null, name: 'Другие' }]) {
    const section = document.createElement('details'); section.className = 'connection-group';
    const key = String(group.id); section.open = !collapsedGroups.has(key);
    const heading = document.createElement('summary');
    const title = document.createElement('span'); title.textContent = group.name;
    const count = document.createElement('span'); count.className = 'group-count';
    heading.append(icon('folder-open'), title, count); section.append(heading);
    section.addEventListener('toggle', () => { if (section.open) collapsedGroups.delete(key); else collapsedGroups.add(key); });
    containers.set(group.id, section); list.append(section);
  }
  if (!data.connections.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Закладок пока нет.';
    list.append(empty);
  }
  for (const connection of data.connections as SavedConnection[]) {
    const row = document.createElement('div');
    row.className = 'bookmark-row';
    row.dataset.search = `${connection.name} ${connection.host} ${connection.username}`.toLocaleLowerCase();
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'bookmark-select';
    const title = document.createElement('strong');
    title.textContent = connection.name;
    const detail = document.createElement('span');
    detail.textContent = `${connection.username}@${connection.host}:${connection.port} · ${connection.auth_method === 'key' ? (connection.has_key ? 'сохранённый ключ' : 'ключ') : 'пароль'}`;
    select.append(icon('plug'), title, detail);
    select.setAttribute('aria-label', `Подключиться к ${connection.name}`);
    select.disabled = saving;
    select.onclick = () => connectSaved(connection);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quiet';
    remove.append(icon('trash-2'));
    remove.setAttribute('aria-label', `Удалить закладку ${connection.name}`);
    remove.onclick = async () => {
      if (!window.confirm(`Удалить закладку «${connection.name}»?`)) return;
      remove.disabled = true;
      try { await api(`/api/connections/${connection.id}/`, 'DELETE'); await loadBookmarks(); }
      catch (error) { message((error as Error).message, true); remove.disabled = false; }
    };
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-button';
    edit.append(icon('pencil')); edit.title = `Изменить ${connection.name}`; edit.setAttribute('aria-label', edit.title);
    edit.onclick = () => fillConnection(connection, true);
    select.title = `Подключиться к ${connection.name}`;
    row.append(select, edit, remove);
    (containers.get(connection.group) || containers.get(null))!.append(row);
  }
  const emptySearch = document.createElement('p'); emptySearch.id = 'bookmark-search-empty';
  emptySearch.className = 'hint'; emptySearch.textContent = 'Серверы не найдены.'; list.append(emptySearch);
  filterBookmarks();
}
for (const id of ['host', 'port', 'username']) {
  el(id).addEventListener('input', () => {
    savedKeyId = null;
    el('saved-key-status').textContent = '';
    el('key-name').textContent = key.files?.[0]?.name || 'Выберите приватный ключ';
  });
}
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
    const saved = await api(editingConnectionId ? `/api/connections/${editingConnectionId}/` : '/api/connections/', editingConnectionId ? 'PATCH' : 'POST', {
      group: Number(el<HTMLSelectElement>('connection-group').value) || null,
      remove_key: el<HTMLInputElement>('remove-key').checked,
      name, host: el<HTMLInputElement>('host').value.trim(), port: Number(el<HTMLInputElement>('port').value),
      save_key: saveKey, ...(saveKey && file ? { key: await file.text() } : {}),
      username: el<HTMLInputElement>('username').value.trim(), auth_method: keyMode ? 'key' : 'password',
    });
    editingConnectionId = saved.id;
    savedKeyId = saved.has_key ? saved.id : null;
    el<HTMLInputElement>('save-key').checked = false; el<HTMLInputElement>('remove-key').checked = false;
    el('remove-key-option').hidden = !saved.has_key;
    el('saved-key-status').textContent = saved.has_key ? 'Ключ сохранён зашифрованно.' : '';
    el('key-name').textContent = saved.has_key ? 'Используется сохранённый ключ' : 'Выберите приватный ключ';
    actionIcon(button, 'save', 'Сохранить изменения');
    await loadBookmarks();
    message('Подключение сохранено. Можно подключиться сейчас или закрыть окно.');
  } catch (error) { message((error as Error).message, true); }
  finally { saving = false; button.disabled = false; }
};
loadBookmarks().catch(error => message(error.message, true));

function message(text: string, error = false) {
  el('message').textContent = text;
  el('message').classList.toggle('error', error);
  if (connectionDialog.open) {
    el('connection-message').textContent = text;
    el('connection-message').classList.toggle('error', error);
  }
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
    close.append(icon('x'));
    close.setAttribute('aria-label', `Закрыть ${session.title}`);
    close.onclick = () => closeSession(session);
    row.append(button, close);
    el('session-tabs').append(row);
  }
  connect.disabled = active.busy;
  actionIcon(connect, 'plug', active.connected ? 'Подключить в новой вкладке' : 'Подключиться');
  el<HTMLButtonElement>('save-bookmark').disabled = saving || (connectionAttempt && active.busy);
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
  if (monitorVisible) { el('monitor-metrics').replaceChildren(); void refreshMonitor(); }
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
  monitorSamples.delete(session.id);
  clearHistory(session.id);
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

el<HTMLInputElement>('remove-key').onchange = () => {
  if (el<HTMLInputElement>('remove-key').checked) savedKeyId = null;
  else savedKeyId = null; // Reopen the saved entry to restore its key after changing fields.
};
form.onsubmit = async event => {
  event.preventDefault();
  if (saving || active.busy) return;
  if (connectionDialog.open) authConnection = null;
  connectionAttempt = true;
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
    if (!sessions.includes(session) || !connectionAttempt) { session.busy = false; render(); return; }
    session.pending = payload;
    password.value = '';
    password.type = 'password';
    el('toggle-password').textContent = 'Показать';
    el('toggle-password').setAttribute('aria-pressed', 'false');
    el('toggle-password').setAttribute('aria-label', 'Показать пароль');
    key.value = '';
    el<HTMLInputElement>('save-key').checked = false;
    session.socket?.close();
    session.title = `${username}@${host}`;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal/`);
    session.socket = ws;
    session.terminal.reset();
    session.hasOutput = false;
    session.files = []; session.path = '.';
    monitorSamples.delete(session.id);
  clearHistory(session.id);
    session.services = []; session.servicesLoaded = false;
    renderFiles();
    notice(session, 'Устанавливаем защищённое соединение…');
    ws.onopen = () => send(session, session.pending);
    ws.onmessage = event => {
      if (session.socket !== ws || !sessions.includes(session)) return;
      const data = JSON.parse(event.data);
      if (data.type === 'sftp' || data.type === 'monitor') {
        const request = session.requests.get(data.id);
        if (request) {
          clearTimeout(request.timer); session.requests.delete(data.id);
          if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
        }
      } else if (data.type === 'verify') {
        if (session.pending) session.pending.fingerprint = data.fingerprint;
        showVerification();
      } else if (data.type === 'connected') {
        authConnection = null;
        connectionAttempt = false;
        if (connectionDialog.open) connectionDialog.close();
        session.pending = null; session.connected = true; session.busy = false;
        notice(session, 'Соединение установлено.');
        if (session === active) { resize(); session.terminal.focus(); if (sftpVisible) void listFiles(session); if (commandsVisible) void loadServices(session); if (monitorVisible) void refreshMonitor(); }
      } else if (data.type === 'output') {
        session.hasOutput = true;
        session.terminal.write(data.data);
      } else if (data.type === 'error' || data.type === 'closed') {
        session.pending = null; session.connected = false; session.busy = false;
        clearRequests(session);
        if (verifying === session) { verifying = null; dialog.close(); showVerification(); }
        if (data.type === 'error' && authConnection && !connectionDialog.open) {
          showConnectionAuth(authConnection);
          el('connection-auth-message').textContent = data.message || 'Не удалось подключиться.';
        }
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
    if (authConnection && !connectionDialog.open) {
      showConnectionAuth(authConnection);
      el('connection-auth-message').textContent = error instanceof Error ? error.message : 'Ошибка подключения.';
    }
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
el('new-session').onclick = () => { newSession(); el('nav-connections').click(); setMenu(true); el('reset-connection').click(); };
function setMenu(open: boolean) {
  el('connection-menu').hidden = !open;
  el('toggle-menu').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('menu-closed', !open);
  requestAnimationFrame(resize);
}
el('toggle-menu').onclick = () => setMenu(el('connection-menu').hidden);

function sftpRequest(session: Session, data: Record<string, unknown>, type = 'sftp'): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!session.connected) { reject(new Error('Сначала подключитесь к SSH.')); return; }
    const id = ++nextRequest;
    const timer = data.action === 'transfer_start' && data.mode === 'archive' ? 0 : window.setTimeout(() => { session.requests.delete(id); reject(new Error('Тайм-аут SFTP.')); }, 60000);
    session.requests.set(id, { resolve, reject, timer });
    send(session, { type, id, ...data });
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
  el('sftp-file-count').textContent = `${session.files.length} объектов`;
  el('sftp-server-name').textContent = session.connected ? session.title : 'Нет подключения';
  if (!session.files.length) {
    const empty = document.createElement('div'); empty.className = 'sftp-empty';
    empty.append(icon('folder'));
    const text = document.createElement('p'); text.textContent = session.connected ? 'В этом каталоге пока пусто' : 'Файлы появятся после подключения';
    empty.append(text); list.append(empty);
  }
  for (const file of session.files) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const button = document.createElement('button');
    button.className = 'file-entry';
    row.classList.toggle('is-directory', file.directory);
    const badge = document.createElement('span'); badge.className = 'file-kind-icon'; badge.append(icon(file.directory ? 'folder' : 'file'));
    const name = document.createElement('span'); name.className = 'file-name'; name.textContent = file.name;
    button.append(badge, name);
    button.title = file.directory ? `Открыть папку ${file.name}` : `Открыть файл ${file.name}`;
    if (file.directory) { const arrow = icon('chevron-right'); arrow.classList.add('file-open-arrow'); button.append(arrow); }
    const size = document.createElement('span'); size.className = 'file-size';
    size.textContent = file.directory ? 'Папка' : formatBytes(file.size);
    if (!file.directory) size.title = `${new Intl.NumberFormat('ru-RU').format(file.size)} Б`;
    button.disabled = !session.connected;
    const path = joinPath(session.path, file.name);
    button.onclick = () => {
      if (file.directory) void listFiles(session, path);
      else void previewFile(session, path);
    };
    const download = document.createElement('button');
    download.className = 'file-download quiet';
    download.append(icon('download'));
    download.title = file.directory ? 'Скачать каталог как ZIP' : 'Скачать файл';
    download.setAttribute('aria-label', `Скачать ${file.name}${file.directory ? ' как ZIP' : ''}`);
    download.disabled = !session.connected;
    download.onclick = async () => {
      download.disabled = true;
      sftpMessage(session, file.directory ? 'Создание ZIP (символические ссылки пропускаются)…' : 'Скачивание…');
      try {
        await transfer(data => sftpRequest(session, data), path, file.directory ? 'archive' : 'download');
        sftpMessage(session, file.directory ? 'ZIP скачан. Символические ссылки и специальные файлы пропущены.' : 'Файл скачан.');
      } catch (error) { sftpMessage(session, (error as Error).message); }
      finally { download.disabled = !session.connected; }
    };
    row.append(button, size, download);
    list.append(row);
  }
}
el('toggle-sftp').onclick = () => {
  sftpVisible = !sftpVisible;
  if (sftpVisible) {
    hideMonitor();
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
el('sftp-reload').onclick = () => { if (active.connected) void listFiles(active); };
el('sftp-parent').onclick = () => { void listFiles(active, joinPath(active.path, '..')); };
el('sftp-upload-button').onclick = () => el<HTMLInputElement>('sftp-upload').click();
el<HTMLInputElement>('sftp-upload').onchange = async event => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; const session = active;
  input.value = '';
  if (!file) return;
  if (!confirm(`Загрузить «${file.name}» в ${session.path}?`)) return;
  const path = joinPath(session.path, file.name);
  sftpMessage(session, 'Загрузка файла…');
  try {
    await transfer(data => sftpRequest(session, data), path, 'upload', file);
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
        const remove = document.createElement('button'); remove.className = 'quiet'; remove.append(icon('trash-2'));
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
    hideMonitor();
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
function hideMonitor() {
  monitorVisible = false; el('monitor-panel').hidden = true;
  el('toggle-monitor').setAttribute('aria-expanded', 'false');
}
async function refreshMonitor() {
  const session = active;
  if (!monitorVisible || document.hidden || monitorBusy.has(session.id)) return;
  if (!session.connected) {
    el('monitor-message').textContent = 'Подключитесь к SSH для просмотра метрик.';
    el('monitor-metrics').replaceChildren(); return;
  }
  monitorBusy.add(session.id);
  el('monitor-message').textContent = 'Обновление…';
  try {
    const data = await sftpRequest(session, {}, 'monitor');
    if (!sessions.includes(session)) return;
    const previous = monitorSamples.get(session.id);
    monitorSamples.set(session.id, data);
    if (!monitorVisible || active !== session) return;
    renderDashboard(el('monitor-metrics'), session.id, data, previous);
    el('monitor-message').textContent = `Обновлено ${new Date().toLocaleTimeString()} · LA сравнивайте с числом ядер. SMART не проверяется.`;
  } catch (error) {
    if (monitorVisible && session === active) el('monitor-message').textContent = (error as Error).message;
  } finally { monitorBusy.delete(session.id); }
}
el('toggle-monitor').onclick = () => {
  if (monitorVisible) hideMonitor();
  else {
    monitorVisible = true; el('monitor-panel').hidden = false;
    el('toggle-monitor').setAttribute('aria-expanded', 'true');
    commandsVisible = false; el('commands-panel').hidden = true; el('toggle-commands').setAttribute('aria-expanded', 'false');
    sftpVisible = false; el('sftp-panel').hidden = true; el('toggle-sftp').setAttribute('aria-expanded', 'false');
    void refreshMonitor();
  }
  requestAnimationFrame(resize);
};
el('refresh-monitor').onclick = () => { void refreshMonitor(); };
window.setInterval(() => { void refreshMonitor(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshMonitor(); });
transferIcons();
decorateIcons();
initUsers(api);
initGroups(api, loadBookmarks);
for (const [id, name, label] of [
  ['toggle-menu', 'menu', 'Меню'], ['toggle-monitor', 'activity', 'Мониторинг'],
  ['toggle-commands', 'zap', 'Команды'], ['toggle-sftp', 'folder-open', 'SFTP'],
  ['new-session', 'plus', 'Вкладка'], ['reset-connection', 'plus', 'Новое'],
  ['save-bookmark', 'save', 'Сохранить подключение'], ['disconnect', 'unplug', 'Отключить активную сессию'],
  ['refresh-monitor', 'refresh-cw', 'Обновить'], ['refresh-services', 'refresh-cw', 'Сервисы активного сервера'],
  ['sftp-parent', 'arrow-up', 'Вверх'], ['sftp-reload', 'refresh-cw', 'Обновить'], ['preview-close', 'x', 'Закрыть'],
] as const) actionIcon(el(id), name, label);
newSession();
loadCommands().catch(error => commandsMessage(active, error.message));
new ResizeObserver(resize).observe(el('terminal'));
window.addEventListener('beforeunload', () => { for (const session of sessions) session.socket?.close(); });
