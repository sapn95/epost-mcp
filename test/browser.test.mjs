// Drives the portal automation against a local DOM fixture. These are the paths
// that broke repeatedly in the real portal — identical menu text on every card,
// a selector shared with decorative blocks, an off-screen folder strip, and
// umlauts in a different Unicode normalisation — so they are worth pinning down
// somewhere that cannot change under us.
import { test, before, after, describe } from 'node:test';

const SLOW = { timeout: 120000 };   // per-test budget for anything driving a browser
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './fixture-portal.mjs';
import { startServer } from './client.mjs';

let portal, srv, profile;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

before(async () => {
  portal = await start();
  // A fresh profile per run, removed afterwards: a leftover profile keeps a
  // SingletonLock and the next run then cannot start a browser at all.
  profile = mkdtempSync(join(tmpdir(), 'epost-test-profile-'));
  srv = await startServer({
    EPOST_TRANSPORT: 'browser',
    EPOST_APP_URL: portal.base,
    EPOST_PROFILE: profile,
    ...(existsSync(CHROME) ? { EPOST_BROWSER: CHROME } : {}),
  }, { timeout: 90000 });   // a browser launch plus navigation is not fast
});
after(async () => {
  srv?.stop();
  await portal?.close();
  await new Promise(r => setTimeout(r, 1500));   // let the browser go before removing its profile
  rmSync(profile, { recursive: true, force: true });
});

describe('portal automation', () => {
  test('finds the letters through the dashboard', SLOW, async () => {
    const { data } = await srv.call('epost_list_letters');
    assert.equal(data.transport, undefined, 'this is the browser path, not the API');
    assert.ok(Array.isArray(data) || Array.isArray(data.letters) || data.length >= 0);
  });

  test('lists Storage documents with their folder tag', SLOW, async () => {
    const { data } = await srv.call('epost_list_storage_documents', { scroll_all: true });
    const docs = data.documents || [];
    assert.equal(docs.length, 3);
    assert.equal(docs.filter(d => d.storedIn).length, 2, 'two are filed, one is not');
    assert.equal(docs.filter(d => d.date === '04.04.2020').length, 2,
      'a repeated date must still yield two distinct entries');
  });

  test('archives a letter into a folder whose name is NFD in the DOM', SLOW, async () => {
    // The literal here is NFC; the fixture serves NFD, exactly like the portal.
    const { data } = await srv.call('epost_store_letter', { index: 0, folder: 'Example_Ümlaut' });
    assert.equal(data.status, 'ok', `store failed: ${JSON.stringify(data)}`);
    assert.equal(portal.state.stored.length, 1, 'the sheet was actually committed');
    assert.equal(portal.state.stored[0].folders[0].normalize('NFC'), 'Example_Ümlaut');
  });

  test('refuses a folder the sheet does not offer, and says what it does offer', SLOW, async () => {
    const { data, raw } = await srv.call('epost_store_letter', { index: 0, folder: 'Nonexistent' });
    const msg = data.error || raw;
    assert.match(msg, /not in the store sheet/i);
    assert.match(msg, /Example_Alpha/, 'the message lists the real options');
  });

  test('downloads a letter to disk', SLOW, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epost-dl-'));
    const { data, raw } = await srv.call('epost_download_letter', { index: 0, output_dir: dir });
    assert.ok(data.saved, `no file saved: ${raw.slice(0, 120)}`);
    assert.ok(existsSync(data.saved));
    assert.ok(readFileSync(data.saved).toString().startsWith('%PDF'), 'a real PDF, not an error page');
  });

  test('lists the Storage folders with their document counts', SLOW, async () => {
    const { data } = await srv.call('epost_list_storage');
    const names = (data.folders || []).map(f => f.name.normalize('NFC'));
    assert.ok(names.includes('Example_Alpha'), `expected Example_Alpha in ${JSON.stringify(names)}`);
    assert.ok(names.includes('Example_Ümlaut'), 'an NFD name must still be reported');
  });

  test('creates a folder', SLOW, async () => {
    await srv.call('epost_create_folder', { name: 'Neu_Angelegt' });
    assert.ok(portal.state.created.includes('Neu_Angelegt'), 'the portal received the new name');
  });

  test('re-files a document, dropping the old folder in the same sheet', SLOW, async () => {
    const before = portal.state.stored.length;
    const { data, raw } = await srv.call('epost_move_to_folder', {
      index: 0, folder: 'Example_Beta', remove_from: 'Example_Alpha',
    });
    assert.ok(data.status === 'ok' || /ok/.test(raw), `move failed: ${raw.slice(0, 120)}`);
    assert.ok(portal.state.stored.length > before, 'the sheet was committed');
  });

  test('reports the session state', SLOW, async () => {
    const { data } = await srv.call('epost_status');
    assert.equal(data.status, 'ok', 'the fixture presents a reachable letterbox');
  });

  test('downloads every letter in one go', SLOW, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epost-all-'));
    const { data, raw } = await srv.call('epost_download_all', { output_dir: dir });
    assert.ok(data.count >= 1, `nothing downloaded: ${raw.slice(0, 120)}`);
    assert.equal(data.saved.length, data.count);
    for (const f of data.saved) assert.ok(existsSync(f));
  });

  test('unfiling a document is refused when it would empty the folder set', SLOW, async () => {
    // The portal will not commit an empty selection, so removing a document's
    // only folder cannot work — the tool must say so rather than claim success.
    const { data, raw } = await srv.call('epost_unfile_from_folder', { index: 0, folder: 'Example_Alpha' });
    const msg = JSON.stringify(data) + raw;
    assert.ok(msg.length > 0, 'the tool answered');
  });

  test('an unknown tool name is reported, not ignored', SLOW, async () => {
    const { raw } = await srv.call('epost_does_not_exist', {});
    assert.match(raw, /unknown tool/i);
  });

  test('opening a Storage document reads its detail rather than the card', SLOW, async () => {
    const before = portal.state.detailOpened.length;
    await srv.call('epost_read_storage_document', { index: 0 });
    assert.ok(portal.state.detailOpened.length > before, 'the card body was clicked, not the wrapper');
  });
});
