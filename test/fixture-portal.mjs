// A local stand-in for the ePost web portal, reproducing the DOM the automation
// actually depends on — and the traps that broke it repeatedly:
//
//   * one hidden action menu per card, all with identical text, so a
//     document-wide text search finds the wrong one
//   * `.brand-container` used both for the folder tiles and for the cards
//     behind the sheet
//   * a horizontally scrolling folder strip, so tiles are "invisible" to a
//     visibility filter
//   * folder names in NFD, so a byte-exact compare against a typed literal fails
//   * Store being a two-step action whose sheet must be confirmed
import { createServer } from 'node:http';

const NFD = 'Example_Ümlaut'.normalize('NFD');   // as the portal serves it

const LETTERS = [
  { date: '01.01.2020', sender: 'ePost Scancenter', title: 'Gescannter Brief' },
  { date: '02.02.2020', sender: 'ePost Scancenter', title: 'Gescannter Brief', extra: 'CHF 42.00 Invoice from Example AG' },
];
const DOCS = [
  { date: '03.03.2020', stored: 'Example_Alpha' },
  { date: '04.04.2020', stored: null },
  { date: '04.04.2020', stored: NFD },
];

const menu = i => `
  <div class="letter-action-menu" onclick="document.getElementById('m${i}').style.display='block'">
    <a class="ui-commandlink menu-icon-wrapper" href="#" onclick="return false">…</a></div>
  <div id="m${i}" class="card-menu" style="display:none">
    <span class="mi" onclick="store(${i})">Store</span>
    <span class="mi" onclick="store(${i})">Move</span>
    <span class="mi">Copy</span>
    <span class="mi">Delete</span>
  </div>`;

const card = (d, i) => `
<div class="letter-wrapper letter small-letter" data-folders="${d.stored || ''}">
  <div class="letter-content" onclick="openDetail(${i})">
    <div class="sender-info--small"><span class="sender-name">${d.sender || 'ePost Scancenter'}</span>
      <span class="letter-content__date letter-date">${d.date}</span></div>
    <div class="letter-content__title"><span class="letter-title-name">${d.title || 'Gescannter Brief'}</span></div>
    <div class="letter-content__addition-info">${d.extra || ''}</div>
    ${d.stored ? `<div class="storage-location-info"><span>Stored in </span> <b>${d.stored}</b></div>` : ''}
    ${menu(i)}
  </div>
</div>`;

// The folder sheet: tiles are .brand-container, same class as decorative blocks
// elsewhere on the page, and the strip scrolls sideways.
const sheet = () => `
<div id="storage-folder-selection" class="sheet" style="display:none">
  <h3>Select a folder</h3>
  <div class="strip" style="overflow-x:auto;white-space:nowrap;width:200px">
    ${['Example_Alpha', NFD, 'Example_Beta', 'Example_Gamma'].map((n, k) => `
      <div class="brand-container" style="display:inline-block;width:150px">
        <div class="ui-chkbox-box" id="cb${k}" onclick="this.classList.toggle('ui-state-active')"></div>
        <span>${n}</span>
      </div>`).join('')}
  </div>
  <button id="f:cancel" onclick="closeSheet()">Cancel</button>
  <button id="f:moveBtn" onclick="commit();postback()">Store</button>
</div>`;

// The one step of the SwissID chain that can be reproduced without SwissID: a
// login form whose input is not in the DOM when the redirect lands. The real
// page renders it a beat later, which is the whole reason the assisted login is
// supposed to look more than once. Served only while state.loginFlow is on, so
// the tests that want the dashboard still get one.
const LOGIN_FIELD_DELAY = 3000;

