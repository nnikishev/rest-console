type Point = { time: number; cpu: number | null; ram: number; swap: number; load: number };
const histories = new Map<number, Point[]>();
const NS = 'http://www.w3.org/2000/svg';
export function clearHistory(id: number) { histories.delete(id); }
function node(tag: string, className: string, text?: string) {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}
function bytes(value: number) {
  if (!Number.isFinite(value)) return '—';
  const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ']; let index = 0;
  while (value >= 1024 && index < 4) { value /= 1024; index++; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}
function svgElement(tag: string, attributes: Record<string, string>) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}
function chart(points: Point[], key: 'cpu' | 'ram' | 'swap' | 'load', max: number, label: string) {
  const figure = node('div', 'resource-chart');
  const svg = svgElement('svg', { viewBox: '0 0 400 100', role: 'img', 'aria-label': label, preserveAspectRatio: 'none' });
  for (const y of [12, 47, 82]) svg.append(svgElement('line', { x1: '0', x2: '400', y1: String(y), y2: String(y), class: 'chart-grid' }));
  const end = points[points.length - 1].time;
  const start = end - 600000;
  let segments: string[][] = []; let segment: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const value = points[i][key];
    if (value === null || (i > 0 && points[i].time - points[i - 1].time > 15000)) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (value !== null) {
      const x = 4 + (points[i].time - start) / 600000 * 392;
      const y = 82 - Math.min(1, Math.max(0, value / max)) * 70;
      segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
  }
  if (segment.length) segments.push(segment);
  for (const part of segments) {
    const first = part[0].split(',')[0], last = part[part.length - 1].split(',')[0];
    svg.append(svgElement('polygon', { points: `${first},82 ${part.join(' ')} ${last},82`, class: 'chart-area' }));
    svg.append(svgElement('polyline', { points: part.join(' '), class: 'chart-line' }));
    for (const point of part) {
      const [cx, cy] = point.split(',');
      const dot = svgElement('circle', { cx, cy, r: '2', class: 'chart-dot' });
      svg.append(dot);
    }
  }
  figure.append(svg);
  const axis = node('div', 'chart-axis'); axis.append(node('span', '', '−10 мин'), node('span', '', 'сейчас'));
  figure.append(axis); return figure;
}
export function renderDashboard(container: HTMLElement, id: number, data: any, previous?: { cpu_total: number; cpu_idle: number }) {
  const now = Date.now();
  const delta = previous ? data.cpu_total - previous.cpu_total : 0;
  const old = histories.get(id) || [];
  const continuous = old.length > 0 && now - old[old.length - 1].time <= 15000;
  const cpu = delta > 0 && continuous ? Math.max(0, Math.min(100, 100 * (1 - (data.cpu_idle - previous!.cpu_idle) / delta))) : null;
  const mem = data.memory;
  const available = mem.MemAvailable ?? ((mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0));
  const ram = mem.MemTotal ? 100 * (mem.MemTotal - available) / mem.MemTotal : 0;
  const swap = mem.SwapTotal ? 100 * (mem.SwapTotal - mem.SwapFree) / mem.SwapTotal : 0;
  const points = old.filter(point => point.time >= now - 600000).slice(-179);
  points.push({ time: now, cpu, ram, swap, load: data.load[0] }); histories.set(id, points);
  container.replaceChildren();
  const summary = node('div', 'monitor-summary');
  summary.append(node('span', '', `${data.cpus} CPU`), node('span', '', `${bytes(mem.MemTotal)} RAM`), node('span', '', `Uptime ${Math.floor(data.uptime / 86400)}д ${Math.floor(data.uptime / 3600) % 24}ч`));
  container.append(summary);
  const grid = node('div', 'resource-grid'); container.append(grid);
  function resource(title: string, value: string, detail: string, key: 'cpu' | 'ram' | 'swap' | 'load', max: number, color: string) {
    const card = node('section', 'resource-card'); card.style.setProperty('--resource-color', color);
    card.append(node('h3', '', title), node('div', 'resource-value', value), node('p', 'resource-detail', detail));
    card.append(chart(points, key, max, `${title}: ${value}. История за последние 10 минут, шкала 0–${max.toFixed(0)}${key === 'load' ? '' : '%'}`));
    grid.append(card);
  }
  resource('CPU', cpu === null ? '—' : `${cpu.toFixed(1)}%`, cpu === null ? 'Ожидание второго замера' : `Утилизация · ${data.cpus} логических ядер`, 'cpu', 100, '#b5ed89');
  resource('ПАМЯТЬ', `${ram.toFixed(1)}%`, `${bytes(mem.MemTotal - available)} / ${bytes(mem.MemTotal)}`, 'ram', 100, '#82bafa');
  resource('LOAD AVERAGE', data.load[0].toFixed(2), `1 / 5 / 15 мин: ${data.load.map((v: number) => v.toFixed(2)).join(' / ')}`, 'load', Math.max(data.cpus, ...points.map(p => p.load), 1) * 1.1, '#c7a0fa');
  resource('SWAP', mem.SwapTotal ? `${swap.toFixed(1)}%` : 'Нет swap', `${bytes(mem.SwapTotal - mem.SwapFree)} / ${bytes(mem.SwapTotal)}`, 'swap', 100, '#f2bd7a');
  container.append(node('h3', 'monitor-section-title', 'Файловые системы'));
  for (const fs of data.filesystems) {
    const card = node('section', `filesystem-card${fs.percent >= 90 ? ' disk-critical' : fs.percent >= 75 ? ' disk-warning' : ''}`);
    const top = node('div', 'filesystem-heading'); top.append(node('strong', '', fs.mount), node('strong', '', `${fs.percent}%`));
    const bar = document.createElement('progress'); bar.max = 100; bar.value = Math.max(0, Math.min(100, fs.percent));
    card.append(top, node('div', 'filesystem-device', fs.device), bar, node('div', 'filesystem-meta', `${bytes(fs.used)} / ${bytes(fs.total)} · свободно ${bytes(fs.available)}`));
    container.append(card);
  }
  const devices = document.createElement('details'); devices.className = 'block-devices'; devices.open = true;
  devices.append(node('summary', '', 'Диски и разделы'));
  function blocks(items: any[], depth = 0) {
    for (const item of items) {
      const row = node('div', 'block-row'); row.style.paddingLeft = `${12 + Math.min(depth, 8) * 14}px`;
      const heading = node('div', 'block-heading'); heading.append(node('strong', '', `${depth ? '↳ ' : '▤ '}${item.name}`), node('span', '', bytes(Number(item.size))));
      row.append(heading, node('div', 'block-meta', `${item.type} · ${item.fstype || 'без ФС'} · ${item.mountpoint || 'не смонтирован'}${item.ro === true || item.ro === 1 ? ' · read-only' : ''}`)); devices.append(row);
      if (item.children) blocks(item.children, depth + 1);
    }
  }
  if (data.blocks) blocks(data.blocks); else devices.append(node('p', 'hint', 'lsblk недоступен'));
  container.append(devices, node('p', 'monitor-footnote', 'Графики: CPU / RAM / swap 0–100%; LA — адаптивная шкала (не проценты). История до 10 минут, только при открытой панели. Разрывы означают отсутствие замеров. SMART не проверяется.'));
}
