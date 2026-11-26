import { icon, decorateIcons } from './icons';
type User = { id: number; username: string; first_name: string; last_name: string; email: string; is_active: boolean; is_superuser: boolean };
export function initUsers(api: (path: string, method?: string, body?: unknown) => Promise<any>) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const nav = el<HTMLButtonElement>('nav-users');
  const connections = el<HTMLButtonElement>('nav-connections');
  function section(users: boolean) {
    el('connections-section').hidden = users;
    if (nav) { el('users-section').hidden = !users; nav.classList.toggle('active', users); nav.setAttribute('aria-pressed', String(users)); }
    connections.classList.toggle('active', !users); connections.setAttribute('aria-pressed', String(!users));
  }
  connections.onclick = () => section(false);
  if (!nav) return;
  let users: User[] = []; let current = 0; let selected: User | null = null; let busy = false;
  const dialog = el<HTMLDialogElement>('user-dialog');
  const input = (id: string) => el<HTMLInputElement>(`managed-${id}`);
  function render() {
    const list = el('users-list'); list.replaceChildren();
    const query = el<HTMLInputElement>('user-search').value.toLocaleLowerCase();
    for (const user of users.filter(u => `${u.username} ${u.first_name} ${u.last_name} ${u.email}`.toLocaleLowerCase().includes(query))) {
      const row = document.createElement('article'); row.className = 'managed-user';
      const avatar = document.createElement('span'); avatar.className = 'connection-avatar'; avatar.textContent = user.username[0].toUpperCase();
      const info = document.createElement('div'); info.className = 'managed-user-info';
      const title = document.createElement('strong'); title.textContent = `${user.username}${user.id === current ? ' · вы' : ''}`;
      const detail = document.createElement('span'); detail.textContent = `${user.is_superuser ? 'Администратор' : 'Пользователь'} · ${user.is_active ? 'Активен' : 'Отключён'}`;
      detail.className = user.is_active ? 'user-enabled' : 'user-disabled'; info.append(title, detail);
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-button'; edit.append(icon('pencil')); edit.title = `Изменить ${user.username}`; edit.setAttribute('aria-label', edit.title); edit.onclick = () => open(user);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button danger-action'; remove.append(icon('trash-2')); remove.title = `Удалить ${user.username}`; remove.setAttribute('aria-label', remove.title); remove.disabled = user.id === current;
      remove.onclick = async () => {
        if (!confirm(`Удалить ${user.username}? Его подключения, сохранённые ключи и быстрые команды также будут удалены. Действие необратимо.`)) return;
        remove.disabled = true;
        try { await api(`/api/users/${user.id}/`, 'DELETE'); await load(); }
        catch (error) { el('users-message').textContent = (error as Error).message; remove.disabled = false; }
      };
      row.append(avatar, info, edit, remove); list.append(row);
    }
    if (!list.childElementCount) { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'Пользователи не найдены.'; list.append(empty); }
  }
  async function load() {
    el('users-message').textContent = 'Загрузка…';
    try { const data = await api('/api/users/'); users = data.users; current = data.current_user; render(); el('users-message').textContent = `Всего пользователей: ${users.length}`; }
    catch (error) { el('users-message').textContent = (error as Error).message; }
  }
  function open(user: User | null) {
    selected = user;
    el('user-dialog-title').textContent = user ? `Редактирование · ${user.username}` : 'Новый пользователь';
    for (const [key, value] of Object.entries({ username: user?.username || '', first: user?.first_name || '', last: user?.last_name || '', email: user?.email || '', password: '', confirm: '' })) input(key).value = value;
    input('password').required = !user; input('confirm').required = !user;
    input('active').checked = user?.is_active ?? true; input('admin').checked = user?.is_superuser ?? false;
    input('active').disabled = user?.id === current; input('admin').disabled = user?.id === current;
    el('user-form-message').textContent = ''; dialog.showModal(); input('username').focus();
  }
  nav.onclick = () => { section(true); void load(); };
  el('new-user').onclick = () => open(null);
  el('user-search').oninput = render;
  el('user-dialog-close').onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  el<HTMLFormElement>('user-form').onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    if (input('password').value !== input('confirm').value) { el('user-form-message').textContent = 'Пароли не совпадают.'; return; }
    if (!confirm(selected ? 'Сохранить изменения пользователя? Изменение пароля завершит его другие веб-сессии.' : 'Создать пользователя с указанными правами?')) return;
    busy = true; el<HTMLButtonElement>('user-submit').disabled = true;
    try {
      await api(selected ? `/api/users/${selected.id}/` : '/api/users/', selected ? 'PATCH' : 'POST', {
        username: input('username').value, first_name: input('first').value, last_name: input('last').value, email: input('email').value,
        password: input('password').value, is_active: input('active').checked, is_superuser: input('admin').checked,
      });
      input('password').value = ''; input('confirm').value = ''; dialog.close(); await load();
    } catch (error) { el('user-form-message').textContent = (error as Error).message; }
    finally { busy = false; el<HTMLButtonElement>('user-submit').disabled = false; }
  };
  decorateIcons();
}