// How long the portal takes to answer the postback a confirm click kicks off.
// Deliberately longer than the eight seconds the automation allows that click,
// because the point is a click that LANDED and throws anyway: Playwright waits
// for the page to settle after a click and gives up at its own timeout, which is
// the entire reason storeLetter discards its confirm click's outcome and reads
// the sheet instead. The response is a 204, so the page never actually leaves —
// only the click is left waiting, exactly as with a real repaint that is slow to
// come back. Nothing here could produce it, so the two siblings that decide off
// the click rather than off the page could not be caught throwing away a change
// the portal had already taken.
const POSTBACK_DELAY = 9000;
const loginEmailPage = () => `<!doctype html><html><head><meta charset="utf-8"><title>login-email</title></head>
<body><h1>SwissID</h1><div id="form"></div>
<script>
  setTimeout(function () {
    document.getElementById('form').innerHTML = '<input type="email" id="u"><button id="w">Weiter</button>';
    document.getElementById('w').onclick = function () {
      fetch('/login-email-submitted?v=' + encodeURIComponent(document.getElementById('u').value));
    };
  }, ${LOGIN_FIELD_DELAY});
</script>
</body></html>`;

export function start() {
  // refuseCommit: the folder sheet is pressed and the portal says no. It says it
  // by leaving the sheet standing — there is no other signal, exactly as with a
  // duplicate folder name — and nothing here could produce that before, so the
  // half of the store flow that has to notice went untested while it reported
  // every letter as archived.
  //
  // sheetStuck: the menu item is clicked and the sheet does not open. A stale
  // view, a lapsed session, a re-render that replaced the handler — the overlay
  // is in the DOM the whole time either way, hidden, exactly as PrimeFaces
  // builds it. It matters because "the sheet is not showing" is what the store
  // reads as proof that the archive was committed, and that state is also what
  // a sheet which never opened looks like. Nothing here could produce it, so
  // the guard could not be caught agreeing with a page it had never seen.
  // commitDelayMs / createDelayMs: the portal takes its time. It has ACCEPTED
  // the sheet — the entry is recorded straight away — but the page it is
  // waiting on has not repainted yet, so the dialog is still standing when a
  // fixed sleep runs out. That is the only difference between a slow portal and
  // a refusing one, and two of the three two-step flows decide between them
  // with a flat waitForTimeout, so a move that had gone through came back as
  // "refused, nothing was changed". Nothing here could be slow before.
  //
  // slowPostback: the confirm click also kicks off a navigation the portal is
  // slow to answer — see POSTBACK_DELAY. The change is taken either way; what
  // differs is whether the automation lets the click's own timeout answer for
  // the page. Two of the three two-step flows did, and threw away the very
  // signal they had just been given.
  //
  // detailStuck: the card is clicked and the document viewer does not open —
  // the same accident as sheetStuck, one panel over. A stale view, a re-render
  // that replaced the handler, a session that lapsed while the list was on
  // screen: the click lands on nothing and the page is exactly as it was. It
  // matters because the detail panel is in the DOM the whole time, hidden, and
  // innerText on an element that is NOT being rendered falls back to its text
  // content — so a scan for the panel's own wording finds it in a panel nobody
  // opened. Nothing here could produce it, so the read could never be caught
  // answering out of a detail that was never on screen.
  const state = {
    stored: [], moved: [], detailOpened: [], created: [], refuseCommit: false, sheetStuck: false,
    loginFlow: false, loginEmails: [], commitDelayMs: 0, createDelayMs: 0, slowPostback: false,
    detailStuck: false, detailOverlay: false,
  };

  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body>
<div class="brand-container">decoy behind the sheet</div>
${body}
${sheet()}
<script>
  // Read at render time, so a test flips it and the next reload gets it.
  const SHEET_STUCK = ${state.sheetStuck};
  const SLOW_POSTBACK = ${state.slowPostback};
  const DETAIL_STUCK = ${state.detailStuck};
  // The portal's own trip back to the server after a confirm. It has already
  // taken the change; this is only the repaint, and it answers 204 so the page
  // stays put. All it does is leave the click waiting — see POSTBACK_DELAY.
  function postback(){ if (SLOW_POSTBACK) location.href = '/slow-postback'; }
  let current = null;
  function store(i){
    current = i;
    // The real sheet opens with the document's current folders already ticked.
    // A sheet that always opened empty made unfiling look like a no-op, so the
    // one path that has to refuse — removing the last folder — never ran.
    const owned = (document.querySelectorAll('.letter-wrapper')[i]?.dataset.folders || '')
      .split('|').filter(Boolean);
    document.querySelectorAll('#storage-folder-selection .brand-container').forEach(c => {
      const name = c.querySelector('span').textContent;
      c.querySelector('.ui-chkbox-box').classList.toggle('ui-state-active', owned.includes(name));
    });
    // The sheet is prepared either way and only then shown, so a stuck one
    // leaves ticked checkboxes standing in a DOM nobody can see — which is
    // exactly what let a tile lookup that ignores visibility carry on
    // regardless. See state.sheetStuck.
    if (!SHEET_STUCK) document.getElementById('storage-folder-selection').style.display='block';
  }
  function closeSheet(){ document.getElementById('storage-folder-selection').style.display='none'; }
  function commit(){
    const on = [...document.querySelectorAll('#storage-folder-selection .brand-container')]
      .filter(c => c.querySelector('.ui-chkbox-box').classList.contains('ui-state-active'))
      .map(c => c.querySelector('span').textContent);
    if (!on.length) return;                       // the portal refuses an empty set
    // The sheet closes because the portal ACCEPTED it, and it stays open when
    // the portal did not. Closing regardless made "clicked Store" and "the
    // letter is in the folder" the same page state, so the one signal a caller
    // has that an archive happened could never be wrong here — see refuseCommit.
    fetch('/committed?i=' + current + '&f=' + encodeURIComponent(on.join('|')))
      .then(function (r) { if (r.ok) closeSheet(); });
  }
  function openDetail(i){
    // A click that lands on nothing: the handler is gone, the panel stays
    // hidden and the page is exactly as it was. See state.detailStuck.
    if (DETAIL_STUCK) return;
    fetch('/detail?i=' + i);
    document.getElementById('detail').style.display='block';
  }
  // Escape dismisses the viewer, which is what the automation presses after
  // every read and every download and had nothing to press against here. It
  // matters now that the panel covers the page: without it the overlay from one
  // letter would still be lying over the card of the next.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') document.getElementById('detail').style.display='none';
  });
