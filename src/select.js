import { compact, scopeNote, truncate } from './format.js';
import { paint } from './term.js';

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

const KIND_LABEL = {
  plugin: 'PLUGINS',
  mcp: 'MCP SERVERS',
  skill: 'SKILLS',
  command: 'COMMANDS',
  agent: 'AGENTS',
};
const KIND_ORDER = ['plugin', 'mcp', 'skill', 'command', 'agent'];

const VERDICT_MARK = { keep: '●', review: '◐', drop: '○', new: '◆' };
const VERDICT_COLOR = { keep: 'green', review: 'yellow', drop: 'red', new: 'blue' };

/** Group headers and item rows in one flat list, so the cursor can skip headers. */
function buildRows(items) {
  const rows = [];
  for (const kind of KIND_ORDER) {
    const group = items.filter((i) => i.kind === kind);
    if (!group.length) continue;
    rows.push({ header: true, label: KIND_LABEL[kind] || kind.toUpperCase(), count: group.length });
    for (const item of group) rows.push({ item });
  }
  return rows;
}

/** Decode a raw-mode chunk into keys and mouse events; chunks may hold several. */
function decode(chunk) {
  const events = [];
  let i = 0;
  while (i < chunk.length) {
    const rest = chunk.slice(i);
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
    if (mouse) {
      events.push({
        type: 'mouse',
        button: Number(mouse[1]),
        x: Number(mouse[2]),
        y: Number(mouse[3]),
        press: mouse[4] === 'M',
      });
      i += mouse[0].length;
      continue;
    }
    const seq = /^\x1b\[(\d*)([A-Z~])/.exec(rest);
    if (seq) {
      const map = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
      if (seq[2] === '~') events.push({ type: 'key', name: seq[1] === '5' ? 'pageup' : seq[1] === '6' ? 'pagedown' : '' });
      else events.push({ type: 'key', name: map[seq[2]] || '' });
      i += seq[0].length;
      continue;
    }
    const ch = rest[0];
    if (ch === '\x1b') events.push({ type: 'key', name: 'escape' });
    else if (ch === '\r' || ch === '\n') events.push({ type: 'key', name: 'enter' });
    else if (ch === '\x03') events.push({ type: 'key', name: 'ctrl-c' });
    else events.push({ type: 'key', name: 'char', value: ch });
    i += 1;
  }
  return events;
}

const GUTTER = 8; // "› [x] ○ " — cursor, checkbox and verdict mark
const COST_WIDTH = 10;

/** Lay a row out to exactly `width` columns; a wrapped line corrupts the frame. */
function itemLine(row, width, selected, active) {
  const item = row.item;
  const box = selected.has(item) ? paint('[x]', 'cyan') : '[ ]';
  const mark = paint(VERDICT_MARK[item.verdict] || '·', VERDICT_COLOR[item.verdict] || 'grey');
  const note = scopeNote(item);

  // The cost column is the first thing to go when there is no room for it.
  const showCost = width >= 70 && item.contextCost;
  const costWidth = showCost ? COST_WIDTH : 0;
  const nameWidth = Math.max(10, Math.min(30, width - GUTTER - costWidth - 12));
  const metaWidth = Math.max(0, width - GUTTER - nameWidth - 1 - costWidth);

  const name = truncate(item.display, nameWidth).padEnd(nameWidth);
  const meta = metaWidth ? truncate(`${item.reason}${note ? ` · ${note}` : ''}`, metaWidth) : '';
  const cost = showCost ? paint(`~${compact(item.contextCost)} tok`.padStart(COST_WIDTH), 'grey') : '';

  return `${active ? paint('›', 'cyan') : ' '} ${box} ${mark} ${active ? paint(name, 'bold') : name} ${paint(meta, 'grey')}${cost}`;
}

/**
 * Interactive multi-select over removable items. Returns the chosen items, or
 * null if the user cancelled. Requires a TTY on both stdin and stdout.
 */
export function pickItems(
  items,
  {
    preselect = () => false,
    title = 'Select items to uninstall',
    input = process.stdin,
    output = process.stdout,
  } = {}
) {
  const out = output;
  const rows = buildRows(items);
  const selectable = rows.map((r, i) => (r.item ? i : -1)).filter((i) => i >= 0);
  if (!selectable.length) return [];

  const selected = new Set(items.filter(preselect));
  let cursor = selectable[0];
  let offset = 0;
  let done = null;

  const chrome = 6; // title, hint, blank, footer, blank, spare
  const viewport = () => Math.max(3, (out.rows || 24) - chrome);
  const width = () => Math.max(36, (out.columns || 80) - 2);

  // Maps a screen line back to a row so clicks can hit the right entry.
  let lineToRow = new Map();

  const draw = () => {
    const height = viewport();
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + height) offset = cursor - height + 1;
    offset = Math.max(0, Math.min(offset, Math.max(0, rows.length - height)));

    const w = width();
    const chosen = items.filter((i) => selected.has(i));
    const tokens = chosen.reduce((sum, i) => sum + (i.contextCost || 0), 0);

    const hint =
      w >= 70
        ? '↑↓ move · space toggle · a all · n none · enter confirm · q cancel'
        : '↑↓ · space · a/n · enter · q';
    const lines = [paint(truncate(title, w), 'bold', 'cyan'), paint(truncate(hint, w), 'grey'), ''];
    lineToRow = new Map();
    for (let i = offset; i < Math.min(rows.length, offset + height); i++) {
      const row = rows[i];
      lineToRow.set(lines.length + 1, i); // terminal rows are 1-indexed
      if (row.header) {
        lines.push(`  ${paint(truncate(`${row.label} (${row.count})`, w - 2), 'bold')}`);
      } else {
        lines.push(itemLine(row, w, selected, i === cursor));
      }
    }

    const more = rows.length - (offset + height);
    const summary =
      `${chosen.length} selected` +
      (tokens ? ` · ~${compact(tokens)} tokens reclaimed` : '') +
      (more > 0 ? `   ${more} more below` : '');
    lines.push('');
    lines.push(`  ${paint(truncate(summary, w - 2), chosen.length ? 'cyan' : 'grey')}`);

    out.write(`\x1b[H${lines.map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`);
  };

  const moveCursor = (delta) => {
    const index = selectable.indexOf(cursor);
    const next = Math.max(0, Math.min(selectable.length - 1, index + delta));
    cursor = selectable[next];
  };

  const toggle = (row) => {
    if (!row || !row.item) return;
    if (selected.has(row.item)) selected.delete(row.item);
    else selected.add(row.item);
  };

  const onData = (chunk) => {
    for (const event of decode(String(chunk))) {
      if (event.type === 'mouse') {
        if (event.button === 64) { moveCursor(-3); continue; }
        if (event.button === 65) { moveCursor(3); continue; }
        if (!event.press || event.button !== 0) continue;
        const index = lineToRow.get(event.y);
        if (index === undefined || !rows[index].item) continue;
        cursor = index;
        toggle(rows[index]);
        continue;
      }
      const { name, value } = event;
      if (name === 'ctrl-c' || name === 'escape' || value === 'q') { done = null; return finish(); }
      if (name === 'enter') { done = items.filter((i) => selected.has(i)); return finish(); }
      if (name === 'up') moveCursor(-1);
      else if (name === 'down') moveCursor(1);
      else if (name === 'pageup') moveCursor(-viewport());
      else if (name === 'pagedown') moveCursor(viewport());
      else if (name === 'home') cursor = selectable[0];
      else if (name === 'end') cursor = selectable[selectable.length - 1];
      else if (value === ' ') toggle(rows[cursor]);
      else if (value === 'j') moveCursor(1);
      else if (value === 'k') moveCursor(-1);
      else if (value === 'a') for (const i of items) selected.add(i);
      else if (value === 'n') selected.clear();
      else continue;
    }
    draw();
  };

  let finish;
  return new Promise((resolve) => {
    const cleanup = () => {
      input.off('data', onData);
      out.off('resize', draw);
      if (input.isTTY && input.setRawMode) input.setRawMode(false);
      input.pause();
      out.write(MOUSE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
    };
    finish = () => {
      cleanup();
      resolve(done);
    };

    out.write(ALT_SCREEN_ON + CURSOR_HIDE + MOUSE_ON);
    if (input.setRawMode) input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    input.on('data', onData);
    out.on('resize', draw);
    draw();
  });
}

export const _internals = { decode, buildRows };
