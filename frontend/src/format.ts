export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1);
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: index ? 2 : 0 }).format(value / 1000 ** index)} ${units[index]}`;
}
