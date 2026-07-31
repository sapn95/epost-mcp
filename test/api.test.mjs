import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { start, TOKEN, API_KEY } from './mock-epost.mjs';
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
      EPOST_API_PASSWORD: '', EPOST_SWISSID_USER: '', EPOST_API_KEY: API_KEY,
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

  test('a search hit is not a position in the inbox, and stops claiming to be one', async () => {
    // `index` is the handle epost_download_letter and epost_store_letter take.
    // Search numbered its own hits, so a keyword naming exactly one letter came
    // back as index 0 for a letter sitting THIRD in the inbox — and a caller
    // downloading the index it had just been handed saved the first letter's
    // bytes under the name of the one it had searched for. epost_get_letter
    // minted the same 0 for every letter in the letterbox, the trash included.
    const listed = await srv.call('epost_list_letters');
    assert.equal(listed.data.letters.find(l => l.id === 'inbox-3').index, 2,
      'the fixture is supposed to put inbox-3 third');
    const hit = await srv.call('epost_search', { keyword: 'inbox-3' });
    assert.equal(hit.data.count, 1, 'the keyword is supposed to name exactly one letter');
    assert.equal(hit.data.letters[0].id, 'inbox-3');
    assert.ok(!('index' in hit.data.letters[0]),
      `a hit was numbered as if it were an inbox position: ${JSON.stringify(hit.data.letters[0])}`);
    const one = await srv.call('epost_get_letter', { letter_id: 'inbox-3' });
    assert.equal(one.data.id, 'inbox-3');
    assert.ok(!('index' in one.data),
      `a single-letter lookup reported a position it never looked up: ${JSON.stringify(one.data.index)}`);
    // The listing that does address by position keeps saying so.
    assert.ok(listed.data.letters.every(l => typeof l.index === 'number'), 'a real listing lost its positions');
  });
});

