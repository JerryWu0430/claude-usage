import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Perform an item's `removeAction`. Actions are structured rather than shell
 * strings so user-controlled paths are never handed to a shell for parsing.
 */
export function removeItem(item) {
  const action = item.removeAction;
  if (!action) return { ok: false, error: 'nothing to remove' };
  try {
    if (action.type === 'unlink') {
      fs.unlinkSync(action.path);
      return { ok: true };
    }
    if (action.type === 'rmdir') {
      fs.rmSync(action.path, { recursive: true, force: true });
      return { ok: true };
    }
    if (action.type === 'exec') {
      if (action.cwd && !fs.existsSync(action.cwd)) {
        return { ok: false, error: `project directory is gone: ${action.cwd}` };
      }
      const run = spawnSync(action.cmd, action.args, { cwd: action.cwd, encoding: 'utf8' });
      if (run.error) {
        const missing = run.error.code === 'ENOENT';
        return { ok: false, error: missing ? `\`${action.cmd}\` is not on PATH` : run.error.message };
      }
      if (run.status !== 0) {
        const detail = `${run.stderr || run.stdout || ''}`.trim().split('\n')[0];
        return { ok: false, error: detail || `exited ${run.status}` };
      }
      return { ok: true };
    }
    return { ok: false, error: `unsupported action: ${action.type}` };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, note: 'already gone' };
    return { ok: false, error: (error && error.message) || String(error) };
  }
}
