import { ago, compact, scopeNote, truncate } from './format.js';

export { ago, compact };

const SPARK = '▁▂▃▄▅▆▇█';

/** Suggestions printed in full before the list is summarised. */
const SUGGESTION_PREVIEW = 15;

/** Longest name rendered before truncation, so columns stay aligned. */
const NAME_WIDTH = 34;

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
};

let enabled = true;
export function setColor(on) {
  enabled = on;
}
export function paint(text, ...styles) {
  if (!enabled || !styles.length) return String(text);
  return styles.map((s) => COLORS[s] || '').join('') + text + COLORS.reset;
}

const VERDICTS = {
  keep: { mark: '●', color: 'green', label: 'keep' },
  review: { mark: '◐', color: 'yellow', label: 'review' },
  drop: { mark: '○', color: 'red', label: 'drop' },
  new: { mark: '◆', color: 'blue', label: 'new' },
};

export function sparkline(values) {
  if (!values || !values.length) return '';
  const max = Math.max(...values);
  if (max === 0) return paint('·'.repeat(values.length), 'grey');
  return values
    .map((v) => (v === 0 ? '·' : SPARK[Math.min(SPARK.length - 1, Math.ceil((v / max) * (SPARK.length - 1)))]))
    .join('');
}

/** Visible width, ignoring ANSI escapes so padding survives colouring. */
function width(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}
function pad(text, n) {
  const gap = n - width(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}
function padStart(text, n) {
  const gap = n - width(text);
  return gap > 0 ? ' '.repeat(gap) + text : text;
}

const KIND_LABEL = {
  skill: 'SKILLS',
  command: 'COMMANDS',
  mcp: 'MCP SERVERS',
  plugin: 'PLUGINS',
  agent: 'AGENTS',
};

function row(item, now, widths) {
  const v = VERDICTS[item.verdict] || VERDICTS.review;
  const note = scopeNote(item);
  return [
    ' ',
    paint(v.mark, v.color),
    ' ',
    pad(truncate(item.display, widths.name), widths.name),
    padStart(item.count ? `${compact(item.count)}×` : paint('—', 'grey'), 6),
    ' ',
    pad(sparkline(item.trend), 12),
    ' ',
    pad(item.lastUsed ? ago(item.lastUsed, now) : paint('never', 'grey'), widths.ago),
    ' ',
    pad(note ? paint(note, 'grey') : '', widths.note),
    ' ',
    paint(item.reason, 'grey'),
  ].join('');
}

function section(title, items, now) {
  if (!items.length) return '';
  const widths = {
    name: Math.min(NAME_WIDTH, Math.max(...items.map((i) => i.display.length), 12)),
    ago: Math.max(...items.map((i) => ago(i.lastUsed, now).length), 6),
    note: Math.max(...items.map((i) => scopeNote(i).length), 0),
  };
  const counts = { keep: 0, review: 0, drop: 0, new: 0 };
  for (const item of items) counts[item.verdict] = (counts[item.verdict] || 0) + 1;
  const tally = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => paint(`${n} ${VERDICTS[k].label}`, VERDICTS[k].color))
    .join(paint(' · ', 'grey'));

  const lines = [`${paint(title, 'bold')}  ${paint(`(${items.length})`, 'grey')}  ${tally}`];
  for (const item of items) lines.push(row(item, now, widths));
  return `${lines.join('\n')}\n`;
}

const ORDER = { drop: 0, review: 1, new: 2, keep: 3 };

export function sortItems(items, by = 'verdict') {
  const copy = [...items];
  if (by === 'count') return copy.sort((a, b) => b.count - a.count);
  if (by === 'recent') return copy.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  if (by === 'name') return copy.sort((a, b) => a.display.localeCompare(b.display));
  return copy.sort(
    (a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.count - a.count || a.display.localeCompare(b.display)
  );
}

export function renderReport({ items, now, fileCount, windowDays }, { kinds, sort, showAll, suggestions }) {
  const out = [];
  const date = new Date(now).toISOString().slice(0, 10);
  const window = windowDays ? ` · ${windowDays}d of history` : '';
  out.push(
    `${paint('claude-usage', 'bold', 'cyan')} ${paint(`· ${fileCount} transcripts${window} · ${date}`, 'grey')}\n`
  );

  for (const kind of kinds) {
    let group = items.filter((i) => i.kind === kind);
    if (!showAll) group = group.filter((i) => i.removable || i.count > 0);
    out.push(section(KIND_LABEL[kind] || kind.toUpperCase(), sortItems(group, sort), now));
  }

  if (suggestions.length) {
    const tokens = suggestions.reduce((sum, i) => sum + (i.contextCost || 0), 0);
    const saving = tokens ? ` · ~${compact(tokens)} tokens of context reclaimed` : '';
    out.push(
      `${paint('UNINSTALL SUGGESTIONS', 'bold', 'red')}  ${paint(`${suggestions.length} items${saving}`, 'grey')}`
    );
    const shown = suggestions.slice(0, SUGGESTION_PREVIEW);
    shown.forEach((item, i) => {
      const cost = item.contextCost ? paint(` ~${compact(item.contextCost)} tok`, 'grey') : '';
      out.push(
        `  ${padStart(String(i + 1), 2)}. ${paint(item.kind, 'grey')} ${paint(item.display, 'bold')} ` +
          `${paint('— ' + item.reason, 'grey')}${cost}`
      );
      out.push(`      ${paint(item.removeCmd, 'dim')}`);
    });
    const hidden = suggestions.length - shown.length;
    out.push('');
    if (hidden > 0) out.push(paint(`  …and ${hidden} more of the same verdict`, 'grey'));
    out.push(paint('  run with --prune to print all of these as a copy-pasteable script', 'grey'));
  } else {
    out.push(paint('Nothing to uninstall — everything installed is in use.', 'green'));
  }

  return out.join('\n');
}

export function renderPrune(suggestions) {
  const lines = ['#!/usr/bin/env bash', '# generated by claude-usage — review before running', 'set -euo pipefail', ''];
  for (const item of suggestions) {
    lines.push(`# ${item.kind} ${item.display} — ${item.reason}`);
    lines.push(item.removeCmd);
    lines.push('');
  }
  return lines.join('\n');
}
