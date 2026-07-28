import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { start, TOKEN } from './mock-epost.mjs';
import { startServer } from './client.mjs';

let mock, srv, out;

before(async () => {
  mock = await start();
  out = mkdtempSync(join(tmpdir(), 'epost-test-'));
  srv = await startServer({ EPOST_API_BASE: mock.base, EPOST_TRANSPORT: 'api' });
});
after(async () => { srv?.stop(); await mock?.close(); });

describe('protocol', () => {
  test('advertises itself with the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(srv.init.result.serverInfo.name, pkg.name);
    assert.equal(srv.init.result.serverInfo.version, pkg.version);
  });

  test('every tool has a usable description and an object schema', async () => {
    const tools = await srv.tools();
    assert.ok(tools.length >= 20, `expected the full tool set, got ${tools.length}`);
    for (const t of tools) {
      assert.ok(t.description.length > 20, `${t.name}: description too thin`);
      assert.equal(t.inputSchema.type, 'object', `${t.name}: schema is not an object`);
      for (const r of t.inputSchema.required || []) {
        assert.ok(Object.hasOwn(t.inputSchema.properties, r), `${t.name}: required "${r}" undeclared`);
      }
    }
  });
});

describe('authentication', () => {
  test('obtains a token and reports the API as the transport', async () => {
    const { data } = await srv.call('epost_list_letters');
    assert.equal(data.transport, 'api');
    assert.ok(mock.state.calls.includes('POST /core/latest/tenants'));
    assert.ok(mock.state.calls.includes('POST /core/latest/token'));
  });

  test('an API key alone authenticates, without the password grant', async () => {
    const s = await startServer({
      EPOST_API_BASE: mock.base, EPOST_TRANSPORT: 'api',
      EPOST_API_PASSWORD: '', EPOST_SWISSID_USER: '', EPOST_API_KEY: 'k-123',
    });
    const { data } = await s.call('epost_list_letters');
    assert.equal(data.transport, 'api', 'the key alone should be enough');
    s.stop();
  });

  test('settings report which schemes are configured', async () => {
    const { data } = await srv.call('epost_settings');
    assert.match(data.api, /password grant/);
    assert.equal(data.transport, 'api');
  });
});

describe('reading', () => {
  test('lists inbox letters with the real description, not the uniform title', async () => {
    const { data } = await srv.call('epost_list_letters');
    assert.equal(data.count, 3);
    assert.equal(data.letters[0].sender, 'Invoice from Someone AG');
    assert.deepEqual(data.letters[0].documentTypes, ['Invoice']);
    assert.equal(data.letters[0].date, '02.02.2020', 'date is rendered dd.mm.yyyy like the portal');
  });

  test('lists Storage folders with ids, separating branded ones', async () => {
    const { data } = await srv.call('epost_list_storage');
    assert.equal(data.folders.length, 2);
    assert.equal(data.companyFolders.length, 1);
    assert.ok(data.folders.every(f => f.id));
  });

  test('Storage documents carry folder membership, which the raw API omits', async () => {
    const { data } = await srv.call('epost_list_storage_documents');
    assert.equal(data.count, 3);
    const filed = data.documents.filter(d => d.storedIn?.length);
    assert.equal(filed.length, 2, 'two of three are in a folder');
    const unfiled = data.documents.find(d => !d.storedIn?.length);
    assert.equal(unfiled.id, 'arch-2', 'the unfiled one must be identifiable as unfiled');
  });

  test('gets one letter by id', async () => {
    const { data } = await srv.call('epost_get_letter', { letter_id: 'inbox-1' });
    assert.equal(data.id, 'inbox-1');
  });

  test('counts unread', async () => {
    const { data } = await srv.call('epost_unread_count');
    assert.equal(data.unread, 2, 'inbox-2 is the only one marked read');
  });

  test('searches inside letter content, and returns only what matched', async () => {
    // "at least one result" passed for an implementation that ignored the
    // keyword entirely and handed back the whole letterbox.
    const { data } = await srv.call('epost_search', { keyword: 'Someone' });
    assert.ok(data.count >= 1);
    assert.ok(data.letters.every(l => JSON.stringify(l).includes('Someone')),
      `something that does not match came back: ${JSON.stringify(data.letters.map(l => l.id))}`);
    const none = await srv.call('epost_search', { keyword: 'no-letter-says-this' });
    assert.equal(none.data.count, 0, 'a keyword nothing contains still matched something');
  });

  test('lists the trash', async () => {
    const { data } = await srv.call('epost_list_deleted');
    assert.equal(data.count, 1);
  });
});

