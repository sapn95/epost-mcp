// A client that disconnects does not send a signal: it closes the pipe. The
// server has to notice that by itself, or it stays behind with a browser
// holding the profile and a logged-in session nobody is using.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { start } from './fixture-portal.mjs';
import { startServer } from './client.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let portal, profile;
before(async () => {
  portal = await start();
  profile = mkdtempSync(join(tmpdir(), 'epost-test-shutdown-'));
});
after(async () => {
  await portal?.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

const onProfile = () => spawnSync('pgrep', ['-f', profile], { encoding: 'utf8' }).stdout.trim();

test('a client that disconnects takes the server and its browser down with it', { timeout: 120000 }, async () => {
  const srv = await startServer({
    EPOST_TRANSPORT: 'browser',
    EPOST_APP_URL: portal.base,
    EPOST_PROFILE: profile,
    EPOST_WAIT_SCALE: process.env.EPOST_WAIT_SCALE || '0.08',
    ...(existsSync(CHROME) ? { EPOST_BROWSER: CHROME } : {}),
  }, { timeout: 90000 });
  // Any call that needs a page starts the browser.
  await srv.call('epost_status');
  assert.notEqual(onProfile(), '', 'the browser should be running before the disconnect');
  const gone = await srv.disconnect();
  assert.ok(gone.left, `still there after ${gone.ms} ms, with no signal sent`);
  assert.ok(gone.ms < 4000, `took ${gone.ms} ms`);
  assert.equal(gone.code, 0);
  await new Promise(r => { setTimeout(r, 1500); });
  assert.equal(onProfile(), '', 'a browser is still running on the profile');
});
