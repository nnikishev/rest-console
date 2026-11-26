import { icon } from './icons';
export function initGroups(api: (path: string, method?: string, body?: unknown) => Promise<any>, refresh: () => Promise<void>) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = el<HTMLDialogElement>('groups-dialog');
  let busy = false;
  const message = (text: string) => { el('groups-message').textContent = text; };
  async function load() {
    const data = await api('/api/connection-groups/');
    const list = el('groups-list'); list.replaceChildren();
    for (const group of data.groups) {
      const row = document.createElement('form'); row.className = 'group-edit-row';
      const name = document.createElement('input'); name.value = group.name; name.required = true; name.maxLength = 80;
      name.setAttribute('aria-label', `Название группы ${group.name}`);
      const save = document.createElement('button'); save.type = 'submit'; save.className = 'icon-button'; save.title = 'Сохранить название'; save.setAttribute('aria-label', save.title); save.append(icon('save'));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button danger-action'; remove.title = 'Удалить группу'; remove.setAttribute('aria-label', remove.title); remove.append(icon('trash-2'));
      row.onsubmit = async event => { event.preventDefault(); await mutate(`/api/connection-groups/${group.id}/`, 'PATCH', { name: name.value }); };
      remove.onclick = async () => {
        if (confirm(`Удалить группу «${group.name}»? Подключения не удаляются и перейдут в «Другие».`)) await mutate(`/api/connection-groups/${group.id}/`, 'DELETE');
      };
      row.append(name, save, remove); list.append(row);
    }
    if (!data.groups.length) { const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Групп пока нет. Создайте первую выше.'; list.append(hint); }
  }
  async function mutate(path: string, method: string, body?: unknown) {
    if (busy) return; busy = true; message('Сохранение…');
    try { await api(path, method, body); await Promise.all([load(), refresh()]); el<HTMLInputElement>('group-name').value = ''; message('Готово.'); }
    catch (error) { message((error as Error).message); }
    finally { busy = false; }
  }
  el('manage-groups').onclick = async () => { dialog.showModal(); message('Загрузка…'); try { await load(); message(''); } catch (error) { message((error as Error).message); } };
  el('groups-close').onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  el<HTMLFormElement>('group-form').onsubmit = async event => { event.preventDefault(); await mutate('/api/connection-groups/', 'POST', { name: el<HTMLInputElement>('group-name').value }); };
}
