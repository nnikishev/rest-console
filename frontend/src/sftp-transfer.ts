import { formatBytes as bytes } from './format';
import { icon } from './icons';
type Request = (data: Record<string, unknown>) => Promise<any>;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let hideTimer: number | undefined;
let transferGeneration = 0;
let busy = false;
export async function transfer(request: Request, path: string, mode: 'upload' | 'download' | 'archive', file?: File) {
  if (busy) throw new Error('Уже выполняется передача.');
  busy = true;
  window.clearTimeout(hideTimer);
  const generation = ++transferGeneration;
  let cancellationScheduled = false;
  function hideCancelled() {
    if (cancellationScheduled) return;
    cancellationScheduled = true;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => { if (generation === transferGeneration) panel.hidden = true; }, 5000);
  }
  let token: string | null = null, cancelled = false, writer: any = null;
  const parts: Uint8Array[] = [];
  const panel = el('sftp-transfer'); panel.hidden = false;
  const progress = el<HTMLProgressElement>('sftp-progress'); progress.removeAttribute('value');
  const cancel = el<HTMLButtonElement>('sftp-cancel'); cancel.disabled = false; cancel.onclick = () => { cancelled = true; cancel.disabled = true; label.textContent = 'Передача отменена.'; hideCancelled(); };
  const label = el('sftp-transfer-label'); label.textContent = mode === 'archive' ? 'Подготовка ZIP на сервере…' : 'Подготовка передачи…';
  try {
    // Must be called before awaiting network I/O to preserve browser user activation.
    const picker = (window as any).showSaveFilePicker;
    if (mode !== 'upload' && picker) {
      const handle = await picker.call(window, { suggestedName: path.split('/').pop() + (mode === 'archive' ? '.zip' : '') });
      writer = await handle.createWritable();
    }
    const start = await request({ action: 'transfer_start', path, mode, ...(file ? { size: file.size } : {}) });
    token = start.token;
    let offset = 0;
    const began = performance.now();
    progress.max = Math.max(1, start.size); progress.value = 0;
    for (;;) {
      if (cancelled) throw new Error('Передача отменена.');
      if (mode === 'upload') {
        if (offset >= file!.size) break;
        const raw = new Uint8Array(await file!.slice(offset, offset + start.chunk_size).arrayBuffer());
        let binary = ''; for (let i = 0; i < raw.length; i += 32768) binary += String.fromCharCode(...raw.subarray(i, i + 32768));
        const result = await request({ action: 'transfer_chunk', token, content: btoa(binary) }); offset = result.offset;
      } else {
        const result = await request({ action: 'transfer_chunk', token });
        if (result.eof) break;
        const raw = Uint8Array.from(atob(result.content), char => char.charCodeAt(0));
        if (writer) await writer.write(raw); else parts.push(raw);
        offset = result.offset;
      }
      if (cancelled) throw new Error('Передача отменена.');
      progress.value = offset;
      const speed = offset / Math.max(.1, (performance.now() - began) / 1000);
      label.textContent = `${mode === 'upload' ? 'Отправка' : 'Скачивание'} · ${Math.min(100, offset / Math.max(1, start.size) * 100).toFixed(0)}% · ${bytes(offset)} / ${bytes(start.size)} · ${bytes(speed)}/с`;
    }
    if (cancelled) throw new Error('Передача отменена.');
    await request({ action: 'transfer_finish', token }); token = null;
    if (writer) { await writer.close(); writer = null; }
    else if (mode !== 'upload') {
      const url = URL.createObjectURL(new Blob(parts as BlobPart[]));
      const link = document.createElement('a'); link.href = url; link.download = start.name; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    progress.value = progress.max; label.textContent = 'Передача завершена';
  } catch (error) {
    const aborted = cancelled || (error as Error).name === 'AbortError';
    if (aborted) { cancelled = true; hideCancelled(); }
    label.textContent = aborted ? 'Передача отменена.' : (error as Error).message;
    throw error;
  } finally {
    if (token) await request({ action: 'transfer_cancel', token }).catch(() => {});
    if (writer) await writer.abort().catch(() => {});
    parts.length = 0; busy = false; cancel.disabled = true;
  }
}
export function transferIcons() {
  for (const [id, name] of [['sftp-refresh', 'arrow-right'], ['sftp-upload-icon', 'upload'], ['sftp-cancel', 'x']] as const) {
    const button = document.getElementById(id); if (button) button.prepend(icon(name));
  }
}
