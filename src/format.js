/** Presentation helpers shared by the terminal report and the HTML dashboard. */

/** Single-quote a path for safe use in the generated uninstall script. */
export function shellQuote(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function compact(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function ago(ts, now = Date.now()) {
  if (!ts) return 'never';
  const days = Math.floor((now - ts) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  const years = (days / 365).toFixed(1).replace(/\.0$/, '');
  return `${years}y ago`;
}

/** Where an item came from, for the report's source column. */
export function scopeNote(item) {
  if (item.owner) return `via ${item.owner}`;
  if (item.scope === 'connector') return 'claude.ai';
  if (item.scope === 'builtin') return 'built-in';
  if (item.scope === 'unmanaged') return 'built-in / project';
  if (item.scope === 'unlisted') return 'not in config';
  if (item.scope === 'project') return 'project';
  return item.scope === 'user' ? '' : item.scope || '';
}

export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
