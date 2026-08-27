import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBuiltinCommand, normalizeMcpServer, parseMcpToolName } from '../src/transcripts.js';
import { DAY, DEFAULTS, verdictFor, weeklyTrend } from '../src/analyze.js';
import { setColor, sparkline } from '../src/term.js';
import { ago, compact, shellQuote, truncate } from '../src/format.js';
import { renderHtml } from '../src/html.js';
import { renderPrune } from '../src/term.js';

setColor(false); // assert on plain text, not ANSI escapes

test('parseMcpToolName splits server from tool', () => {
  assert.deepEqual(parseMcpToolName('mcp__datadog__search_logs'), { server: 'datadog', tool: 'search_logs' });
  assert.deepEqual(parseMcpToolName('mcp__claude_ai_Figma__use_figma'), {
    server: 'claude_ai_Figma',
    tool: 'use_figma',
  });
  assert.deepEqual(parseMcpToolName('mcp__claude-in-chrome__computer'), {
    server: 'claude-in-chrome',
    tool: 'computer',
  });
  // A malformed name must not throw — transcripts are not a validated schema.
  assert.deepEqual(parseMcpToolName('mcp__lonely'), { server: 'lonely', tool: '' });
});

test('normalizeMcpServer identifies where a server came from', () => {
  assert.deepEqual(normalizeMcpServer('claude_ai_Linear'), { name: 'Linear', origin: 'connector' });
  assert.deepEqual(normalizeMcpServer('plugin_vercel_vercel'), { name: 'vercel', origin: 'plugin' });
  assert.deepEqual(normalizeMcpServer('datadog'), { name: 'datadog', origin: 'local' });
});

test('isBuiltinCommand separates shipped commands from installed ones', () => {
  assert.ok(isBuiltinCommand('clear'));
  assert.ok(isBuiltinCommand('model'));
  assert.ok(!isBuiltinCommand('pr-description'));
});

const NOW = Date.parse('2026-08-27T00:00:00Z');
const at = (days) => NOW - days * DAY;
const judge = (item, windowDays = 200) => verdictFor(item, NOW, DEFAULTS, windowDays)[0];

test('unused items are dropped once past the grace period', () => {
  assert.equal(judge({ count: 0, lastUsed: null, installedAt: at(5) }), 'new');
  assert.equal(judge({ count: 0, lastUsed: null, installedAt: at(60) }), 'drop');
});

test('recent use keeps an item regardless of volume', () => {
  assert.equal(judge({ count: 1, lastUsed: at(2), installedAt: at(300) }), 'keep');
});

test('a heavy staple survives a longer cooling period than a rarity', () => {
  const cooling = { lastUsed: at(60), installedAt: at(300) };
  assert.equal(judge({ ...cooling, count: 50 }), 'keep');
  assert.equal(judge({ ...cooling, count: 3 }), 'review');
});

test('anything idle past the stale threshold is dropped', () => {
  assert.equal(judge({ count: 100, lastUsed: at(200), installedAt: at(400) }), 'drop');
});

test('a missing install date falls back to the observed history window', () => {
  const [verdict, reason] = verdictFor({ count: 0, lastUsed: null, installedAt: null }, NOW, DEFAULTS, 30);
  assert.equal(verdict, 'drop');
  assert.match(reason, /30d of history/);
});

test('weeklyTrend buckets days into trailing weeks, oldest first', () => {
  const trend = weeklyTrend({ '2026-08-26': 3, '2026-07-01': 2 }, NOW, 12);
  assert.equal(trend.length, 12);
  assert.equal(trend[11], 3); // this week
  assert.equal(trend.reduce((a, b) => a + b, 0), 5);
  // Anything older than the window is discarded rather than piled onto week 0.
  assert.equal(weeklyTrend({ '2020-01-01': 9 }, NOW, 12).reduce((a, b) => a + b, 0), 0);
});

test('weeklyTrend keeps today when run before midday UTC', () => {
  // Day keys are bucketed at 12:00Z, so an early-morning run sees a negative
  // delta; unclamped that pushed the current week past the end of the array.
  const morning = Date.parse('2026-08-27T03:00:00Z');
  const trend = weeklyTrend({ '2026-08-27': 4 }, morning, 12);
  assert.equal(trend[11], 4);
  assert.equal(trend.reduce((a, b) => a + b, 0), 4);
});

test('sparkline marks empty buckets and scales to the peak', () => {
  assert.equal(sparkline([0, 0, 0]), '···');
  const line = sparkline([1, 4]);
  assert.equal(line.length, 2);
  assert.equal(line[1], '█');
});

test('ago renders human distances', () => {
  assert.equal(ago(null), 'never');
  assert.equal(ago(at(0), NOW), 'today');
  assert.equal(ago(at(1), NOW), 'yesterday');
  assert.equal(ago(at(5), NOW), '5d ago');
  assert.equal(ago(at(60), NOW), '2mo ago');
  assert.equal(ago(at(400), NOW), '1.1y ago');
});

test('compact shortens large counts', () => {
  assert.equal(compact(42), '42');
  assert.equal(compact(1500), '1.5k');
  assert.equal(compact(11088), '11k');
});

test('shellQuote protects paths that reach the uninstall script', () => {
  assert.equal(shellQuote('/Users/x/.claude/skills/plain-name'), '/Users/x/.claude/skills/plain-name');
  assert.equal(shellQuote('/tmp/my skill'), "'/tmp/my skill'");
  assert.equal(shellQuote("/tmp/o'brien"), "'/tmp/o'\\''brien'");
  assert.equal(shellQuote('/tmp/a;rm -rf ~'), "'/tmp/a;rm -rf ~'");
});

test('renderPrune emits the quoted command verbatim', () => {
  const script = renderPrune([{ kind: 'skill', display: 'x', reason: 'never used', removeCmd: "rm -rf '/tmp/my skill'" }]);
  assert.match(script, /rm -rf '\/tmp\/my skill'/);
  assert.match(script, /^#!\/usr\/bin\/env bash/);
});

test('truncate keeps the column width it is given', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('averylongskillname', 8).length, 8);
});

test('renderHtml cannot be broken out of by a crafted name', () => {
  const item = {
    kind: 'mcp', name: '</script><img>', display: '</script><img>', scope: 'user',
    count: 1, lastUsed: NOW, trend: new Array(12).fill(0), verdict: 'keep',
    reason: 'ok', contextCost: 0, removable: true, removeCmd: 'noop', installed: true,
  };
  const html = renderHtml({ items: [item], now: NOW, fileCount: 1 }, {
    kinds: ['mcp'], showAll: true, suggestions: [],
  });
  const scripts = html.split('<script>')[1].split('</script>');
  // Exactly one closing tag means the payload did not terminate the block early.
  assert.equal(scripts.length, 2);
  assert.ok(html.includes('\\u003c/script>'));
});
