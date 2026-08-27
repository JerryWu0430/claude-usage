import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { pickItems, _internals } from '../src/select.js';
import { setColor } from '../src/term.js';

setColor(false);

const item = (over) => ({
  kind: 'skill', display: 'x', verdict: 'drop', reason: 'never used',
  contextCost: 10, scope: 'user', ...over,
});

const ITEMS = [
  item({ kind: 'plugin', display: 'posthog', contextCost: 11000 }),
  item({ display: 'better-colors' }),
  item({ display: 'kept-skill', verdict: 'keep', reason: '40x, last 2d ago' }),
];

/** Drive the picker with a scripted sequence of keystrokes. */
function drive(keys, options = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const frames = [];
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  output.on('data', (chunk) => frames.push(String(chunk)));

  const done = pickItems(ITEMS, { input, output, ...options });
  for (const key of keys) input.write(key);
  return done.then((selected) => ({ selected, frames: frames.join('') }));
}

const ENTER = '\r';
const SPACE = ' ';
const DOWN = '\x1b[B';

test('drop-verdict items start selected, keeps do not', async () => {
  const { selected } = await drive([ENTER], { preselect: (i) => i.verdict === 'drop' });
  assert.deepEqual(selected.map((i) => i.display), ['posthog', 'better-colors']);
});

test('space toggles the row under the cursor', async () => {
  // Cursor starts on the first selectable row (posthog); space deselects it.
  const { selected } = await drive([SPACE, ENTER], { preselect: (i) => i.verdict === 'drop' });
  assert.deepEqual(selected.map((i) => i.display), ['better-colors']);
});

test('cursor skips group headers when moving', async () => {
  // Rows are: [PLUGINS] posthog [SKILLS] better-colors kept-skill.
  // One `down` from posthog must land on better-colors, not the SKILLS header.
  const { selected } = await drive([DOWN, SPACE, ENTER]);
  assert.deepEqual(selected.map((i) => i.display), ['better-colors']);
});

test('a selects everything and n clears it', async () => {
  const all = await drive(['a', ENTER]);
  assert.equal(all.selected.length, 3);
  const none = await drive(['a', 'n', ENTER], { preselect: () => true });
  assert.deepEqual(none.selected, []);
});

test('q cancels and returns null rather than an empty selection', async () => {
  const { selected } = await drive(['q'], { preselect: () => true });
  assert.equal(selected, null, 'cancel must be distinguishable from selecting nothing');
});

test('escape and ctrl-c also cancel', async () => {
  assert.equal((await drive(['\x1b'])).selected, null);
  assert.equal((await drive(['\x03'])).selected, null);
});

test('a mouse click toggles the row it lands on', async () => {
  // Header takes 3 lines, so screen row 4 is the PLUGINS header and row 5 posthog.
  const { selected } = await drive(['\x1b[<0;5;5M', ENTER]);
  assert.deepEqual(selected.map((i) => i.display), ['posthog']);
});

test('clicking a group header selects nothing', async () => {
  const { selected } = await drive(['\x1b[<0;5;4M', ENTER]);
  assert.deepEqual(selected, []);
});

test('the frame shows groups, checkboxes and a running total', async () => {
  const { frames } = await drive([ENTER], { preselect: (i) => i.verdict === 'drop' });
  assert.match(frames, /PLUGINS/);
  assert.match(frames, /SKILLS/);
  assert.match(frames, /\[x\] . posthog/);
  assert.match(frames, /\[ \] . kept-skill/);
  assert.match(frames, /2 selected/);
  assert.match(frames, /~11k tokens reclaimed/);
});

test('the terminal is restored on exit', async () => {
  const { frames } = await drive(['q']);
  assert.ok(frames.includes('\x1b[?1049h'), 'enters the alternate screen');
  assert.ok(frames.endsWith('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l'), 'restores mouse, cursor and screen');
});

test('buildRows groups by kind and keeps headers unselectable', () => {
  const rows = _internals.buildRows(ITEMS);
  assert.equal(rows.filter((r) => r.header).length, 2);
  assert.equal(rows.filter((r) => r.item).length, 3);
  assert.equal(rows[0].label, 'PLUGINS');
});

test('rows never exceed the terminal width', async () => {
  for (const columns of [40, 60, 80, 120]) {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => {};
    const output = new PassThrough();
    output.isTTY = true;
    output.columns = columns;
    output.rows = 30;
    let buf = '';
    output.on('data', (c) => (buf += c));
    const done = pickItems(ITEMS, { input, output, preselect: () => true });
    input.write('q');
    await done;
    const plain = buf.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    for (const line of plain.split('\n')) {
      assert.ok(line.length <= columns, `at ${columns} cols, line was ${line.length}: ${JSON.stringify(line)}`);
    }
  }
});