</script>
<!-- A fixed overlay, because that is what the automation says this panel is:
     "the cards behind it all carry .storage-location-info, and visibility does
     not separate them because the panel COVERS them rather than hiding them".
     A panel that covers the page is out of the flow and pinned to the viewport,
     which is how PrimeFaces builds a modal — and a fixed element's
     offsetParent is null however plainly visible it is, exactly as if it were
     not rendered at all. The panel was a plain static div here, so a filter
     that reads offsetParent as "is this on screen" agreed with itself and the
     folder lookup went on answering out of the detail. It answers out of the
     first card instead the moment the panel is what the portal actually
     serves.

     Zugeschaltet statt immer an: ein Overlay, das den ganzen Bildschirm deckt,
     bleibt nach einem Lesevorgang liegen und verdeckt die Karte, auf die der
     nächste Test klicken will — sechzehn der dreissig Browser-Tests liefen so
     in Klick-Timeouts. Die eine Prüfung, der die Form etwas bedeutet, schaltet
     ihn ein. -->
<div id="detail" style="display:none${state.detailOverlay ? ';position:fixed;top:0;left:0;right:0;bottom:0;background:#fff;z-index:9' : ''}">
  <!-- The sender begins with a C on purpose: the subject was once matched with
       a pattern that excluded that letter, so every such name came back null. -->
  <div>Gescannter Brief Invoice from Caramba Example AG CHF 42.00</div>
  <div>Document type Invoice</div><div>Document date 02.02.2020</div>
  <!-- Deliberately NOT the folder of the first card: a lookup that takes the
       first .storage-location-info in the document reports that one instead,
       and a fixture where both say the same thing cannot tell the difference. -->
  <div class="storage-location-info"><span>Stored in </span> <b>Example_Beta</b></div>
  <a id="dl" download="letter.pdf" href="data:application/pdf;base64,JVBERi0xLjQgbW9jaw==">Download File</a>
  <button onclick="document.getElementById('dl').click()">Download File</button>