describe('downloads', () => {
  test('saves the letter that was asked for, not just some letter', async () => {
    // Every mock PDF used to be byte-identical, so a download that fetched a
    // different letter's content was indistinguishable from a correct one.
    const { data } = await srv.call('epost_download_letter', { index: 0, output_dir: out });
    assert.ok(existsSync(data.saved), 'file written');
    const body = readFileSync(data.saved).toString();
    assert.ok(body.startsWith('%PDF'), 'looks like a PDF');
    assert.match(body, /inbox-1/, `fetched a different letter: ${body.slice(0, 40)}`);
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

  test('reads an archived document with its folder, and can save it', async () => {
    // The raw archive listing carries no folder field, so storedIn came back
    // absent for every document while the tool promises the current folder.
    const { data } = await srv.call('epost_read_storage_document', { index: 0, output_dir: out });
    assert.equal(data.transport, 'api');
    assert.ok(existsSync(data.saved));
    assert.deepEqual(data.storedIn, ['Example_Alpha'], `no folder reported: ${JSON.stringify(data.storedIn)}`);
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

  test('two different selectors is a question, not a preference', async () => {
    // letter_id used to win over index and title in silence, so a call naming
    // two different letters archived one and reported the request as given.
    const { data } = await srv.call('epost_store_letter', { letter_id: 'inbox-1', index: 0, folder: 'Example_Alpha' });
    assert.match(data.error, /pass one of letter_id, index or title/);
    assert.match(data.error, /letter_id and index/);
  });

  test('a null in the properties it is not using is not a second selector', async () => {
    // Plenty of clients fill in every property the schema declares and write
    // null into the ones they have nothing for. Testing only for `undefined`
    // read those nulls as selectors, so an entirely unambiguous call came back
    // refused — with a complaint naming the two parameters the caller had
    // deliberately left empty.
    // arch-1 is already in Storage, so the call gets that far and stops there —
    // which is the point: it was resolved as the single letter it names rather
    // than refused at the door, and nothing in the letterbox moved to prove it.
    const { data } = await srv.call('epost_store_letter', { letter_id: 'arch-1', index: null, title: null, folder: 'Example_Alpha' });
    assert.match(data.error, /no letter arch-1 in the inbox/,
      `an unambiguous call was refused as ambiguous: ${JSON.stringify(data)}`);
  });

  test('and neither is the empty string the same client writes into its string properties', async () => {
    // The other half of that family: a client with nothing to put in `title`
    // writes "" rather than null. Testing only for null left those counted, so
    // a call naming exactly one letter came back refused as naming two — and
    // epost_download_letter, held to the identical rule, accepted it. Neither
    // "" is an address the resolver would ever use: it falls through both on
    // truthiness, and oneByTitle("") matches the whole inbox.
    const { data } = await srv.call('epost_store_letter', { letter_id: 'arch-1', title: '', folder: 'Example_Alpha' });
    assert.match(data.error, /no letter arch-1 in the inbox/,
      `an unambiguous call was refused as ambiguous: ${JSON.stringify(data)}`);
  });

  test('marks letters read, and counts what was sent rather than what was found', async () => {
    // The mock used to answer 204 to anything and change nothing, so this
    // passed on the tool's own echo of its arguments.
    const other = mock.state.inbox.find(l => l.id !== 'inbox-1');
    const before = other.readStatus;
    const { data } = await srv.call('epost_set_read_status', { letter_ids: ['inbox-1'], status: 'READ' });
    assert.equal(data.accepted, 1);
    assert.equal(mock.state.inbox.find(l => l.id === 'inbox-1').readStatus, 'READ', 'the letter did not change');
    assert.equal(other.readStatus, before, 'a letter nobody named changed too');

    // `updated: N` was N read straight off the arguments. The endpoint answers
    // 204 with an empty body and never names the ids it recognised, so three
    // ids of which one exists came back as three letters updated — a number
    // that was true before the call was made.
    const many = await srv.call('epost_set_read_status', {
      letter_ids: ['inbox-1', 'no-such-letter', 'also-not-a-letter'], status: 'READ',
    });
    assert.ok(!('updated' in many.data),
      `a count the service never gave is reported as one: ${JSON.stringify(many.data)}`);
    assert.equal(many.data.accepted, 3);
    assert.match(many.data.note, /what was sent/, 'and it says which of the two that number is');
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

// A letterbox of their own, because these make the service misbehave on purpose
// and the tests above read one they expect to be intact.
describe('a token that expires between two calls', () => {
  let m, s;
  before(async () => {
    m = await start();
    s = await startServer({ EPOST_API_BASE: m.base, EPOST_TRANSPORT: 'api' });
    await s.call('epost_unread_count');          // authenticate once, as any first call does
  });
  after(async () => { s?.stop(); await m?.close(); });

  const tokens = () => m.state.calls.filter(c => c === 'POST /core/latest/token').length;

  test('is fetched again, and the call still answers', async () => {
    // A token lasts 600 seconds, so it runs out between two tool calls sooner
    // or later. Reporting that as "the API is unavailable" would send the whole
    // request to the browser to be done differently — for a session that only
    // needed renewing.
    const before = tokens();
    m.state.forceStatus.push({ status: 401 });
    const { data, raw } = await s.call('epost_unread_count');
    assert.equal(data.unread, 2, `the retry did not deliver the answer: ${raw.slice(0, 120)}`);
    assert.equal(tokens(), before + 1, 'no fresh token was fetched');
  });

  test('a refusal on the second attempt is reported, not swallowed as unavailability', async () => {
    // 4xx is the API answering, and answering no. Treating it as "unavailable"
    // hands the caller a browser fallback for something the service has just
    // refused — or a fallback result for a request that never went through.
    m.state.forceStatus.push({ status: 401 }, { status: 400 });
    const { raw, isError } = await s.call('epost_unread_count');
    assert.ok(isError, `a refusal came back as a normal answer: ${raw.slice(0, 140)}`);
    assert.match(raw, /400/, 'it reports the status the service answered with');
  });

  test('a server error on the second attempt leaves the API unavailable, not refused', async () => {
    m.state.forceStatus.push({ status: 401 }, { status: 503 });
    const { data, raw } = await s.call('epost_unread_count');
    assert.match(data.error || raw, /needs the API/);
    assert.match(data.hint || raw, /503/, 'the reason is passed on, not replaced');
  });

  test('a re-authentication that no longer takes is reported as unavailable', async () => {
    // The 401 provokes a fresh password grant, and that one fails too. There is
    // no answer to hand back and no session to retry with, so this is the one
    // case that legitimately reports the API as unavailable.
    m.state.forceStatus.push({ status: 401 }, { path: '/core/latest/tenants', status: 400 });
    const { data, raw } = await s.call('epost_unread_count');
    assert.match(data.error || raw, /needs the API/);
    assert.match(data.hint || raw, /401/, 'it names the failure it actually hit');
    // And it recovers: one bad moment must not pin the API down for the life of
    // the process, which is what an unconditional apiUnavailable used to do.
    const { data: after } = await s.call('epost_unread_count');
    assert.equal(after.unread, 2, 'the API stayed "unavailable" after it had recovered');
  });
});

describe('addressing a letter by a substring', () => {
  let m, s;
  before(async () => {
    m = await start();
    // One inbox letter gets a description of its own: with three letters saying
    // the same thing, no substring can address exactly one, and the difference
    // between "matches one" and "matches several" is the whole point here.
    m.state.inbox[1].description = 'Reminder from Example Beta AG';
    s = await startServer({ EPOST_API_BASE: m.base, EPOST_TRANSPORT: 'api' });
  });
  after(async () => { s?.stop(); await m?.close(); });

  test('a substring that names one letter archives that one', async () => {
    const { data, raw } = await s.call('epost_store_letter', { title: 'Example Beta', folder: 'Example_Alpha' });
    assert.equal(data.transport, 'api', `store failed: ${raw.slice(0, 140)}`);
    assert.ok(m.state.inFolder['dir-one'].includes('inbox-2'), 'a different letter was filed');
    assert.ok(!m.state.inbox.some(l => l.id === 'inbox-2'), 'it did not leave the inbox');
  });

  test('a substring that names two is refused rather than resolved to the first', async () => {
    // "the first row containing this text" archived, read or deleted a
    // neighbour just as readily as the intended letter: the descriptions repeat
    // and so do the dates, so a substring that matches twice is not an address.
    const { raw, isError } = await s.call('epost_store_letter', { title: 'Someone', folder: 'Example_Alpha' });
    assert.ok(isError, `it picked one of them: ${raw.slice(0, 140)}`);
    assert.match(raw, /matches 2 letters/);
    assert.match(raw, /id or index/, 'and says how to address one properly');
    assert.equal(m.state.inFolder['dir-one'].length, 2, 'something was filed anyway');
  });
});

describe('the API answering no', () => {
  let m, s, dir;
  before(async () => {
    m = await start();
    dir = mkdtempSync(join(tmpdir(), 'epost-refusal-'));
    s = await startServer({ EPOST_API_BASE: m.base, EPOST_TRANSPORT: 'api' });
  });
  after(async () => { s?.stop(); await m?.close(); });

  test('a number is not an output directory', async () => {
    // mkdirSync takes no descriptors, but it does accept a number and then
    // fails somewhere far less legible than at the tool boundary.
    const { raw, isError } = await s.call('epost_download_letter', { index: 0, output_dir: 2 });
    assert.ok(isError, 'a file descriptor was accepted as a directory');
    assert.match(raw, /output_dir must be a path, not number/);
  });

  test('two ways of naming the letter is a question, not a preference', async () => {
    // letter_id addresses the API's idea of a letter and index addresses a
    // position in the portal's list. Falling through with both set answered a
    // different question from the one asked, in silence.
    const { data } = await s.call('epost_download_letter', { letter_id: 'inbox-1', index: 0, output_dir: dir });
    assert.match(data.error, /pass either letter_id or index/);
  });

  test('a thumbnail that is not an image is refused, and nothing is written', async () => {
    const path = join(dir, 'not-a-thumbnail.png');
    m.state.thumbnailAsHtml = true;
    const { data } = await s.call('epost_download_thumbnail', { letter_id: 'inbox-1', output_path: path });
    m.state.thumbnailAsHtml = false;
    assert.match(data.error, /did not answer with an image/);
    assert.ok(!existsSync(path), 'an error page was saved under the name of a thumbnail');
  });

  test('an error page is not a letter, and is not saved as one', async () => {
    // The thumbnail endpoint was taught this two rounds ago, after a gateway
    // that answers with an HTML page had one written under a .png name and
    // reported as an image. The endpoint that serves the correspondence itself
    // never learned it: thirty-nine bytes of "<html><body>gateway error" landed
    // in the caller's archive as 2020-02-02_ePost_inbox-1.pdf, reported as
    // saved with a byte count beside it, and nothing downstream could tell.
    const bad = mkdtempSync(join(tmpdir(), 'epost-notapdf-'));
    m.state.contentAsHtml = true;
    try {
      const { data, raw } = await s.call('epost_download_letter', { letter_id: 'inbox-1', output_dir: bad });
      assert.ok(!data.saved, `an error page was saved as a letter: ${raw.slice(0, 200)}`);
      assert.match(data.error, /content of letter inbox-1 could not be fetched/);
      assert.match(data.hint, /not a PDF/, `it does not say what came back instead: ${raw.slice(0, 200)}`);
      assert.deepEqual(readdirSync(bad), [], 'something was written regardless');

      // Same endpoint, other tool, and no portal to fall back to once the id
      // has resolved: the half that was read is reported, the file is not.
      const doc = await s.call('epost_read_storage_document', { letter_id: 'arch-1', output_dir: bad });
      assert.equal(doc.data.status, 'partial', `a document was reported as saved: ${doc.raw.slice(0, 200)}`);
      assert.equal(doc.data.saved, null);
      assert.match(doc.data.error, /not a PDF/);
      assert.equal(doc.data.id, 'arch-1', 'the metadata half is still reported');
      assert.deepEqual(readdirSync(bad), []);
    } finally {
      m.state.contentAsHtml = false;
    }
  });

  test('and neither is an answer with no bytes in it at all', async () => {
    // The check above is asked "is this not a letter?" and answers with the
    // byte COUNT — `notPdf = bytes.length` — so the emptiest answer of the lot
    // walks through the guard written to stop it, because zero is falsy. A
    // gateway that truncates produces exactly that, and so does a 204: a raw
    // fetch reads the body before anyone looks at the status. Both tools wrote
    // a 0-byte file and reported it as saved with `bytes: 0` beside it, which
    // is a letter that arrived, as far as anything downstream can tell. The
    // thumbnail endpoint, which reads the first four bytes instead of counting
    // them, has always refused this.
    const bad = mkdtempSync(join(tmpdir(), 'epost-nobytes-'));
    m.state.contentEmpty = true;
    try {
      const { data, raw } = await s.call('epost_download_letter', { letter_id: 'inbox-1', output_dir: bad });
      assert.ok(!data.saved, `an empty answer was saved as a letter: ${raw.slice(0, 200)}`);
      assert.match(data.hint, /no bytes/, `it does not say what came back instead: ${raw.slice(0, 200)}`);

      const doc = await s.call('epost_read_storage_document', { letter_id: 'arch-1', output_dir: bad });
      assert.equal(doc.data.status, 'partial', `an empty answer was reported as a saved document: ${doc.raw.slice(0, 200)}`);
      assert.equal(doc.data.saved, null);
      assert.match(doc.data.error, /no bytes/);
      assert.equal(doc.data.id, 'arch-1', 'the metadata half is still reported');

      assert.deepEqual(readdirSync(bad), [], 'an empty file was written under a letter\'s name regardless');
    } finally {
      m.state.contentEmpty = false;
    }
  });

  test('a document that is not in Storage is reported as missing, not looked for elsewhere', async () => {
    // The API answered and there is no such document. Asking the browser the
    // same question, where "index" means something else entirely, is not a
    // fallback — it is a different question with a plausible-looking answer.
    const { data } = await s.call('epost_read_storage_document', { letter_id: 'not-a-document' });
    assert.match(data.error, /no such document in Storage/);
    assert.equal(data.letter_id, 'not-a-document');
  });

  test('a document read out of one folder reports that folder', async () => {
    // The scoped archive listing carries no folder field at all, so this came
    // back without one while the tool description promises the current folder —
    // even though the caller had just named it.
    const { data } = await s.call('epost_read_storage_document', { folder_id: 'dir-one', index: 0 });
    assert.equal(data.id, 'arch-1');
    assert.deepEqual(data.storedIn, ['Example_Alpha'], `no folder reported: ${JSON.stringify(data.storedIn)}`);
  });

  test('a folder whose name cannot be looked up is not reported as no folder at all', async () => {
    // The scoped listing knows which folder the document came from, because the
    // caller named it — but it only knows the id, and the name has to be
    // fetched. Written as a one-element array run through filter(Boolean), a
    // directory listing that did not answer left an EMPTY array behind: an
    // affirmative "in no folder" about the very document that had just been
    // read out of one, which is the answer that has a caller re-file the
    // archive. Absent means "not looked up", and that is the truth here.
    m.state.forceStatus.push({ path: '/epost/v2/archives/directories', status: 503 });
    const { data } = await s.call('epost_read_storage_document', { folder_id: 'dir-one', index: 0 });
    assert.equal(data.id, 'arch-1');
    assert.ok(!('storedIn' in data),
      `a folder nobody could name was reported as no folder: ${JSON.stringify(data.storedIn)}`);
  });

  test('a document read out of one folder reports every folder it is in, not just that one', async () => {
    // storedIn is "the folders a document is in", and an ePost document belongs
    // to as many as it likes. Scoping the lookup filled the field in with the
    // name of the folder the caller had asked about — the one membership we can
    // be sure of — so the same tool answered ["Example_Alpha"] here and
    // ["Example_Alpha","Example_Ümlaut"] about the very same document when
    // nobody scoped the question. A partial set presented as the set.
    m.state.inFolder['dir-two'].push('arch-1');          // arch-1 is now in both
    try {
      const scoped = await s.call('epost_read_storage_document', { folder_id: 'dir-one', index: 0 });
      const whole = await s.call('epost_read_storage_document', { letter_id: 'arch-1' });
      assert.equal(scoped.data.id, 'arch-1');
      assert.equal(whole.data.storedIn.length, 2, 'the fixture is supposed to put arch-1 in two folders');
      assert.deepEqual(scoped.data.storedIn, whole.data.storedIn,
        `scoping the lookup changed the answer about the same document: ${JSON.stringify(scoped.data.storedIn)}`);
    } finally {
      m.state.inFolder['dir-two'] = m.state.inFolder['dir-two'].filter(id => id !== 'arch-1');
    }
  });

  test('a folder that will not answer is not replaced by the whole of Storage', async () => {
    // The guard that keeps a folder-scoped question off the portal used to
    // probe the whole-archive listing instead of the scoped one — and that
    // listing tolerates a folder that fails and returns anyway. So the single
    // case it was written for got through: the folder asked about is the one
    // thing that will not answer, the scoped call comes back null, and the
    // portal — which has no notion of a folder — replies with every document in
    // Storage under the heading of that one folder.
    m.state.failDirectoryId = 'dir-one';
    const { raw } = await s.call('epost_list_storage_documents', { folder_id: 'dir-one' });
    m.state.failDirectoryId = null;
    assert.doesNotMatch(raw, /needs the browser/,
      `a question about one folder went to the portal, which answers with all of them: ${raw.slice(0, 160)}`);
    assert.match(raw, /folder_id needs the public API/);
    assert.match(raw, /drop folder_id/, 'it says what would work instead');
  });

  test('a folder the API says is not there is the API answering, not the API being down', async () => {
    // withApi keeps the two apart on purpose — a 404 is the service being
    // reached and answering "not here", recorded in apiRefusal with
    // apiUnavailable CLEARED — and both of these guards read the null it
    // returns as the API being unavailable. This is the likeliest 404 in the
    // whole API: a directory-id the caller is still holding from an earlier
    // epost_list_storage, for a folder since deleted in the portal. Answering
    // it with "the public API is unavailable, use the portal instead" sends the
    // caller to a transport that will hand back all of Storage — while
    // epost_settings, in the same process, still reports the API as working.
    for (const [tool, args] of [
      ['epost_list_storage_documents', { folder_id: 'dir-gone' }],
      ['epost_read_storage_document', { folder_id: 'dir-gone', index: 0 }],
    ]) {
      m.state.forceStatus.push({ path: '/epost/v2/archives/letters', status: 404 });
      const { raw } = await s.call(tool, args);
      assert.doesNotMatch(raw, /unavailable/, `${tool}: a 404 was read as the API being down: ${raw.slice(0, 200)}`);
      assert.doesNotMatch(raw, /portal/, `${tool}: it sent the caller to the browser for a question the API answered`);
      assert.match(raw, /dir-gone is not in Storage/, `${tool}: ${raw.slice(0, 200)}`);
      assert.match(raw, /404/, `${tool}: the reason the service gave is passed on`);
    }
    const { data } = await s.call('epost_settings');
    assert.doesNotMatch(data.api, /unavailable/,
      `the same process calls the API healthy while a tool called it unavailable: ${data.api}`);
  });

  test('a letter_id the inbox does not hold is answered here, not handed to the portal', async () => {
    // The API listed the inbox and the id is not in it. That is an answer, and
    // the portal cannot improve on it: it addresses letters by POSITION, so it
    // was handed the index nobody passed and — after launching a browser to get
    // there — reported "index undefined out of range (2 letters)", an error
    // about a parameter that was never part of the question. Pinned to the API
    // the same fall-through shows up as "needs the browser", which is just as
    // wrong about a request the API had already answered.
    const { raw } = await s.call('epost_download_letter', { letter_id: 'no-such-letter', output_dir: dir });
    assert.doesNotMatch(raw, /needs the browser/, `it went to the portal for an id the portal cannot use: ${raw.slice(0, 160)}`);
    assert.match(raw, /no letter no-such-letter in the inbox/);
    assert.match(raw, /epost_list_storage_documents/, 'it names the tool that would show it');
  });

  test('a letter_id whose content will not come is reported, not retried by position', async () => {
    // Same fall-through, second door: the id resolved, the document did not.
    m.state.forceStatus.push({ path: '/epost/v2/letters/inbox-1/content', status: 503 });
    const { raw } = await s.call('epost_download_letter', { letter_id: 'inbox-1', output_dir: dir });
    assert.doesNotMatch(raw, /needs the browser/, `it went to the portal for an id the portal cannot use: ${raw.slice(0, 160)}`);
    assert.match(raw, /content of letter inbox-1 could not be fetched/);
    assert.match(raw, /503/, 'the reason the API gave is passed on');
  });

  test('two ways of naming a Storage document is a question here too', async () => {
    // epost_store_letter was taught this; this one still let letter_id win over
    // index in silence, and the file name gave it away: the answer reported the
    // id's real position and then saved the PDF under the index it had NOT
    // used, so a second such call with the same date overwrote the first.
    const out = join(dir, 'ambiguous');
    const { data } = await s.call('epost_read_storage_document', { letter_id: 'arch-3', index: 0, output_dir: out });
    assert.match(data.error, /pass one of letter_id, index or title/);
    assert.match(data.error, /letter_id and index/);
    assert.ok(!existsSync(out), 'a document was read and saved for a request that named two of them');
  });

  test('a null beside the selector is not a second document', async () => {
    // The same rule as for archiving: a client that writes null into every
    // property it is not using has still named exactly one document.
    const { data } = await s.call('epost_read_storage_document', { letter_id: 'arch-3', index: null, title: null });
    assert.equal(data.id, 'arch-3', `an unambiguous call was refused as ambiguous: ${JSON.stringify(data)}`);
  });

  test('an empty string beside the selector is not a second document either', async () => {
    // Same client, other habit: "" goes into the string properties it has
    // nothing for. Counting those made {letter_id:"",title:"",index:2} a call
    // naming three documents, while epost_download_letter took the same
    // arguments and answered.
    const { data } = await s.call('epost_read_storage_document', { letter_id: '', title: '', index: 2 });
    assert.equal(data.id, 'arch-3', `an unambiguous call was refused as ambiguous: ${JSON.stringify(data)}`);
  });

  test('two documents at position 0 of two different listings are not one file', async () => {
    // The saved name was assembled from `index` — but index means a position in
    // the listing the answer came from, and folder_id decides which listing that
    // is. So {index:0} and {folder_id:…,index:0} name two DIFFERENT documents,
    // and with the archive's usual crop of same-day dates they were assembled
    // into one and the same path: the second call silently overwrote the file
    // the first had just reported as its own, and nothing downstream could tell.
    const out = mkdtempSync(join(tmpdir(), 'epost-collide-'));
    const whole = await s.call('epost_read_storage_document', { index: 0, output_dir: out });
    const scoped = await s.call('epost_read_storage_document', { folder_id: 'dir-two', index: 0, output_dir: out });
    assert.notEqual(whole.data.id, scoped.data.id, 'the fixture is supposed to make these two different documents');
    assert.notEqual(whole.data.saved, scoped.data.saved,
      `two documents were saved to one path: ${whole.data.saved}`);
    // The id is in the bytes, so a file holding the wrong document is visible.
    assert.match(readFileSync(whole.data.saved).toString(), new RegExp(whole.data.id),
      'the first file holds the second document');
    assert.match(readFileSync(scoped.data.saved).toString(), new RegExp(scoped.data.id));
  });

  test('a document whose content cannot be fetched is a partial result, not a success', async () => {
    // Asking for the file and being told "ok" with nothing saved is a wrong
    // answer about half the request, and nothing downstream can tell.
    m.state.forceStatus.push({ path: '/epost/v2/letters/arch-1/content', status: 500 });
    const { data } = await s.call('epost_read_storage_document', { letter_id: 'arch-1', output_dir: dir });
    assert.equal(data.status, 'partial');
    assert.equal(data.saved, null);
    assert.match(data.error, /the file was not saved/);
    assert.equal(data.id, 'arch-1', 'the metadata half is still reported');
  });

  test('a folder that cannot be listed is not folded into "in no folder"', async () => {
    // The archive listing carries no folder field, so membership is derived by
    // asking each folder what it holds. A folder that fails to answer leaves
    // the documents it would have named UNKNOWN — which is the opposite of
    // unfiled, and a caller acting on the difference re-files the archive.
    // Both used to arrive as a missing storedIn, because null and undefined
    // were run through the same ?? chain.
    const whole = await s.call('epost_list_storage_documents');
    const unfiled = whole.data.documents.find(d => d.id === 'arch-2');
    assert.equal(unfiled.storedIn, null,
      `a document known to be in no folder must say so, not stay silent: ${JSON.stringify(unfiled)}`);

    m.state.failDirectoryId = 'dir-two';
    const partial = await s.call('epost_list_storage_documents');
    m.state.failDirectoryId = null;
    const unknown = partial.data.documents.find(d => d.id === 'arch-3');
    assert.ok(!('storedIn' in unknown),
      `a membership nobody could look up was reported anyway: ${JSON.stringify(unknown)}`);
    assert.notEqual(JSON.stringify(unknown), JSON.stringify({ ...unknown, storedIn: unfiled.storedIn }),
      'a folder that could not be listed reads exactly like a document in no folder');
  });

  test('a document addressed by id reports where it actually sits', async () => {
    // index is the handle the other Storage tools take. This answered 0
    // whatever was asked for, so filing "the one that was just read" by that
    // index moved whichever document happened to be first instead.
    const listed = await s.call('epost_list_storage_documents');
    const want = listed.data.documents.find(d => d.id === 'arch-3');
    assert.equal(want.index, 2, 'the fixture is supposed to put arch-3 third');
    const { data } = await s.call('epost_read_storage_document', { letter_id: 'arch-3' });
    assert.equal(data.id, 'arch-3');
    assert.equal(data.index, want.index, 'it reported another document\'s position');
  });

  test('a letter that does not exist is the API answering, not the API being down', async () => {
    // A 404 means the service was reached, authenticated and asked. Recording
    // it as unavailability made epost_settings report the whole API as broken
    // until some later call happened to succeed.
    await s.call('epost_unread_count');
    const nope = await s.call('epost_get_letter', { letter_id: 'no-such-letter' });
    assert.match(nope.data.error, /not found/);
    assert.match(nope.data.hint, /404/, 'the reason is still passed on to the caller');
    const { data } = await s.call('epost_settings');
    assert.doesNotMatch(data.api, /unavailable/, `a 404 was read as the API being down: ${data.api}`);
    assert.match(data.api, /password grant/);
  });

  test('a letter listing that fails is not read as an empty inbox', async () => {
    // The folders came back and the letters did not, so the id cannot be
    // resolved. This used to fall through to the portal, which addresses
    // letters by position and would happily archive whatever sat there.
    m.state.forceStatus.push({ path: '/epost/v2/letters', status: 500 });
    const { data } = await s.call('epost_store_letter', { letter_id: 'inbox-1', folder: 'Example_Alpha' });
    assert.match(data.error, /letter_id needs the public API/);
    assert.match(data.note, /index or title/, 'it says what would work instead');
    assert.ok(!m.state.archive.some(l => l.id === 'inbox-1'), 'something was archived regardless');
  });

  test('an archive the service would not carry out is reported, not retried by position', async () => {
    // Third door into the same room, and the last one still open: the folders
    // came back, the id resolved, and the PATCH did not. Falling through from
    // there hands an id to a portal that addresses letters by POSITION — so it
    // gets the index nobody passed, after launching a browser to arrive at it.
    // epost_download_letter had both of its doors shut two rounds ago; this
    // tool only ever had the "no such id" one. Pinned to the API the same
    // fall-through surfaces as a complaint about the pin, which says nothing
    // about the letter that is still sitting in the inbox.
    for (const status of [503, 404]) {
      m.state.forceStatus.push({ path: '/epost/v2/letters/inbox-1/archive', status });
      const { raw, data } = await s.call('epost_store_letter', { letter_id: 'inbox-1', folder: 'Example_Alpha' });
      assert.doesNotMatch(raw, /needs the browser|EPOST_TRANSPORT/,
        `${status}: it went to the portal for an id the portal cannot use: ${raw.slice(0, 200)}`);
      assert.match(data.error, /letter inbox-1 could not be archived/, `${status}: ${raw.slice(0, 200)}`);
      assert.match(data.hint, new RegExp(String(status)), 'the reason the API gave is passed on');
      // Not "it is still in the inbox": a 404 from the archive call is what a
      // letter archived from another session looks like, and claiming to know
      // would be the same guess one layer down.
      assert.match(data.note, /nothing was filed/);
      assert.ok(m.state.inbox.some(l => l.id === 'inbox-1'), `${status}: the letter left the inbox anyway`);
      assert.ok(!m.state.archive.some(l => l.id === 'inbox-1'), `${status}: it was archived anyway`);
    }
    // And an index the portal CAN honour still falls through to it, rather than
    // being refused along with the id.
    m.state.forceStatus.push({ path: '/epost/v2/letters/inbox-1/archive', status: 503 });
    const { raw } = await s.call('epost_store_letter', { index: 0, folder: 'Example_Alpha' });
    assert.match(raw, /needs the browser|EPOST_TRANSPORT/,
      `a position the portal can resolve was refused too: ${raw.slice(0, 200)}`);
  });

  test('a refusal is a refusal however the letter was addressed', async () => {
    // The fall-through above is right for a service that could not answer. It
    // is wrong for one that answered no, and that is the whole reason withApi
    // rethrows a 4xx instead of returning null: "treating it as unavailable
    // would silently retry the operation through the browser, where it may do
    // something subtly different, or hand the caller a fallback result for a
    // request the service rejected." Last round caught that rethrow so the tool
    // could report it — and then reported it only when the caller had passed a
    // letter_id. An index or a title carried on into the portal exactly as
    // before, so a 400 the service had just answered with became a browser
    // launch and a store of whatever happens to sit at that position, in a list
    // the portal numbers differently from the API. Before the catch existed the
    // same 400 at least came back as an error.
    for (const sel of [{ index: 0 }, { title: 'inbox-2' }]) {
      const how = JSON.stringify(sel);
      m.state.forceStatus.push({ path: '/epost/v2/letters/inbox-1/archive', status: 400 });
      m.state.forceStatus.push({ path: '/epost/v2/letters/inbox-2/archive', status: 400 });
      const { raw, data } = await s.call('epost_store_letter', { ...sel, folder: 'Example_Alpha' });
      m.state.forceStatus.length = 0;
      assert.doesNotMatch(raw, /needs the browser|EPOST_TRANSPORT/,
        `${how}: a request the service refused was handed to the portal to try again: ${raw.slice(0, 200)}`);
      assert.match(data.error || raw, /could not be archived/, `${how}: ${raw.slice(0, 200)}`);
      assert.match(data.hint || raw, /400/, `${how}: the refusal the service gave is passed on`);
      assert.match(data.note || raw, /nothing was filed/, `${how}: ${raw.slice(0, 200)}`);
    }
  });

  test('and a 404 is a refusal too, whichever way the letter was named', async () => {
    // The two tests above were written in the same round and never crossed:
    // one tried 503 and 404 with a letter_id, the other tried 400 with an index
    // and a title. Nobody tried 404 with an index, and that is the one square
    // the fix did not cover — because "the service answered no" was read off
    // the THROW, and only some of its noes throw. withApi rethrows a 4xx so the
    // tool can report it and makes an exception of 404, turning that one into a
    // null with the reason in apiRefusal. The same round's own apiEmptyHanded
    // exists to say that this null is the service "being reached and answering
    // not here" for any call carrying the letter id in its URL, and the archive
    // PATCH carries it. So the identical situation came back as a sentence when
    // the service said 400 and as a browser launch when it said 404 — which
    // then archives whatever sits at that position in a list the portal numbers
    // differently, and reports it as done.
    for (const sel of [{ index: 0 }, { title: 'inbox-2' }]) {
      const how = JSON.stringify(sel);
      m.state.forceStatus.push({ path: '/epost/v2/letters/inbox-1/archive', status: 404 });
      m.state.forceStatus.push({ path: '/epost/v2/letters/inbox-2/archive', status: 404 });
      const { raw, data } = await s.call('epost_store_letter', { ...sel, folder: 'Example_Alpha' });
      m.state.forceStatus.length = 0;
      assert.doesNotMatch(raw, /needs the browser|EPOST_TRANSPORT/,
        `${how}: a 404 the service answered was handed to the portal to try again: ${raw.slice(0, 200)}`);
      assert.match(data.error || raw, /could not be archived/, `${how}: ${raw.slice(0, 200)}`);
      assert.match(data.hint || raw, /404/, `${how}: the answer the service gave is passed on`);
      assert.match(data.note || raw, /nothing was filed/, `${how}: ${raw.slice(0, 200)}`);
      assert.ok(m.state.inbox.some(l => l.id === 'inbox-1'), `${how}: the letter left the inbox anyway`);
    }
    // The other branch is unchanged: a service that could not answer AT ALL is
    // still worth a second try by a position the portal can resolve, and the
    // 503 above is that case. Losing it would turn one wrong answer into the
    // opposite one.
    m.state.forceStatus.push({ path: '/epost/v2/letters/inbox-1/archive', status: 503 });
    const { raw } = await s.call('epost_store_letter', { index: 0, folder: 'Example_Alpha' });
    m.state.forceStatus.length = 0;
    assert.match(raw, /needs the browser|EPOST_TRANSPORT/,
      `a position the portal can resolve was refused for an API that never answered: ${raw.slice(0, 200)}`);
  });

  test('an id the service has never heard of is not a broken transport', async () => {
    // ed6806d taught the two folder-scoped guards that withApi's null means two
    // things and that a 404 is not "the API is unavailable" — it is the service
    // being reached and answering "not here", recorded in apiRefusal with
    // apiUnavailable CLEARED. The tools that act on ONE named letter were left
    // saying "needs the API" about an id with a typo in it, with the 404 that
    // says otherwise sitting in the hint directly underneath, while
    // epost_settings in the same process reports the API as working.
    // epost_get_letter, the sibling that was looked at, names both.
    for (const [tool, args] of [
      ['epost_restore_letter', { letter_id: 'no-such-letter' }],
      ['epost_delete_letter', { letter_id: 'no-such-letter', confirm: true }],
      ['epost_download_thumbnail', { letter_id: 'no-such-letter', output_path: join(dir, 'no-such.png') }],
    ]) {
      const { data, raw } = await s.call(tool, args);
      assert.doesNotMatch(data.error || raw, /needs the API/,
        `${tool}: a 404 was reported as the transport being unusable: ${raw.slice(0, 200)}`);
      assert.match(raw, /404/, `${tool}: the reason the service gave is passed on`);
      assert.match(raw, /no-such-letter/, `${tool}: it does not name what was asked for`);
    }
    const { data } = await s.call('epost_settings');
    assert.doesNotMatch(data.api, /unavailable/,
      `the same process calls the API healthy while a tool called it unusable: ${data.api}`);
  });
});

// An inbox nobody has archived in a while. The tools that resolve a letter_id
// ask for a window of the inbox and used to read the edge of that window as the
// edge of the letterbox.
describe('an inbox longer than one listing', () => {
  let m, s, dir;
  before(async () => {
    m = await start();
    dir = mkdtempSync(join(tmpdir(), 'epost-window-'));
    // 300 letters past the first, so the window the tools ask for comes back
    // exactly full and the one being asked about sits beyond it.
    const proto = JSON.parse(JSON.stringify(m.state.inbox[0]));
    for (let i = 0; i < 300; i++) m.state.inbox.push({ ...proto, id: `bulk-${i}`, fileName: `bulk-${i}.pdf` });
    s = await startServer({ EPOST_API_BASE: m.base, EPOST_TRANSPORT: 'api' });
  });
  after(async () => { s?.stop(); await m?.close(); });

  test('a letter past the window is not reported as one that left the inbox', async () => {
    // "no letter X in the inbox — it may already be archived, look in Storage"
    // was said about a letter sitting in the inbox, and the caller was sent
    // looking for it somewhere it had never been. The window is a property of
    // our own request, not of the letterbox.
    const id = 'bulk-299';
    assert.ok(m.state.inbox.some(l => l.id === id), 'the fixture is supposed to keep it in the inbox');
    const { data, raw } = await s.call('epost_store_letter', { letter_id: id, folder: 'Example_Alpha' });
    assert.equal(data.transport, 'api', `a letter in the inbox was refused: ${raw.slice(0, 200)}`);
    assert.ok(m.state.inFolder['dir-one'].includes(id), 'it was never actually filed');
    assert.ok(!m.state.inbox.some(l => l.id === id), 'it did not leave the inbox');
  });

  test('and can still be downloaded by id', async () => {
    const id = 'bulk-298';
    const { data, raw } = await s.call('epost_download_letter', { letter_id: id, output_dir: dir });
    assert.ok(data.saved, `a letter in the inbox could not be downloaded: ${raw.slice(0, 200)}`);
    // The id is in the bytes, so a download that fetched a neighbour shows up.
    assert.match(readFileSync(data.saved).toString(), new RegExp(id), 'it fetched a different letter');
  });

  test('an id that really is nowhere is still answered as missing', async () => {
    // The second lookup must not turn every unknown id into a call that hangs
    // about: a 404 there is the service saying the letter does not exist, and
    // that is the answer the caller gets.
    const { data } = await s.call('epost_store_letter', { letter_id: 'no-such-letter', folder: 'Example_Alpha' });
    assert.match(data.error, /no letter no-such-letter in the inbox/);
    assert.match(data.hint, /epost_list_storage_documents/);
  });

  test('a substring is not resolved against a window either', async () => {
    // letterInWindow was written for the id one line up. The title beside it
    // still read the edge of our own request as the edge of the inbox — and a
    // title is resolved by oneByTitle, whose entire job is to refuse to guess:
    // it counts the matches and will not act on more than one, because "the
    // first row containing this text" archives a neighbour just as readily as
    // the intended letter. Counted inside a window, that count is not the
    // letterbox's. "bulk-25" names eleven letters here, ten of them past the
    // 200 this asks for, so the one substring that is REFUSED as ambiguous
    // against a short inbox quietly filed the first of the eleven against a
    // long one. An id can be checked past the window; a substring cannot.
    const matches = m.state.inbox.filter(l => JSON.stringify(l).includes('bulk-25'));
    assert.ok(matches.length > 1, `the fixture is supposed to repeat this substring: ${matches.length}`);
    const { data, raw } = await s.call('epost_store_letter', { title: 'bulk-25', folder: 'Example_Alpha' });
    assert.ok(!data.transport, `it picked one of ${matches.length} letters: ${raw.slice(0, 200)}`);
    assert.match(data.error || raw, /bulk-25/);
    assert.match(raw, /200|window|longer/, `it does not say why it cannot answer: ${raw.slice(0, 200)}`);
    assert.match(data.hint || raw, /letter_id/, 'and it does not say what would work instead');
    for (const l of matches) {
      assert.ok(!m.state.inFolder['dir-one'].includes(l.id), `${l.id} was filed anyway`);
    }
  });

  test('a letter the service says is already archived is answered, not thrown', async () => {
    // The second lookup is not scoped to the inbox: it asks the service about
    // one id and the service answers about letters wherever they are. So a
    // letter that left the inbox weeks ago resolves here on any inbox long
    // enough to fill the window — bulk-299 was archived by the first test in
    // this block — and the archive call is what refuses it, in the service's
    // own words. withApi rethrows a 4xx precisely so the tool can report it,
    // and nobody did: it left through the outer catch as `ERROR: PATCH
    // /epost/v2/letters/…/archive -> 400 {"error":"bad_request",…}`, a raw
    // upstream body where the very same question against a SHORT inbox gets
    // the guard's own sentence. One question, one answer.
    assert.ok(m.state.archive.some(l => l.id === 'bulk-299'), 'the block above is supposed to have archived it');
    const { data, raw, isError } = await s.call('epost_store_letter', { letter_id: 'bulk-299', folder: 'Example_Alpha' });
    assert.ok(!isError, `the service's refusal escaped unhandled: ${raw.slice(0, 200)}`);
    assert.match(data.error, /letter bulk-299 could not be archived/, raw.slice(0, 200));
    assert.match(data.hint, /already archived/i, "the service's own words are passed on");
    assert.match(data.note, /nothing was filed/);
  });
});

// The same window one listing up. Storage is a listing too, and the tool that
// resolves a document against it read the edge of its page as the edge of the
// archive — the defect the block above fixed for the inbox, in the sibling that
// was not looked at.
describe('an archive longer than one listing', () => {
  let m, s;
  before(async () => {
    m = await start();
    // Past the 1000 the Storage tools ask for, so the listing comes back
    // exactly full and the document being asked about sits beyond it. The last
    // of them is filed, so it is emphatically in Storage and in a folder.
    const proto = JSON.parse(JSON.stringify(m.state.archive[0]));
    for (let i = 0; i < 1200; i++) m.state.archive.push({ ...proto, id: `bulk-${i}`, fileName: `bulk-${i}.pdf` });
    m.state.inFolder['dir-one'].push('bulk-1199');
    s = await startServer({ EPOST_API_BASE: m.base, EPOST_TRANSPORT: 'api' });
  });
  after(async () => { s?.stop(); await m?.close(); });

  test('a document past the window is not reported as one that is not in Storage', async () => {
    const { data, raw } = await s.call('epost_read_storage_document', { letter_id: 'bulk-1199' });
    assert.doesNotMatch(raw, /no such document in Storage/,
      `a document sitting in Storage was reported as not being there: ${raw.slice(0, 200)}`);
    assert.match(data.error, /first 1000 of Storage/, raw.slice(0, 200));
    assert.match(data.hint, /raise limit/, 'and says what would reach it');
  });

  test('and raising the limit reaches it, folder and all', async () => {
    // The limit has to travel into the membership lookup as well: that one
    // asks each folder what it holds, and it was pinned to 1000 of its own.
    const { data, raw } = await s.call('epost_read_storage_document', { letter_id: 'bulk-1199', limit: 2000 });
    assert.equal(data.id, 'bulk-1199', `still out of reach: ${raw.slice(0, 200)}`);
    assert.deepEqual(data.storedIn, ['Example_Alpha'], `no folder reported: ${JSON.stringify(data.storedIn)}`);
  });

  test('an id that really is nowhere is still answered plainly', async () => {
    // A listing shorter than the window has answered the question, and hedging
    // there would send every caller off to raise a limit for nothing.
    const { data } = await s.call('epost_read_storage_document', { letter_id: 'no-such-doc', limit: 2000 });
    assert.match(data.error, /no such document in Storage/);
  });

  test('and a substring is not resolved against the window it came back in', async () => {
    // The same sibling as in the inbox block: the not-found answer learned that
    // a full page proves nothing about what lies past it, and the substring
    // resolved against that page did not. oneByTitle refuses to act on more
    // than one match — "Storage cards show only a date, and dates repeat" — so
    // counting the matches in a window turns the refusal into a guess.
    // "bulk-119" names eleven documents, ten of them past the default 1000.
    const matches = m.state.archive.filter(l => JSON.stringify(l).includes('bulk-119'));
    assert.ok(matches.length > 1, `the fixture is supposed to repeat this substring: ${matches.length}`);
    const { data, raw } = await s.call('epost_read_storage_document', { title: 'bulk-119' });
    assert.ok(!data.id, `it picked one of ${matches.length} documents: ${raw.slice(0, 200)}`);
    assert.match(data.error || raw, /bulk-119/);
    assert.match(data.hint || raw, /limit|letter_id/, `it does not say what would work instead: ${raw.slice(0, 200)}`);
    // Raising the window past the archive makes it answerable again — and the
    // answer is the refusal oneByTitle was written to give.
    const { raw: wide } = await s.call('epost_read_storage_document', { title: 'bulk-119', limit: 2000 });
    assert.match(wide, new RegExp(`matches ${matches.length} letters`),
      `with the whole archive in view it still did not count them: ${wide.slice(0, 200)}`);
  });
});

// The inbox renumbers itself after every store, so the position a caller passed
// is not a name.
describe('naming a downloaded letter', () => {
  let m, s, dir;
  before(async () => {
    m = await start();
    dir = mkdtempSync(join(tmpdir(), 'epost-rename-'));
    s = await startServer({ EPOST_API_BASE: m.base, EPOST_TRANSPORT: 'api' });
  });
  after(async () => { s?.stop(); await m?.close(); });

  test('two letters that were each index 0 are not one file', async () => {
    // The saved name was assembled from the index the caller passed, and the
    // tool's own description warns that indices shift after every store. So
    // {index:0} before an archive and {index:0} after it are two DIFFERENT
    // letters, and with the letterbox's usual crop of same-day dates they were
    // assembled into one and the same path: the second call silently overwrote
    // the file the first had just reported as its own. ed6806d fixed precisely
    // this in epost_read_storage_document — "the id is the one thing that
    // identifies exactly one document" — and left the sibling numbering.
    const first = await s.call('epost_download_letter', { index: 0, output_dir: dir });
    assert.ok(first.data.saved, `nothing saved: ${first.raw.slice(0, 160)}`);
    assert.match(readFileSync(first.data.saved).toString(), /inbox-1/, 'it fetched a different letter');

    await s.call('epost_store_letter', { letter_id: 'inbox-1', folder: 'Example_Alpha' });
    assert.equal(m.state.inbox[0].id, 'inbox-2', 'the fixture is supposed to renumber the inbox');

    const second = await s.call('epost_download_letter', { index: 0, output_dir: dir });
    assert.ok(second.data.saved, `nothing saved: ${second.raw.slice(0, 160)}`);
    assert.notEqual(first.data.saved, second.data.saved,
      `two different letters were saved to one path: ${second.data.saved}`);
    // The id is in the bytes, so a file holding the wrong letter is visible.
    assert.match(readFileSync(first.data.saved).toString(), /inbox-1/,
      'the first file now holds the second letter');
    assert.match(readFileSync(second.data.saved).toString(), /inbox-2/);
  });
});

describe('what only the API can answer, when there is no API', () => {
  let s;
  before(async () => {
    // No credentials at all, and a browser path that cannot start either: these
    // arguments have no meaning in the portal, so the answer must be a refusal
    // and not an attempt to launch something.
    s = await startServer({
      EPOST_API_BASE: mock.base, EPOST_API_PASSWORD: '', EPOST_SWISSID_USER: '', EPOST_API_KEY: '',
      EPOST_BROWSER: '/definitely/not/a/browser',
    });
  });
  after(() => s?.stop());

  const refused = (raw, what) => {
    assert.match(raw, /needs the public API and it is unavailable/, `${what}: not refused`);
    assert.ok(!/EPOST_BROWSER|looked at/.test(raw), `${what}: it tried to launch a browser instead`);
  };

  test('a letter_id cannot be honoured by the portal', async () => {
    const { raw } = await s.call('epost_download_letter', { letter_id: 'inbox-1', output_dir: '/tmp' });
    refused(raw, 'epost_download_letter');
  });

  test('a folder_id cannot be honoured by the portal', async () => {
    // The portal lists everything. Falling through with one set answered "all
    // of Storage" to a question about one folder, and the caller could not tell.
    const { raw } = await s.call('epost_list_storage_documents', { folder_id: 'dir-one' });
    refused(raw, 'epost_list_storage_documents');
  });

  test('reading a Storage document by id cannot be honoured by the portal', async () => {
    const { raw } = await s.call('epost_read_storage_document', { letter_id: 'arch-1' });
    refused(raw, 'epost_read_storage_document');
  });
});