describe('downloads', () => {
  test('saves a letter as a real file', async () => {
    const { data } = await srv.call('epost_download_letter', { index: 0, output_dir: out });
    assert.ok(existsSync(data.saved), 'file written');
    assert.ok(readFileSync(data.saved).toString().startsWith('%PDF'), 'looks like a PDF');
  });

  test('a path-shaped value from the service cannot steer the file out of output_dir', async () => {
    // The name is assembled from the letter id and the date the service
    // reported. join() resolves "../" without complaint, so either of those
    // could have written anywhere the process can reach.
    const dir = mkdtempSync(join(tmpdir(), 'epost-escape-'));
    const { data } = await srv.call('epost_download_letter', { letter_id: 'inbox-3', output_dir: dir });
    assert.ok(data.saved, `nothing saved: ${JSON.stringify(data)}`);
    const rel = relative(dir, data.saved);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), `escaped to ${data.saved}`);
    assert.ok(existsSync(data.saved));
  });

  test('a saved letter is not readable by everyone else on the machine', async () => {
    // Correspondence written with the process umask lands -rw-r--r-- on a
    // normal account: every local user can read the mail.
    const { data } = await srv.call('epost_download_letter', { index: 0, output_dir: out });
    const mode = statSync(data.saved).mode & 0o777;
    assert.equal(mode, 0o600, `saved as ${mode.toString(8)}`);
  });

  test('saves a thumbnail, and only if it is one', async () => {
    const p = join(out, 'thumb.png');
    const { data } = await srv.call('epost_download_thumbnail', { letter_id: 'inbox-1', output_path: p });
    assert.equal(data.saved, p);
    assert.ok(existsSync(p));
    // Any 200 used to be saved under this name and reported as a thumbnail,
    // an HTML error page included. Checking only that a file exists cannot
    // tell the two apart.
    assert.deepEqual([...readFileSync(p).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'not a PNG');
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });

  test('a file descriptor is not an output path', async () => {
    // writeFileSync takes a number as an fd: output_path 2 wrote the letter to
    // stderr and 1 wrote it into the MCP stream itself.
    for (const bad of [2, 1, '']) {
      const { raw, isError } = await srv.call('epost_download_thumbnail', { letter_id: 'inbox-1', output_path: bad });
      assert.ok(isError, `output_path ${JSON.stringify(bad)} was accepted`);
      assert.match(raw, /must be a path/);
    }
  });

  test('reads an archived document and can save it', async () => {
    const { data } = await srv.call('epost_read_storage_document', { index: 0, output_dir: out });
    assert.equal(data.transport, 'api');
    assert.ok(existsSync(data.saved));
  });
});

describe('archiving', () => {
  test('files an inbox letter into a folder, matching the name NFC-insensitively', async () => {
    // The mock returns the folder name NFD-normalised, as the service does.
    const { data } = await srv.call('epost_store_letter', { letter_id: 'inbox-2', folder: 'Example_Ümlaut' });
    assert.equal(data.transport, 'api');
    assert.ok(mock.state.inFolder['dir-two'].includes('inbox-2'));
  });

  test('names the folders it does know when asked for one it does not', async () => {
    const { data } = await srv.call('epost_store_letter', { letter_id: 'inbox-1', folder: 'Nope' });
    assert.match(data.error, /not found/);
    assert.ok(Array.isArray(data.available) && data.available.length, 'lists what is available');
  });

  test('a letter_id that is not in the inbox says so, and says where to look', async () => {
    // arch-1 exists, but it is already in Storage. Falling through to the
    // browser here used to report a missing index, sending the reader to the
    // wrong problem entirely.
    const { data } = await srv.call('epost_store_letter', { letter_id: 'arch-1', folder: 'Example_Alpha' });
    assert.match(data.error, /no letter arch-1 in the inbox/);
    assert.match(data.hint, /epost_list_storage_documents/, 'it names the tool that would show it');
  });

  test('marks letters read, and only the ones asked for', async () => {
    // The mock used to answer 204 to anything and change nothing, so this
    // passed on the tool's own echo of its arguments.
    const other = mock.state.inbox.find(l => l.id !== 'inbox-1');
    const before = other.readStatus;
    const { data } = await srv.call('epost_set_read_status', { letter_ids: ['inbox-1'], status: 'READ' });
    assert.equal(data.updated, 1);
    assert.equal(mock.state.inbox.find(l => l.id === 'inbox-1').readStatus, 'READ', 'the letter did not change');
    assert.equal(other.readStatus, before, 'a letter nobody named changed too');
  });

  test('restores a deleted letter, and the trash gives it up', async () => {
    // It used to restore inbox-1 — a letter that was never in the trash —
    // against a mock that answered 204 and changed nothing. An implementation
    // that restores nothing at all passed that.
    assert.ok(mock.state.deleted.some(l => l.id === 'del-1'), 'del-1 starts in the trash');
    const { data } = await srv.call('epost_restore_letter', { letter_id: 'del-1' });
    assert.equal(data.restored, 'del-1');
    assert.ok(!mock.state.deleted.some(l => l.id === 'del-1'), 'it left the trash');
    assert.ok(mock.state.inbox.some(l => l.id === 'del-1'), 'and arrived in the inbox');
  });
});

