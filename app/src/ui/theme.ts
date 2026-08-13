/** Shared dark palette. Plain constants — no theming machinery needed. */
export const colors = {
  bg: '#0d0d10',
  card: '#17171c',
  border: '#26262e',
  text: '#f2f2f6',
  textDim: '#9a9aa6',
  accent: '#4cc2ff',
  danger: '#ff5c5c',
  success: '#41d98d',
  warning: '#ffb84d',
} as const;

export function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}
