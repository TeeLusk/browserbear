#!/usr/bin/env node
// Plays Chrome for the service's profile opening (service/chrome.mjs), so
// tests never touch the real Chrome. FAKE_MENU is the Profiles menu,
// "name=email|name=email". Opening a profile that has an email starts a fake
// extension for it that connects straight to the service socket; FAKE_CTL_LOG
// records each call. FAKE_CTL_FAIL makes the menu unreadable with that error.
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOCKET, line, lineReader } from '../../service/wire.mjs';

const [cmd, arg] = process.argv.slice(2);
const menu = (process.env.FAKE_MENU || '').split('|').filter(Boolean).map((e) => e.split('='));
if (process.env.FAKE_CTL_LOG && cmd !== 'serve') fs.appendFileSync(process.env.FAKE_CTL_LOG, `${cmd} ${arg ?? ''}\n`);

if (cmd === 'menu') {
  if (process.env.FAKE_CTL_FAIL) {
    console.error(process.env.FAKE_CTL_FAIL);
    process.exit(1);
  }
  for (const [name] of menu) console.log(name);
} else if (cmd === 'email' || cmd === 'click') {
  const email = cmd === 'email' ? menu.find(([, e]) => e === arg)?.[1] : menu.find(([n]) => n === arg)?.[1];
  // Like Chrome: an email it doesn't know opens nothing new.
  if (email) spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', email], { detached: true, stdio: 'ignore', env: process.env }).unref();
} else if (cmd === 'serve') {
  // The new profile's extension: knows no tabs, opens tab 50.
  const sock = net.connect(SOCKET, () => sock.write(line({ type: 'hello', instance: `inst-${arg}`, email: arg, version: 'test' })));
  sock.on(
    'data',
    lineReader((msg) => {
      if (msg.id === undefined) return;
      const result = msg.op === 'tabs' ? [] : msg.op === 'open' ? { tabId: 50, url: msg.args.url, title: 'Opened', active: true } : msg.op === 'cdp' ? {} : true;
      sock.write(line({ id: msg.id, ok: true, result }));
    }),
  );
  sock.on('close', () => process.exit(0));
  sock.on('error', () => process.exit(0));
}