describe('safety', () => {
  test('refuses to delete without explicit confirmation', async () => {
    const { data } = await srv.call('epost_delete_letter', { letter_id: 'inbox-1', confirm: false });
    assert.match(data.refused, /confirm/);
    assert.ok(!mock.state.calls.some(c => c.startsWith('DELETE ')), 'nothing was deleted');
  });

  test('deletes only when confirmed, and the letter really moves to the trash', async () => {
    // This is the destructive test, and it only ever read back the handler's
    // own echo: code that issued no DELETE at all, or deleted something else,
    // passed it.
    // inbox-2 is archived by an earlier test in this file; inbox-3 stays put.
    assert.ok(mock.state.inbox.some(l => l.id === 'inbox-3'), 'inbox-3 starts in the inbox');
    const { data } = await srv.call('epost_delete_letter', { letter_id: 'inbox-3', confirm: true });
    assert.equal(data.deleted, 'inbox-3');
    assert.match(data.note, /restore/i);
    assert.ok(mock.state.calls.includes('DELETE /epost/v2/letters/inbox-3'), 'no DELETE was sent');
    assert.ok(!mock.state.inbox.some(l => l.id === 'inbox-3'), 'it did not leave the inbox');
    assert.ok(mock.state.deleted.some(l => l.id === 'inbox-3'), 'it did not arrive in the trash');
  });

  test('an upstream error that quotes the credentials back is redacted', async () => {
    // The body of a failed call can be made of the request that produced it —
    // a proxy echoing the Authorization header, a gateway quoting the form it
    // rejected. It used to travel into the tool result verbatim.
    const { raw } = await srv.call('epost_get_letter', { letter_id: 'echo-secret' });
    assert.match(raw, /500/, 'the failure itself is still reported');
    assert.ok(!raw.includes('test-password'), `the password surfaced: ${raw.slice(0, 200)}`);
    assert.ok(!raw.includes(TOKEN), 'the bearer token surfaced');
    assert.ok(raw.includes('***'), 'and it is visible that something was removed');
  });

  test('never echoes the password or the token', async () => {
    const { data } = await srv.call('epost_settings');
    const blob = JSON.stringify(data) + srv.stderr();
    assert.ok(!blob.includes('test-password'), 'password must not surface');
    assert.ok(!blob.includes(TOKEN), 'token must not surface');
    assert.match(data.swissid_user, /\*\*\*/, 'the account is masked');
  });
});

describe('transport selection', () => {
  test('pinned to browser, the API is not consulted at all', async () => {
    const before = mock.state.calls.length;
    const s = await startServer({ EPOST_API_BASE: mock.base, EPOST_TRANSPORT: 'browser', EPOST_BROWSER: '/nonexistent' });
    const { data } = await s.call('epost_settings');
    assert.equal(data.transport, 'browser');
    assert.equal(mock.state.calls.length, before, 'no API traffic when pinned to the browser');
    s.stop();
  });

  test('an API-only tool works on a machine with no browser at all', async () => {
    // The dispatcher used to launch a browser before deciding which tool ran,
    // so every one of these failed with "EPOST_BROWSER not found" — on exactly
    // the headless machine the API transport exists to serve.
    const s = await startServer({
      EPOST_API_BASE: mock.base, EPOST_TRANSPORT: 'api',
      EPOST_BROWSER: '/definitely/not/a/browser',
    });
    for (const tool of ['epost_unread_count', 'epost_search', 'epost_get_letter']) {
      const { data, raw } = await s.call(tool, { keyword: 'Someone', letter_id: 'inbox-1' });
      assert.ok(!/EPOST_BROWSER/.test(raw), `${tool} launched a browser it never uses: ${raw.slice(0, 80)}`);
      assert.equal(data.transport, 'api', `${tool} did not answer over the API`);
    }
    s.stop();
  });

  test('pinned to the API, a browser-only call is refused rather than quietly redirected', async () => {
    // Only "browser" used to be enforced. Pinning to "api" and then falling
    // through to the portal is the pin not meaning anything.
    const s = await startServer({
      EPOST_API_BASE: mock.base, EPOST_TRANSPORT: 'api', EPOST_BROWSER: '/definitely/not/a/browser',
    });
    const { raw } = await s.call('epost_create_folder', { name: 'Whatever' });
    assert.match(raw, /EPOST_TRANSPORT=api/, 'it names the pin as the reason');
    assert.ok(!/not found \(looked at/.test(raw), 'it did not try to launch a browser first');
    s.stop();
  });

  test('with no credentials the API is reported unavailable rather than pretended', async () => {
    const s = await startServer({
      EPOST_API_BASE: mock.base, EPOST_API_PASSWORD: '', EPOST_SWISSID_USER: '', EPOST_API_KEY: '',
      EPOST_BROWSER: '/nonexistent',
    });
    const { data } = await s.call('epost_settings');
    assert.match(data.api, /no credentials/i);
    s.stop();
  });
});