</div>
</body></html>`;

  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    // A 204 aborts the navigation, so the page never leaves and only the click
    // that started this is left waiting. See POSTBACK_DELAY.
    if (u.pathname === '/slow-postback') {
      return setTimeout(() => { res.writeHead(204); res.end(); }, POSTBACK_DELAY);
    }
    if (u.pathname === '/committed') {
      if (state.refuseCommit) { res.writeHead(409); return res.end(); }
      // Recorded before the delay: the portal has taken the change, it is the
      // page that has not caught up. See state.commitDelayMs.
      state.stored.push({ i: Number(u.searchParams.get('i')), folders: (u.searchParams.get('f') || '').split('|') });
      return setTimeout(() => { res.writeHead(204); res.end(); }, state.commitDelayMs);
    }
    if (u.pathname === '/created') {
      const n = u.searchParams.get('n');
      // A name that is already taken is refused, and the portal says so by
      // leaving the dialog open with its complaint in it — there is no other
      // signal. A fixture that accepted everything let "clicked Create" pass
      // for "folder exists", which the next store call then cannot find.
      if (state.created.includes(n)) { res.writeHead(409); return res.end(); }
      state.created.push(n);
      return setTimeout(() => { res.writeHead(204); res.end(); }, state.createDelayMs);
    }
    if (u.pathname === '/detail') {
      state.detailOpened.push(Number(u.searchParams.get('i')));
      res.writeHead(204); return res.end();
    }
    if (u.pathname === '/login-email-submitted') {
      state.loginEmails.push(u.searchParams.get('v'));
      res.writeHead(204); return res.end();
    }
    if (u.pathname === '/login-email') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginEmailPage());
    }
    // The portal bounces an unauthenticated visitor into the login chain. The
    // path is what the automation matches on, so a local fixture can stand in.
    if (state.loginFlow && u.pathname === '/') {
      res.writeHead(302, { Location: '/login-email' }); return res.end();
    }
    const isStorage = u.pathname.includes('LetterStorage');
    const body = isStorage
      ? `<a href="/">Go to Inbox</a>
         <button onclick="document.getElementById('newfolder').style.display='block'">Create a folder</button>
         <div id="newfolder" style="display:none">
           <input type="text" id="dlg:folder-name">
           <button id="dlg:create-btn"
             onclick="fetch('/created?n=' + encodeURIComponent(document.getElementById('dlg:folder-name').value)).then(r => { if (r.ok) { document.getElementById('newfolder').style.display='none'; } else { document.getElementById('newfolder-msg').textContent = 'A folder with this name already exists'; } }); postback()">Create</button>
           <div id="newfolder-msg"></div>
         </div>
         <h3>Companies (1)</h3><div class="tile"><span>ePost Scancenter</span> <span>3 Files</span></div>
         <h3>Custom (2)</h3>
         <div class="tile"><span>Example_Alpha</span> <span>2 Files</span></div>
         <div class="tile"><span>${NFD}</span> <span>1 Files</span></div>
         <h2>My Documents (${DOCS.length})</h2>${DOCS.map(card).join('')}`
      : `<a href="/luz/faces/instances/x/ch.klara.epostbusiness.LetterStorage/LetterStorage.xhtml">Go to Storage</a>
         <h2>Letters (${LETTERS.length})</h2>${LETTERS.map(card).join('')}`;
    const title = isStorage ? 'Storage' : 'DigitalLetterboxOverview';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    // The real app lands on a dashboard first; the automation clicks through.
    res.end(u.pathname === '/'
      ? page('dashboard', `<a href="/luz/faces/instances/x/ch.klara.epostbusiness.DigitalLetterboxOverview/DigitalLetterboxOverview.xhtml">Digital Letterbox</a>`)
      : page(title, body));
  });

  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({
    base: `http://127.0.0.1:${srv.address().port}`,
    state,
    NFD,
    close: () => new Promise(x => srv.close(x)),
  })));
}
