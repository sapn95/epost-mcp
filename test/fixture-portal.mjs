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
  <button id="f:moveBtn" onclick="commit()">Store</button>
</div>`;

// The one step of the SwissID chain that can be reproduced without SwissID: a
// login form whose input is not in the DOM when the redirect lands. The real
// page renders it a beat later, which is the whole reason the assisted login is
// supposed to look more than once. Served only while state.loginFlow is on, so
// the tests that want the dashboard still get one.
const LOGIN_FIELD_DELAY = 3000;
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
  const state = {
    stored: [], moved: [], detailOpened: [], created: [], refuseCommit: false, sheetStuck: false,
    loginFlow: false, loginEmails: [], commitDelayMs: 0, createDelayMs: 0,
  };

  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body>
<div class="brand-container">decoy behind the sheet</div>
${body}
${sheet()}
<script>
  // Read at render time, so a test flips it and the next reload gets it.
  const SHEET_STUCK = ${state.sheetStuck};
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
    fetch('/detail?i=' + i);
    document.getElementById('detail').style.display='block';
  }
</script>
<div id="detail" style="display:none">
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
             onclick="fetch('/created?n=' + encodeURIComponent(document.getElementById('dlg:folder-name').value)).then(r => { if (r.ok) { document.getElementById('newfolder').style.display='none'; } else { document.getElementById('newfolder-msg').textContent = 'A folder with this name already exists'; } })">Create</button>
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
