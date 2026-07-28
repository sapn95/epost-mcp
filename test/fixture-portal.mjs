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
<div class="letter-wrapper letter small-letter">
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

export function start() {
  const state = { stored: [], moved: [], detailOpened: [], created: [] };

  const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body>
<div class="brand-container">decoy behind the sheet</div>
${body}
${sheet()}
<script>
  let current = null;
  function store(i){ current = i; document.getElementById('storage-folder-selection').style.display='block'; }
  function closeSheet(){ document.getElementById('storage-folder-selection').style.display='none'; }
  function commit(){
    const on = [...document.querySelectorAll('#storage-folder-selection .brand-container')]
      .filter(c => c.querySelector('.ui-chkbox-box').classList.contains('ui-state-active'))
      .map(c => c.querySelector('span').textContent);
    if (!on.length) return;                       // the portal refuses an empty set
    fetch('/committed?i=' + current + '&f=' + encodeURIComponent(on.join('|')));
    closeSheet();
  }
  function openDetail(i){
    fetch('/detail?i=' + i);
    document.getElementById('detail').style.display='block';
  }
</script>
<div id="detail" style="display:none">
  <div>Document type Invoice</div><div>Document date 02.02.2020</div>
  <div>Stored in Example_Alpha</div>
  <a id="dl" download="letter.pdf" href="data:application/pdf;base64,JVBERi0xLjQgbW9jaw==">Download File</a>
  <button onclick="document.getElementById('dl').click()">Download File</button>
</div>
</body></html>`;

  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/committed') {
      state.stored.push({ i: Number(u.searchParams.get('i')), folders: (u.searchParams.get('f') || '').split('|') });
      res.writeHead(204); return res.end();
    }
    if (u.pathname === '/created') {
      state.created.push(u.searchParams.get('n'));
      res.writeHead(204); return res.end();
    }
    if (u.pathname === '/detail') {
      state.detailOpened.push(Number(u.searchParams.get('i')));
      res.writeHead(204); return res.end();
    }
    const isStorage = u.pathname.includes('LetterStorage');
    const body = isStorage
      ? `<a href="/">Go to Inbox</a>
         <button onclick="document.getElementById('newfolder').style.display='block'">Create a folder</button>
         <div id="newfolder" style="display:none">
           <input type="text" id="dlg:folder-name">
           <button id="dlg:create-btn"
             onclick="fetch('/created?n=' + encodeURIComponent(document.getElementById('dlg:folder-name').value))">Create</button>
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
