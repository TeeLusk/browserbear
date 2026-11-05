import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tbPath() {
  if ('BROWSERBEAR_TB' in process.env) return process.env.BROWSERBEAR_TB || null;
  const current = path.join(os.homedir(), 'Library', 'Application Support', 'Threadbear', 'runner', 'current', 'bin', 'tb');
  return fs.existsSync(current) ? current : null;
}

// Chrome starts the service without node on PATH. Use the service's Node for
// tb's launcher, and direct execution for a shell script or /usr/bin/open.
export async function run(file, args) {
  try {
    const node = fs.readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node');
    const [cmd, argv] = node ? [process.execPath, [file, ...args]] : [file, args];
    return await new Promise(resolve => execFile(cmd, argv, { timeout: 15_000 }, (e, out) => resolve(e ? null : out)));
  } catch { return null; }
}

export async function showBrowserPanel(thread) {
  const tb = tbPath();
  if (!thread || !tb) return null;
  try {
    const result = JSON.parse(await run(tb, ['show-panel', thread, 'browser', '--json']));
    return result?.available === true && result.request?.panel === 'threadbear.browser' ? result : null;
  } catch { return null; }
}
