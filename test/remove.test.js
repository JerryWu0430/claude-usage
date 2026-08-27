import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { removeItem } from '../src/remove.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-rm-'));

test('unlinking a symlinked skill leaves the source library intact', () => {
  const root = tmp();
  const source = path.join(root, 'library', 'my skill');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), 'x');
  const link = path.join(root, 'linked');
  fs.symlinkSync(source, link);

  assert.deepEqual(removeItem({ removeAction: { type: 'unlink', path: link } }), { ok: true });
  assert.ok(!fs.existsSync(link), 'link removed');
  assert.ok(fs.existsSync(path.join(source, 'SKILL.md')), 'source must survive');
});

test('rmdir removes a real skill directory and its contents', () => {
  const root = tmp();
  const dir = path.join(root, 'real skill');
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'x');

  assert.deepEqual(removeItem({ removeAction: { type: 'rmdir', path: dir } }), { ok: true });
  assert.ok(!fs.existsSync(dir));
});

test('an already-removed path reports success, not an error', () => {
  const gone = path.join(tmp(), 'never-existed');
  assert.deepEqual(removeItem({ removeAction: { type: 'unlink', path: gone } }), { ok: true, note: 'already gone' });
});

test('a missing binary is reported instead of thrown', () => {
  const result = removeItem({
    removeAction: { type: 'exec', cmd: 'claude-usage-no-such-binary', args: ['x'] },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not on PATH/);
});

test('a non-zero exit surfaces the tool’s own message', () => {
  const result = removeItem({ removeAction: { type: 'exec', cmd: 'false', args: [] } });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('a vanished project directory is refused rather than removed from the wrong place', () => {
  const result = removeItem({
    removeAction: { type: 'exec', cmd: 'echo', args: ['hi'], cwd: '/definitely/not/here' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /project directory is gone/);
});

test('an item with nothing to remove is a no-op, not a crash', () => {
  assert.equal(removeItem({}).ok, false);
  assert.equal(removeItem({ removeAction: { type: 'wat' } }).ok, false);
});

test('paths are never parsed by a shell', () => {
  // A path containing shell metacharacters must be treated as a literal name.
  const root = tmp();
  const nasty = path.join(root, 'a; rm -rf $HOME');
  fs.mkdirSync(nasty, { recursive: true });
  const sentinel = path.join(root, 'sentinel');
  fs.writeFileSync(sentinel, 'still here');

  assert.deepEqual(removeItem({ removeAction: { type: 'rmdir', path: nasty } }), { ok: true });
  assert.ok(!fs.existsSync(nasty));
  assert.ok(fs.existsSync(sentinel), 'nothing else was touched');
});
