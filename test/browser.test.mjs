// Drives the portal automation against a local DOM fixture. These are the paths
// that broke repeatedly in the real portal — identical menu text on every card,
// a selector shared with decorative blocks, an off-screen folder strip, and
// umlauts in a different Unicode normalisation — so they are worth pinning down
// somewhere that cannot change under us.
import { test, before, after, describe } from 'node:test';

const SLOW = { timeout: 120000 };   // per-test budget for anything driving a browser
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
    // The portal lands on a dashboard and the automation clicks through to the
    // letterbox. Asserting only "an array came back" passed just as happily
    // when the browser never launched, which is how a broken run stayed green.
    const { data } = await srv.call('epost_list_letters');
    assert.equal(data.transport, 'browser', 'both paths now name the transport they answered on');
    const letters = Array.isArray(data) ? data : data.letters;
    assert.ok(Array.isArray(letters), `no letter list came back: ${JSON.stringify(data).slice(0, 120)}`);
    assert.equal(letters.length, 2, 'the fixture serves exactly two letters');
    // `date` is the field the API path reports, so a client that falls back
    // from one transport to the other must still find it here.
    assert.deepEqual(letters.map(l => l.date), ['01.01.2020', '02.02.2020']);
    assert.deepEqual(letters.map(l => l.sender), ['ePost Scancenter', 'ePost Scancenter']);
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

  test('a store the portal will not accept is refused, not reported as archived', SLOW, async () => {
    // Clicking Store is not storing. The portal says no the only way it ever
    // says anything about a sheet — by leaving it standing — and nothing below
    // the click ever looked at the page again. The click's own failure has to be
    // swallowed, because Playwright throws at the settle timeout over a click
    // that landed perfectly well, so the evidence for "archived" was that a line
    // of code had run: `status: ok` with the letter still in the inbox and an
    // open overlay left to swallow the next call's clicks. epost_move_to_folder
    // drives this very sheet and has read the signal for two rounds.
    const before = portal.state.stored.length;
    portal.state.refuseCommit = true;
    try {
      const { data, raw } = await srv.call('epost_store_letter', { index: 0, folder: 'Example_Alpha' });
      assert.equal(data.status, 'refused',
        `a store that never happened was reported as done: ${raw.slice(0, 200)}`);
      assert.match(data.hint, /nothing was filed/, 'it says plainly that the letter was not archived');
      assert.equal(portal.state.stored.length, before, 'the sheet was committed after all');
    } finally {
      portal.state.refuseCommit = false;
    }
  });

  test('a sheet that never opened is not a sheet that went away', SLOW, async () => {
    // The refusal above is read from the sheet still standing, so its absence
    // is the whole of the evidence for "archived" — and a sheet that never
    // opened is absent too. The overlay lives in the DOM the entire time and is
    // only toggled hidden, the way PrimeFaces builds every dialog, so when the
    // menu item failed to open it the tile lookup (which must not filter on
    // visibility, because the strip scrolls sideways) found the hidden tiles
    // and ticked one, the forced click on the hidden Store button threw and was
    // swallowed, and waiting for "hidden" was satisfied by a sheet that had
    // never been shown. `status: ok` for a letter still in the inbox.
    // createFolder, the same two-step shape, has always let its dialog's
    // waitFor throw rather than throwing the answer away.
    const before = portal.state.stored.length;
    portal.state.sheetStuck = true;
    try {
      const { data, raw, isError } = await srv.call('epost_store_letter', { index: 0, folder: 'Example_Alpha' });
      assert.ok(isError || data.status === 'refused',
        `a store into a sheet that never opened was reported as done: ${raw.slice(0, 200)}`);
      assert.match(raw, /did not open|nothing was filed/,
        `it does not say the sheet never opened: ${raw.slice(0, 200)}`);
      assert.equal(portal.state.stored.length, before, 'the sheet was committed after all');
    } finally {
      portal.state.sheetStuck = false;
    }
  });

  test('downloads a letter to disk', SLOW, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epost-dl-'));
    const { data, raw } = await srv.call('epost_download_letter', { index: 0, output_dir: dir });
    assert.ok(data.saved, `no file saved: ${raw.slice(0, 120)}`);
    assert.ok(existsSync(data.saved));
    assert.ok(readFileSync(data.saved).toString().startsWith('%PDF'), 'a real PDF, not an error page');
  });

  test('lists the Storage folders with their counts, and keeps the company one out', SLOW, async () => {
    // "these are present" passed while the ePost Scancenter tile — a branded
    // folder the service maintains, and not a filing target — was offered as a
    // destination the move sheet will never accept. The exact set is the point.
    const { data } = await srv.call('epost_list_storage');
    const names = (data.folders || []).map(f => f.name.normalize('NFC')).sort();
    assert.deepEqual(names, ['Example_Alpha', 'Example_Ümlaut'], `wrong folder set: ${JSON.stringify(names)}`);
    assert.deepEqual((data.companyFolders || []).map(f => f.name), ['ePost Scancenter'],
      'the company folder is reported, separately');
  });

  test('creates a folder', SLOW, async () => {
    // The reply used to be thrown away, so this stayed green while the tool
    // reported a refusal — which it now can, and the fixture must therefore
    // close its dialog like the real portal does on success.
    const { data } = await srv.call('epost_create_folder', { name: 'Neu_Angelegt' });
    assert.equal(data.status, 'ok', `creation was not reported as done: ${JSON.stringify(data)}`);
    assert.equal(data.created, 'Neu_Angelegt');
    assert.ok(portal.state.created.includes('Neu_Angelegt'), 'the portal received the new name');
  });

  test('moves into a folder whose name the portal serves decomposed', SLOW, async () => {
    // The store sheet matched folder names byte-exactly, so the one name that
    // arrives NFD — the whole reason this fixture has an umlaut — could be
    // listed but never moved into.
    const before = portal.state.stored.length;
    const { data, raw } = await srv.call('epost_move_to_folder', { index: 1, folder: 'Example_Ümlaut' });
    assert.ok(data.status === 'ok' || /ok/.test(raw), `move failed: ${raw.slice(0, 160)}`);
    assert.ok(portal.state.stored.length > before, 'the sheet was committed');
    assert.ok(portal.state.stored.at(-1).folders.some(f => f.normalize('NFC') === 'Example_Ümlaut'),
      `the wrong folder was ticked: ${JSON.stringify(portal.state.stored.at(-1))}`);
  });

  test('re-files a document, dropping the old folder in the same sheet', SLOW, async () => {
    const before = portal.state.stored.length;
    const { data, raw } = await srv.call('epost_move_to_folder', {
      index: 0, folder: 'Example_Beta', remove_from: 'Example_Alpha',
    });
    assert.ok(data.status === 'ok' || /ok/.test(raw), `move failed: ${raw.slice(0, 120)}`);
    assert.ok(portal.state.stored.length > before, 'the sheet was committed');
  });

  test('a login step that has not rendered yet is tried again, and never authenticates', SLOW, async () => {
    // Two things at once, because the window is thirty seconds either way.
    //
    // The fixture cannot finish a SwissID login, so this must report
    // login_required rather than claim a session. 30 is the documented minimum
    // — anything shorter is clamped, and a test that asked for five seconds and
    // waited thirty implied a promise the code never made.
    //
    // And the e-mail step: the fixture's login page renders its input three
    // seconds after the redirect lands, exactly as the real one does. A step
    // that is written off after one look never sees the field, so the e-mail is
    // never submitted and the login sits there until the window runs out. The
    // submitted address is the only proof that the step was tried again.
    portal.state.loginFlow = true;
    try {
      const started = Date.now();
      const { data } = await srv.call('epost_login', { wait_seconds: 30 });
      assert.ok(Date.now() - started >= 29000, 'it returned before the window it was given');
      assert.equal(data.status, 'login_required',
        'no authenticated session exists, so login must not claim one');
      assert.ok(data.hint || data.browser, 'it says what the caller should do next');
      assert.deepEqual(portal.state.loginEmails, ['test@example.invalid'],
        'the e-mail step was written off on the first pass, before the field existed');
    } finally {
      portal.state.loginFlow = false;
    }
  });

  test('reports the session state', SLOW, async () => {
    const { data } = await srv.call('epost_status');
    assert.equal(data.status, 'ok', 'the fixture presents a reachable letterbox');
  });

  test('downloads every letter in one go', SLOW, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'epost-all-'));
    const { data, raw } = await srv.call('epost_download_all', { output_dir: dir });
    // "at least one" passed for an implementation that stopped after the first.
    // The fixture serves exactly two, and they must be two different files.
    assert.equal(data.count, 2, `expected both letters: ${raw.slice(0, 140)}`);
    assert.equal(data.saved.length, 2);
    assert.equal(new Set(data.saved).size, 2, 'the second overwrote the first');
    for (const f of data.saved) {
      assert.ok(existsSync(f));
      assert.ok(readFileSync(f).toString().startsWith('%PDF'), `not a PDF: ${f}`);
    }
  });

  test('unfiling a document is refused when it would empty the folder set', SLOW, async () => {
    // The portal will not commit an empty selection: it just leaves the sheet
    // open. The tool used to click Move and report success regardless, telling
    // the caller a document had left a folder it was still in. This assertion
    // used to be `msg.length > 0`, which held however broken the code was.
    const before = portal.state.stored.length;
    const { data } = await srv.call('epost_unfile_from_folder', { index: 0, folder: 'Example_Alpha' });
    assert.equal(data.status, 'refused', `expected a refusal, got ${JSON.stringify(data)}`);
    assert.match(data.hint, /no folder at all/, 'it explains why, and what to do instead');
    assert.equal(portal.state.stored.length, before, 'and nothing was committed');
  });

  test('a successful unfile is reported as an unfile, not as a move', SLOW, async () => {
    // The result said `moved` with the folder that had just been removed —
    // the opposite of what happened. Example_Beta holds two documents after
    // the re-file above, so dropping one of them is a legal operation.
    const { data } = await srv.call('epost_unfile_from_folder', { index: 2, folder: 'Example_Ümlaut' });
    assert.ok(!data.moved, `reported as a move: ${JSON.stringify(data)}`);
    assert.ok(data.unfiled || data.status === 'refused', `neither unfiled nor refused: ${JSON.stringify(data)}`);
  });

  test('tool calls that arrive together share one browser', SLOW, async () => {
    // Two launchPersistentContext calls against one profile collide on Chrome's
    // ProcessSingleton: one fails outright, and the stale-lock retry then
    // deletes the lock the other is holding. A client is free to pipeline
    // requests, so this is not an exotic case.
    // They also navigate to three different pages on the same tab, so checking
    // only that nobody errored would stay green while each call was handed the
    // page another one had just loaded. Each answer has to be its own.
    const [status, storage, letters] = await Promise.all([
      srv.call('epost_status'), srv.call('epost_list_storage'), srv.call('epost_list_letters'),
    ]);
    for (const { raw } of [status, storage, letters]) {
      assert.ok(!/ProcessSingleton|SingletonLock/.test(raw), `a concurrent launch collided: ${raw.slice(0, 120)}`);
      assert.ok(!/^ERROR/.test(raw), `a concurrent call failed: ${raw.slice(0, 120)}`);
    }
    assert.equal(status.data.status, 'ok');
    assert.ok((storage.data.folders || []).some(f => f.name.normalize('NFC') === 'Example_Alpha'),
      `the storage call got somebody else's page: ${JSON.stringify(storage.data).slice(0, 140)}`);
    assert.equal(letters.data.count, 2,
      `the letters call got somebody else's page: ${JSON.stringify(letters.data).slice(0, 140)}`);
  });

  test('a title that matches two documents is refused, not guessed at', SLOW, async () => {
    // Storage cards show only a date, and the fixture has two on 04.04.2020 —
    // exactly the case the portal produces constantly. Taking the first match
    // moved, read or archived a neighbour just as readily as the right one.
    const { raw } = await srv.call('epost_read_storage_document', { title: '04.04.2020' });
    assert.match(raw, /matches 2 documents/, `it picked one: ${raw.slice(0, 140)}`);
    assert.match(raw, /by index/, 'and says how to address it properly');
  });

  test('an unknown tool name is reported, not ignored', SLOW, async () => {
    const { raw } = await srv.call('epost_does_not_exist', {});
    assert.match(raw, /unknown tool/i);
  });

  test('opening a Storage document reads its detail rather than the card', SLOW, async () => {
    // The overlay is switched on for this one test and off again afterwards. It
    // is the shape the portal really serves, but it covers the whole page, and
    // a panel left lying there hides the card the next test wants to click.
    // In a finally, like every other flag here. The call below can reject on
    // the client's own timeout, and an overlay left switched on then takes the
    // rest of the suite into click timeouts — which is the whole reason it is a
    // flag rather than the fixture's permanent shape.
    let data;
    const before = portal.state.detailOpened.length;
    portal.state.detailOverlay = true;
    try {
      ({ data } = await srv.call('epost_read_storage_document', { index: 0 }));
    } finally {
      portal.state.detailOverlay = false;
    }
    assert.ok(portal.state.detailOpened.length > before, 'the card body was clicked, not the wrapper');
    // The detail is the only place the real subject appears — the card shows
    // "Gescannter Brief" for everything — so reading it is the whole point.
    assert.equal(data.subject, 'Invoice from Caramba Example AG',
      'a sender whose name starts with C must survive the subject match');
    assert.equal(data.amount, '42.00');
    assert.equal(data.documentType, 'Invoice');
    // Example_Beta is the DETAIL's folder; the cards behind it say Example_Alpha
    // and Example_Ümlaut. Taking the first .storage-location-info in the
    // document returns one of those instead.
    //
    // The panel is a fixed overlay for this test, which is what the reader's
    // own comment has always said it is — it COVERS the cards — and it was a
    // static div here, so the shape the portal actually serves was never
    // driven. It
    // matters because the guard the last round added to keep this answer out of
    // a panel nobody opened asked offsetParent, and offsetParent is null for a
    // fixed element however plainly visible: the detail was dropped from the
    // candidates and the lookup fell back to the first .storage-location-info
    // in the document, which is card 0's. Example_Alpha came back for a
    // document whose open panel says Example_Beta, with every other field of
    // the reply correct — the exact answer 36f1729 removed, restored by the
    // guard against it.
    assert.equal(data.storedIn?.normalize('NFC'), 'Example_Beta',
      'the folder must come from the open detail, not from a card behind it');
  });

  test('a viewer that never opened is not a document that was read', SLOW, async () => {
    // The click was the whole of the evidence. Nothing below it looked at the
    // page again, and the panel it was supposed to open lives in the DOM the
    // entire time, hidden — the same PrimeFaces habit that let a store read a
    // sheet which had never appeared. innerText on an element that is not being
    // RENDERED falls back to its text content, so the folder lookup, whose own
    // comment says it must find a visible one, matched the closed panel: it is
    // the shortest thing on the page holding both a "Document type" and a
    // "Stored in", precisely because nothing else is in it. So this document —
    // filed in Example_Alpha — came back `status: ok` with storedIn
    // Example_Beta, which is the panel's folder and no document's on this page,
    // and with a neighbour's "Stored in Example_Ümlaut" scraped up as its
    // subject. A wrong answer in every field and confident in all of them.
    portal.state.detailStuck = true;
    try {
      const { data, raw, isError } = await srv.call('epost_read_storage_document', { index: 0 });
      assert.ok(isError || data.status === 'refused',
        `a document nobody opened was reported as read: ${raw.slice(0, 200)}`);
      assert.match(raw, /did not open|nothing was read/,
        `it does not say the viewer never opened: ${raw.slice(0, 200)}`);
      assert.ok(!/Example_Beta/.test(raw),
        `the closed panel answered for the document anyway: ${raw.slice(0, 200)}`);
    } finally {
      portal.state.detailStuck = false;
    }
  });

  test('a reading the portal served is not undone by the click that opened it', SLOW, async () => {
    // 7ae4706 is called "a click that landed still throws". It taught
    // epost_move_to_folder and epost_create_folder exactly that — Playwright
    // waits for the page to settle after a click and gives up at its own
    // timeout, so a portal that goes back to the server for a repaint lands the
    // click, does the work, and throws anyway — and in the SAME commit it gave
    // this function its first honest evidence, the detail's own wording in the
    // rendered body, while leaving the unguarded click standing in front of it.
    // That is precisely the arrangement it had just removed from the other two:
    // the wait cannot be reached, because the throw leaves first. Opening a
    // Storage card is such a trip in its own right — the viewer's contents are
    // not on the page until the portal sends them, which is why this used to
    // sleep three and a half seconds afterwards. So the panel was open, the
    // portal had recorded the request, and the caller got `ERROR: locator.click:
    // Timeout 10000ms exceeded` about a document whose every field was sitting
    // there to be read.
    const before = portal.state.detailOpened.length;
    portal.state.slowDetail = true;
    try {
      const { data, raw, isError } = await srv.call('epost_read_storage_document', { index: 0 });
      assert.ok(portal.state.detailOpened.length > before, 'the fixture is supposed to open the viewer');
      assert.ok(!isError, `a document the portal opened came back as a failure: ${raw.slice(0, 200)}`);
      assert.equal(data.status, 'ok', `it was not reported as read at all: ${raw.slice(0, 200)}`);
      assert.equal(data.subject, 'Invoice from Caramba Example AG',
        `the reading was lost with the click: ${raw.slice(0, 200)}`);
    } finally {
      portal.state.slowDetail = false;
    }
  });

  test('a Storage document addressed by title is saved under a name of its own', SLOW, async () => {
    // Title-addressed downloads were all named "..._x.pdf", so two documents
    // with the same date quietly overwrote each other. The card's position is
    // what makes the name unique, and it has to be found rather than assumed:
    // 03.03.2020 is the one date this fixture does not repeat.
    const dir = mkdtempSync(join(tmpdir(), 'epost-title-'));
    const { data, raw } = await srv.call('epost_read_storage_document', { title: '03.03.2020', output_dir: dir });
    assert.equal(data.status, 'ok', `nothing was read: ${raw.slice(0, 160)}`);
    assert.ok(data.saved, `nothing was saved: ${raw.slice(0, 160)}`);
    assert.match(basename(data.saved), /_0\.pdf$/,
      `the resolved position is missing from the name: ${basename(data.saved)}`);
    assert.ok(readFileSync(data.saved).toString().startsWith('%PDF'), 'a real PDF, not an error page');
  });

  test('a folder the portal refuses is reported as refused, not as created', SLOW, async () => {
    // Clicking Create is not creating. A name that is already taken leaves the
    // dialog open with its complaint in it, and this used to report a folder
    // that does not exist — which the next store call then cannot find.
    // Neu_Angelegt was created by the test above, so the portal now refuses it.
    const { data } = await srv.call('epost_create_folder', { name: 'Neu_Angelegt' });
    assert.equal(data.status, 'refused', `a duplicate was reported as created: ${JSON.stringify(data)}`);
    assert.match(data.reason, /exists/i, 'it repeats what the portal complained about');
    assert.equal(portal.state.created.filter(n => n === 'Neu_Angelegt').length, 1,
      'the portal was told to create it twice');
  });

  test('a portal taking its time over the commit is not a portal refusing it', SLOW, async () => {
    // Round 16 waited for the store sheet to GO rather than sleeping and
    // looking: "a portal taking its time over the commit is not a portal
    // refusing it, and a flat sleep would turn the slow one into a wrong answer
    // in the other direction." Its own message credits epost_move_to_folder
    // with having read that signal first — and this one reads it four seconds
    // after the click, whatever the page is doing. So a move the portal had
    // ACCEPTED came back `status: refused, "the portal did not accept the
    // folder sheet"`, and the tool then pressed Cancel on a sheet that was
    // mid-commit. The document is in the folder and the caller was told it is
    // not, which is the answer that has them file it somewhere else.
    // epost_create_folder decides the same way, off the same kind of sleep.
    const before = portal.state.stored.length;
    portal.state.commitDelayMs = 6000;
    portal.state.createDelayMs = 6000;
    try {
      const { data, raw } = await srv.call('epost_move_to_folder', { index: 2, folder: 'Example_Gamma' });
      assert.equal(portal.state.stored.length, before + 1, 'the fixture is supposed to accept this move');
      assert.notEqual(data.status, 'refused',
        `a move the portal accepted was reported as refused: ${raw.slice(0, 200)}`);
      assert.ok(data.moved, `it was not reported as a move at all: ${raw.slice(0, 200)}`);

      const folder = await srv.call('epost_create_folder', { name: 'Langsam_Angelegt' });
      assert.ok(portal.state.created.includes('Langsam_Angelegt'), 'the fixture is supposed to accept this name');
      assert.equal(folder.data.status, 'ok',
        `a folder the portal created was reported as refused: ${folder.raw.slice(0, 200)}`);
    } finally {
      portal.state.commitDelayMs = 0;
      portal.state.createDelayMs = 0;
    }
  });

  test('a move the portal took is not undone by the click that made it', SLOW, async () => {
    // Round 17 gave epost_move_to_folder something real to read — the sheet
    // going away — instead of a flat sleep. It never got there. The confirm
    // click in front of that wait was left to answer for the page, and
    // storeLetter's own comment says why that cannot work: "Playwright waits for
    // the page to settle afterwards and gives up at the timeout, so on a loaded
    // machine a click that landed perfectly well still throws". A portal that
    // goes back to the server for a repaint does exactly that. The change was
    // taken, the sheet closed, and the caller was handed `ERROR: locator.click:
    // Timeout 8000ms exceeded` about a document that had moved. storeLetter,
    // driving this very sheet, has discarded its own confirm click since the
    // round that gave it the sheet to read, and answers `status: ok` under
    // exactly this condition — which is what makes this a sibling nobody taught
    // rather than a hazard the file had never met.
    const before = portal.state.stored.length;
    portal.state.slowPostback = true;
    try {
      const { data, raw, isError } = await srv.call('epost_move_to_folder', { index: 1, folder: 'Example_Gamma' });
      assert.equal(portal.state.stored.length, before + 1, 'the fixture is supposed to accept this move');
      assert.ok(!isError, `a move the portal took came back as a failure: ${raw.slice(0, 200)}`);
      assert.ok(data.moved, `it was not reported as a move at all: ${raw.slice(0, 200)}`);
    } finally {
      portal.state.slowPostback = false;
    }
  });

  test('and neither is a folder the portal created', SLOW, async () => {
    // The same click, the same postback, in the sibling that decides the same
    // way. This one costs the caller twice: told the folder does not exist, they
    // create it again, and creating it again is precisely what the portal
    // refuses as a duplicate — the trap the dialog wait was written to avoid.
    portal.state.slowPostback = true;
    try {
      const { data, raw, isError } = await srv.call('epost_create_folder', { name: 'Postback_Angelegt' });
      assert.ok(portal.state.created.includes('Postback_Angelegt'), 'the fixture is supposed to accept this name');
      assert.ok(!isError, `a folder the portal created came back as a failure: ${raw.slice(0, 200)}`);
      assert.equal(data.status, 'ok', `it was not reported as created: ${raw.slice(0, 200)}`);
    } finally {
      portal.state.slowPostback = false;
    }
  });

  test('a remove_from the sheet does not offer is refused, and nothing is changed', SLOW, async () => {
    // The destination was ticked, the sheet committed, and the tool reported a
    // move that had only ever added — the old membership stayed exactly where
    // it was, and the caller was told otherwise.
    const before = portal.state.stored.length;
    const { raw, isError } = await srv.call('epost_move_to_folder', {
      index: 1, folder: 'Example_Gamma', remove_from: 'Nicht_Vorhanden',
    });
    assert.ok(isError, `the half-move was reported as done: ${raw.slice(0, 160)}`);
    assert.match(raw, /remove_from "Nicht_Vorhanden" is not offered/);
    assert.match(raw, /nothing was changed/);
    assert.equal(portal.state.stored.length, before, 'the sheet was committed anyway');
  });

  test('filing a document where it already is changes nothing', SLOW, async () => {
    // Folder membership is a multi-select of checkboxes, so a box that is
    // already ticked is REMOVED by a click. Filing something a second time —
    // which bulk filing does constantly — used to unfile it instead.
    const before = portal.state.stored.length;
    const { data, raw } = await srv.call('epost_move_to_folder', { index: 0, folder: 'Example_Alpha' });
    assert.equal(data.status, 'ok', `an idempotent move failed: ${raw.slice(0, 160)}`);
    assert.equal(data.unchanged, true, `it did something: ${JSON.stringify(data)}`);
    assert.equal(data.in_folder, true, 'it did not notice the document was already filed there');
    assert.equal(portal.state.stored.length, before, 'the sheet was committed anyway');
  });

  test('an index that is not there is an error, not the nearest card', SLOW, async () => {
    // Playwright's nth(-1) means "the last one" and a negative array index is
    // simply undefined, so a nonsense index quietly acted on a different
    // document than the one asked for.
    const dir = mkdtempSync(join(tmpdir(), 'epost-oob-'));
    const { raw, isError } = await srv.call('epost_download_letter', { index: 5, output_dir: dir });
    assert.ok(isError, `index 5 of 2 was accepted: ${raw.slice(0, 160)}`);
    assert.match(raw, /index 5 out of range \(2 letters\)/);
    assert.deepEqual(readdirSync(dir), [], 'it downloaded something regardless');
  });

  test('a document has to be addressed somehow', SLOW, async () => {
    const { raw, isError } = await srv.call('epost_unfile_from_folder', { folder: 'Example_Alpha' });
    assert.ok(isError, `it acted without being told which document: ${raw.slice(0, 160)}`);
    assert.match(raw, /pass either index or title/);
  });
});
