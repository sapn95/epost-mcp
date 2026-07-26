#!/usr/bin/env node
// epost-mcp — MCP server for the Swiss ePost digital letterbox (app.epost.ch).
//
// ePost offers no public retrieval API for private customers, so this server
// drives the web portal with Playwright. The SwissID session is cached as a
// Playwright storageState file so it survives server restarts; when it expires,
// call `epost_login` and complete SwissID interactively in the opened window.
//
// Env:
//   EPOST_STATE     storageState json path  (default: ~/.epost-mcp/state.json)
//   EPOST_CHROMIUM  chromium executable     (default: auto-detect playwright cache)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const STATE = process.env.EPOST_STATE || join(homedir(), '.epost-mcp', 'state.json');
const APP_URL = 'https://app.epost.ch';

// --- browser bootstrap ------------------------------------------------------

function findChromium() {
  if (process.env.EPOST_CHROMIUM) return process.env.EPOST_CHROMIUM;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* fall through to cache scan */ }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter(n => n.startsWith('chromium-')).sort().reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const p = join(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined; // let playwright resolve (may need `npx playwright install chromium`)
}

let browserObj = null;
let ctx = null;
let headed = false;

async function getContext(wantHeaded = false) {
  // Reuse an existing context unless we specifically need a headed one but only
  // have a headless one (the interactive login case).
  if (ctx && (!wantHeaded || headed)) return ctx;
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
  if (browserObj) { await browserObj.close().catch(() => {}); browserObj = null; }
  browserObj = await chromium.launch({ headless: !wantHeaded, executablePath: findChromium() });
  ctx = await browserObj.newContext({
    storageState: existsSync(STATE) ? STATE : undefined,
    acceptDownloads: true,
    locale: 'de-CH',
    viewport: { width: 1400, height: 1000 },
  });
  headed = wantHeaded;
  return ctx;
}

async function getPage(wantHeaded = false) {
  const c = await getContext(wantHeaded);
  return c.pages()[0] || await c.newPage();
}

// Persist cookies/localStorage so the session survives a server restart.
async function saveState() {
  if (!ctx) return;
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    await ctx.storageState({ path: STATE });
  } catch { /* best effort */ }
}

// --- passkey (WebAuthn virtual authenticator) -------------------------------
//
// A cached storageState only lasts as long as SwissID's session. To re-login
// WITHOUT a human, we use Chrome's WebAuthn *virtual authenticator* (CDP):
// a software FIDO2 authenticator whose private key we control. You register it
// once with SwissID (in a real, headed session), we export the resulting
// credential and keep it in the macOS keychain; from then on every login is
// signed automatically — no Touch ID, no SMS code.
//
// SECURITY: a Touch-ID passkey is hardware-bound and cannot be exported. This
// one is a software key held in the login keychain, so anyone who can read that
// keychain entry can log into SwissID as you. It is a deliberate trade of
// phishing-resistance for automation. Use `epost_passkey_forget` to revoke
// locally, and remove the passkey in the SwissID account settings too.

const KC_SERVICE = 'epost-mcp-passkey';
const DEBUG = !!process.env.EPOST_DEBUG;   // trace the passkey login stations on stderr

function keychainRead(service, account = 'epost') {
  try {
    return execFileSync('security', ['find-generic-password', '-a', account, '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
function keychainWrite(service, value, account = 'epost') {
  execFileSync('security', ['add-generic-password', '-a', account, '-s', service, '-w', value, '-U'],
    { stdio: ['ignore', 'ignore', 'ignore'] });
}
function keychainDelete(service, account = 'epost') {
  try {
    execFileSync('security', ['delete-generic-password', '-a', account, '-s', service],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

function loadPasskey() {
  const raw = keychainRead(KC_SERVICE);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    return c?.credentialId && c?.privateKey && c?.rpId ? c : null;
  } catch { return null; }
}

// Attach virtual authenticators to `p`'s target. `automaticPresenceSimulation`
// makes them approve user-presence/verification prompts by themselves.
//
// We register BOTH transports on purpose. A relying party may ask for a
// platform authenticator (authenticatorAttachment "platform" → Touch ID-like)
// or for a roaming security key ("cross-platform" → USB). An authenticator
// whose transport does not match the request is simply not eligible, and Chrome
// then sits on its "Insert your security key and touch it" dialog forever —
// which is exactly what SwissID's register-passkey page triggers. Offering an
// `internal` and a `usb` authenticator satisfies either path.
const AUTH_BASE = {
  protocol: 'ctap2',
  ctap2Version: 'ctap2_1',
  hasResidentKey: true,          // discoverable credential → usernameless login
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
  defaultBackupEligibility: true,
  defaultBackupState: true,
};

async function attachAuthenticator(p) {
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const ids = [];
  for (const transport of ['internal', 'usb']) {
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { ...AUTH_BASE, transport },
    });
    ids.push({ authenticatorId, transport });
  }
  return { cdp, ids, authenticatorId: ids[0].authenticatorId };
}

// First credential found across every attached authenticator.
async function findCredential(cdp, ids) {
  for (const { authenticatorId, transport } of ids) {
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId }).catch(() => ({ credentials: [] }));
    const c = (credentials || []).find(x => x.privateKey);
    if (c) return { ...c, transport, authenticatorId };
  }
  return null;
}

// Load the stored credential into a fresh virtual authenticator so the next
// WebAuthn assertion on the login page can be signed without a human.
async function armPasskey(p) {
  const cred = loadPasskey();
  if (!cred) return null;
  const { cdp, ids } = await attachAuthenticator(p);
  // Load the key into every attached authenticator, so the assertion succeeds
  // whichever attachment the login page asks for.
  for (const { authenticatorId } of ids) {
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId,
      credential: {
        credentialId: cred.credentialId,
        isResidentCredential: true,
        rpId: cred.rpId,
        privateKey: cred.privateKey,
        userHandle: cred.userHandle || undefined,
        signCount: cred.signCount || 0,
      },
    }).catch(() => {});
  }
  return { cdp, ids, cred };
}

// Click whatever offers a passkey login on the current SwissID screen.
async function clickPasskeyAffordance(p) {
  const patterns = [/passkey/i, /pass-key/i, /sicherheitsschl(ü|u)ssel/i, /security key/i, /biometri/i, /fido/i];
  for (const re of patterns) {
    for (const loc of [p.getByRole('button', { name: re }), p.getByRole('link', { name: re }), p.getByText(re)]) {
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 6000 }).catch(() => {});
          return true;
        }
      }
    }
  }
  return false;
}

// Full non-interactive re-login. Returns 'ok' | 'login_required' | 'no_passkey'.
//
// The route from an expired session to the letterbox has four stations, and the
// passkey only becomes available at the last one:
//   app.epost.ch
//     → login.epost.ch (Keycloak)          click "Login mit SwissID"
//     → login.swissid.ch/login/login-email  enter the account e-mail, "Weiter"
//     → login.swissid.ch/login/login-password  click "Mit Passkey anmelden"
//     → back to app.epost.ch, authenticated
// Each step is driven only when its own URL is showing, so the loop simply
// re-checks where it is; a step that is skipped by the server does no harm.
async function passkeyLogin(p) {
  const armed = await armPasskey(p);
  if (!armed) return 'no_passkey';
  const user = process.env.EPOST_SWISSID_USER || armed.cred.username || '';
  let didSwissId = false, didEmail = false, didPasskey = false;
  try {
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    let lastSeen = '';
    for (let i = 0; i < 40; i++) {
      await p.waitForTimeout(2000);
      const u = p.url();
      if (DEBUG && u !== lastSeen) { console.error('[passkey]', i, u); lastSeen = u; }

      // Arrived: an authenticated ePost surface.
      if (/app\.epost\.ch/.test(u) && !/oauth_login|openid-connect/.test(u)) {
        if (u.includes('DigitalLetterboxOverview')
          || await p.locator('div.letter-wrapper').count().catch(() => 0)
          || await p.getByText('Digital Letterbox', { exact: false }).count().catch(() => 0)) {
          // Persist the bumped signature counter so the RP's replay check passes.
          await syncSignCount(armed).catch(() => {});
          return await ensureLetterbox(p);
        }
      }

      // Station 1 — ePost's own Keycloak page: hand over to SwissID.
      if (/login\.epost\.ch/.test(u) && !didSwissId) {
        const sw = p.getByRole('button', { name: /Login mit SwissID/i }).first();
        if (await sw.count().catch(() => 0)) {
          await sw.click({ timeout: 8000 }).catch(() => {});
          didSwissId = true;
          if (DEBUG) console.error('[passkey] clicked: Login mit SwissID');
        }
        continue;
      }

      // Station 2 — SwissID asks which account.
      if (/login-email/.test(u) && !didEmail) {
        if (!user) return 'login_required';  // nothing to type; a human is needed
        const inp = p.locator('input[type=text], input[type=email]').first();
        if (await inp.count().catch(() => 0)) {
          await inp.fill(user, { timeout: 8000 }).catch(() => {});
          const next = p.getByRole('button', { name: /^Weiter$|^Continue$/i }).first();
          if (await next.count().catch(() => 0)) await next.click({ timeout: 8000 }).catch(() => {});
          didEmail = true;
          if (DEBUG) console.error('[passkey] filled e-mail + Weiter');
        }
        continue;
      }

      // Station 3 — password screen, which also offers the passkey. This is
      // where the virtual authenticator signs, with no user interaction.
      if (/login-password/.test(u) && !didPasskey) {
        const pk = p.getByRole('button', { name: /Mit Passkey anmelden|Sign in with (a )?passkey/i }).first();
        if (await pk.count().catch(() => 0)) {
          await pk.click({ timeout: 8000 }).catch(() => {});
          didPasskey = true;
          if (DEBUG) console.error('[passkey] clicked: Mit Passkey anmelden');
        } else {
          await clickPasskeyAffordance(p);
        }
        continue;
      }
    }
    return 'login_required';
  } finally {
    await armed.cdp.detach().catch(() => {});
  }
}

// Keep the stored signCount in step with the authenticator's, so the relying
// party does not reject the next assertion as a clone/replay.
async function syncSignCount(armed) {
  let best = armed.cred.signCount || 0;
  for (const { authenticatorId } of armed.ids) {
    const { credentials } = await armed.cdp.send('WebAuthn.getCredentials', { authenticatorId }).catch(() => ({ credentials: [] }));
    const live = (credentials || []).find(c => c.credentialId === armed.cred.credentialId);
    if (live && (live.signCount || 0) > best) best = live.signCount;
  }
  keychainWrite(KC_SERVICE, JSON.stringify({ ...armed.cred, signCount: best }));
}

// --- navigation helpers -----------------------------------------------------

// True when we are sitting on the ePost / SwissID login screen.
async function isLoginPage(p) {
  const u = p.url();
  if (/swissid\.ch|login\.epost\.ch/.test(u)) {
    if (await p.getByText('Login mit SwissID', { exact: false }).count()) return true;
    if (await p.locator('input[type="password"]').count()) return true;
  }
  return false;
}

// Navigate to the digital letterbox. Returns 'ok' or 'login_required'.
async function ensureLetterbox(p, timeout = 40000) {
  if (p.url().includes('DigitalLetterboxOverview') && await p.locator('div.letter-wrapper').count()) {
    return 'ok';
  }
  await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
  // Let the SwissID/KLARA SSO redirect chain settle onto the dashboard (or a
  // visible login form if the cached session has expired).
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(1500);
    if (await isLoginPage(p)) return 'login_required';
    const u = p.url();
    if (/app\.epost\.ch/.test(u) && !/oauth_login|openid-connect/.test(u)) break;
  }
  if (await isLoginPage(p)) return 'login_required';

  // Open the letterbox from the dashboard by clicking its visible label.
  const dl = p.getByText('Digital Letterbox', { exact: false }).first();
  if (await dl.count()) await dl.click({ timeout: 10000 }).catch(() => {});
  for (let i = 0; i < 15; i++) {
    if (p.url().includes('DigitalLetterboxOverview')) return 'ok';
    if (await p.locator('div.letter-wrapper').count()) return 'ok';
    if (await isLoginPage(p)) return 'login_required';
    await p.waitForTimeout(1500);
  }
  return p.url().includes('DigitalLetterboxOverview') ? 'ok' : 'login_required';
}

async function listLetters(p) {
  await p.waitForSelector('div.letter-wrapper', { timeout: 20000 });
  return p.$$eval('div.letter-wrapper', els => els.map((el, i) => {
    const pick = sel => { const n = el.querySelector(sel); return n ? n.innerText.replace(/\s+/g, ' ').trim() : ''; };
    const dates = [...el.innerText.matchAll(/\d{2}\.\d{2}\.\d{4}/g)].map(m => m[0]);
    return {
      index: i,
      sender: pick('.sender-name'),
      title: pick('.letter-title-name'),
      dates,
      preview: el.innerText.replace(/\s+/g, ' ').slice(0, 120),
    };
  }));
}

// Click the nth letter, hit "Download File", capture the download, save it, and
// press Escape to return to the list. Stays on the same page (no re-goto of the
// per-session DigitalLetterboxOverview dialog URL, which breaks between letters).
async function downloadLetter(p, index, outputDir, meta) {
  mkdirSync(outputDir, { recursive: true });
  const wrappers = p.locator('div.letter-wrapper');
  const n = await wrappers.count();
  if (index >= n) throw new Error(`index ${index} out of range (${n} letters)`);
  await wrappers.nth(index).click();
  await p.waitForTimeout(3500);

  const byAria = p.locator('[aria-label="Download File"]').first();
  const byText = p.getByText('Download File', { exact: false }).first();
  const target = (await byAria.count()) ? byAria : byText;
  if (!(await target.count())) {
    await p.keyboard.press('Escape').catch(() => {});
    throw new Error('"Download File" button not found in the letter detail');
  }

  const [dl] = await Promise.all([
    p.waitForEvent('download', { timeout: 20000 }),
    target.click({ timeout: 10000 }),
  ]);
  const date = meta?.dates?.[0];
  const stamp = date ? date.split('.').reverse().join('-') : 'undated';
  const saved = join(outputDir, `${stamp}_ePost_${index}.pdf`);
  await dl.saveAs(saved);

  await p.keyboard.press('Escape').catch(() => {});
  await p.waitForTimeout(1500);
  return saved;
}

// --- storage (organized area) ----------------------------------------------

// Navigate from the letterbox into the Storage view (URL contains LetterStorage).
async function goToStorage(p) {
  const st = await ensureSession(p);
  if (st !== 'ok') return st;
  if (!p.url().includes('LetterStorage')) {
    const gs = p.getByText('Go to Storage', { exact: false }).first();
    if (await gs.count()) await gs.click({ timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 12; i++) {
      if (p.url().includes('LetterStorage')) break;
      await p.waitForTimeout(1500);
    }
  }
  return 'ok';
}

// List the (custom) folder tiles and the unsorted "My Documents (N)" count.
// Folder tiles render their name followed by an "N Files" badge; the branded
// "Companies" folders (ePost / la Mobilière) show a logo instead of a text name
// and are therefore not returned here — only the user's own move targets are.
async function listStorage(p) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(2500);
  const data = await p.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const seen = new Set();
    const folders = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 5) continue;
      const t = clean(el.innerText);
      const m = t.match(/^(.{1,40}?)\s+(\d+)\s+Files?$/);
      if (!m) continue;
      const name = m[1].trim();
      if (!name || /Files|^\d+$|\(\d+\)/.test(name)) continue; // skip mashed/branded tiles
      const key = name + '|' + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      folders.push({ name, count: Number(m[2]) });
    }
    const body = clean(document.body.innerText);
    const my = body.match(/My Documents\s*\((\d+)\)/i);
    return { url: location.href, myDocuments: my ? Number(my[1]) : null, folders };
  });
  return { status: 'ok', ...data };
}

// List the individual documents in Storage (the datascroller cards). The list
// lazy-loads, so pass scroll_all=true to wheel-scroll until every card is in
// the DOM. Each card only exposes "Scanned Letter" + a date (+ a "Stored in
// <folder>" tag once filed), so that is all we can report per document.
// Wheel-scroll the Storage datascroller until it stops adding cards, so every
// document is in the DOM. Anything addressing a document BY INDEX must do this
// first: the indices reported by listStorageDocuments(scrollAll) cover all 98
// documents, while a freshly opened Storage view only has the first batch —
// addressing index 80 against that view fails as "out of range".
async function loadAllCards(p) {
  const cards = p.locator('div.letter-wrapper');
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const before = await cards.count();
    await p.mouse.wheel(0, 6000);
    await p.waitForTimeout(1000);
    stable = (await cards.count()) === before ? stable + 1 : 0;
  }
  return cards.count();
}

async function listStorageDocuments(p, { scrollAll = false } = {}) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(2000);
  if (scrollAll) await loadAllCards(p);
  const docs = await p.$$eval('div.letter-wrapper', els => els.map((el, i) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const dates = [...el.innerText.matchAll(/\d{2}\.\d{2}\.\d{4}/g)].map(m => m[0]);
    const stored = (el.innerText.match(/Stored in\s+([^\n]+)/) || [])[1];
    return { index: i, date: dates[0] || null, storedIn: stored ? clean(stored) : null, preview: clean(el.innerText).slice(0, 100) };
  }));
  return { status: 'ok', count: docs.length, documents: docs };
}

async function createFolder(p, name) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  const cf = p.getByText('Create a folder', { exact: false }).first();
  if (!(await cf.count())) throw new Error('"Create a folder" button not found');
  await cf.click({ timeout: 10000 });
  await p.waitForTimeout(1500);
  // The add-folder dialog owns its fields by id: name input ends ":folder-name",
  // the confirm button ends ":create-btn". A generic button lookup instead hits
  // the background "Create a folder" button behind the modal mask, so target the
  // dialog controls directly.
  const input = p.locator('[id$=":folder-name"]').first();
  await input.waitFor({ state: 'visible', timeout: 8000 });
  await input.fill(name, { timeout: 8000 });
  await p.waitForTimeout(400);
  const createBtn = p.locator('[id$=":create-btn"]').first();
  if (await createBtn.count()) await createBtn.click({ timeout: 8000, force: true });
  else await p.keyboard.press('Enter');
  await p.waitForTimeout(2500);
  return { status: 'ok', created: name };
}

// Move a Storage document into one of the user's custom folders. Flow verified
// live against the real DOM: open the card's action menu ("..."), click the
// (visible) "Move" item, then in the "Select a folder" bottom sheet tick the
// target folder's checkbox and press the sheet's "Move" button.
//
// The document is addressed by its position (index) in the currently loaded
// My-Documents datascroller, or by a text substring (e.g. a date "30.05.2025").
// Pick the lowest on-screen match for both the folder option and the Move
// button, since the bottom sheet renders below the (dimmed) folder tiles.
async function moveToFolder(p, { index, title, folder }) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(2000);
  // Indices come from listStorageDocuments(scroll_all), which sees every card;
  // a freshly opened Storage view only holds the first lazy-loaded batch, so
  // load the rest before resolving one by position.
  await loadAllCards(p);

  // Resolve the target document card (Storage documents are div.letter-wrapper).
  const cards = p.locator('div.letter-wrapper');
  let card = null;
  if (typeof index === 'number') {
    if (index >= await cards.count()) throw new Error(`index ${index} out of range (${await cards.count()} loaded documents)`);
    card = cards.nth(index);
  } else if (title) {
    card = p.locator('div.letter-wrapper', { hasText: title }).first();
    if (!(await card.count())) throw new Error(`no document matching "${title}"`);
  } else {
    throw new Error('pass either index or title');
  }
  await card.scrollIntoViewIfNeeded().catch(() => {});

  // Open this card's action menu ("...").
  const menuBtn = card.locator('.letter-action-menu').first();
  if (!(await menuBtn.count())) throw new Error('action menu ("...") not found on the document');
  await menuBtn.click({ timeout: 8000 });
  await p.waitForTimeout(1000);

  // Click the visible "Move" item (there is one hidden tooltip menu per card).
  if (!(await clickVisibleByText(p, 'Move'))) throw new Error('"Move" menu item did not become visible');
  await p.waitForTimeout(1800);

  // "Select a folder" bottom sheet. Each folder option is a `.brand-container`
  // holding the name and a PrimeFaces checkbox. The checkbox sits low in a
  // horizontal strip where a real Playwright click can be swallowed, so select
  // it by dispatching a click in-page on the VISIBLE container's checkbox.
  await p.locator('[id*="storage-folder-selection"]').filter({ hasText: 'Select a folder' }).first()
    .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  // ePost folder membership is a multi-select of checkboxes (a document can live
  // in several folders), so "adding to a folder" means TICKING its box. Toggling
  // is dangerous for bulk filing — ticking an already-member folder would REMOVE
  // it — so this is idempotent: only tick when not already a member, and no-op
  // (close the sheet unchanged) when the document is already filed there.
  const picked = await p.evaluate((folderName) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const bc = [...document.querySelectorAll('.brand-container')].find(c => clean(c.innerText) === folderName && c.offsetParent !== null);
    if (!bc) return { ok: false };
    const box = bc.querySelector('.ui-chkbox-box');
    const already = box ? box.classList.contains('ui-state-active') : false;
    const tgt = box || bc.querySelector('.folder-wrapper') || bc;
    tgt.scrollIntoView({ block: 'center', inline: 'center' });
    if (!already) tgt.click();
    return { ok: true, already };
  }, folder);
  if (!picked.ok) throw new Error(`folder "${folder}" not offered in the move sheet`);
  await p.waitForTimeout(600);

  if (picked.already) {
    const cancel = p.locator('[id$=":cancel"]').first();
    if (await cancel.count()) await cancel.click({ timeout: 5000, force: true }).catch(() => {});
    return { status: 'ok', folder, already_in_folder: true };
  }

  // Confirm with the sheet's Move button (own id ":moveBtn"; aria-disabled can
  // lag behind the real state once a folder is ticked, so force the click).
  const confirmBtn = p.locator('[id$=":moveBtn"]').first();
  if (!(await confirmBtn.count())) throw new Error('move confirm button (:moveBtn) not found');
  await confirmBtn.click({ timeout: 8000, force: true });
  await p.waitForTimeout(1500);

  // Some moves raise a confirmation popup — accept it best-effort if present.
  const popup = p.locator('[id*="folderMovingConfirmationPopup"]');
  if (await popup.count()) {
    for (const label of ['Yes', 'Move', 'Confirm', 'OK']) {
      const b = popup.getByText(label, { exact: true }).first();
      if ((await b.count()) && await b.isVisible().catch(() => false)) { await b.click({ timeout: 5000 }).catch(() => {}); break; }
    }
  }
  await p.waitForTimeout(2500);
  return { status: 'ok', moved: { index, title, folder } };
}

// One-time interactive enrolment: opens a headed window with a virtual
// authenticator already attached, waits while YOU add a passkey in the SwissID
// security settings, then exports the created credential to the keychain.
async function passkeyRegister(p, waitMs = 480000) {
  const { cdp, ids } = await attachAuthenticator(p);
  try {
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await p.bringToFront().catch(() => {});
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const c = await findCredential(cdp, ids);
      if (c?.credentialId && c?.privateKey) {
        keychainWrite(KC_SERVICE, JSON.stringify({
          credentialId: c.credentialId,
          rpId: c.rpId,
          privateKey: c.privateKey,
          userHandle: c.userHandle || '',
          signCount: c.signCount || 0,
        }));
        await saveState();
        return { status: 'ok', rpId: c.rpId, transport: c.transport, stored_in: `macOS keychain (${KC_SERVICE})` };
      }
      await p.waitForTimeout(2500);
    }
    // No passkey appeared, but the window may still have been used to log in —
    // keep that session rather than throwing the manual login away.
    await saveState();
    return { status: 'timeout', message: 'No passkey was created in the open window; any session established there was cached.' };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// Letterbox access that heals an expired session by itself when a passkey is
// enrolled: try normally, and on login_required re-authenticate and retry once.
async function ensureSession(p) {
  let st = await ensureLetterbox(p);
  if (st === 'ok' || !loadPasskey()) return st;
  st = await passkeyLogin(p);
  return st === 'no_passkey' ? 'login_required' : st;
}

// Click the first VISIBLE element whose exact text is `t`.
async function clickVisibleByText(p, t) {
  const loc = p.getByText(t, { exact: true });
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 6000 }); return true; }
  }
  return false;
}

// --- MCP wiring -------------------------------------------------------------

const TOOLS = [
  { name: 'epost_status', description: 'Check whether the ePost session is alive (ok) or an interactive SwissID login is needed (login_required).', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_login', description: 'Open a VISIBLE browser window on app.epost.ch so you can complete the SwissID login (incl. 2FA). Waits up to 8 minutes, then caches the session to disk.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_passkey_status', description: 'Report whether a software passkey is enrolled for hands-free SwissID re-login.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_passkey_register', description: 'ONE-TIME: open a visible window with a virtual FIDO2 authenticator attached; add a passkey in your SwissID security settings and the credential is exported to the macOS keychain. Afterwards expired sessions re-login automatically, with no Touch ID or SMS code. SECURITY: this key is software-held and exportable — it trades phishing-resistance for automation.', inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', description: 'how long to keep the window open (default 480)' } } } },
  { name: 'epost_passkey_forget', description: 'Delete the locally stored passkey from the macOS keychain (also remove it in the SwissID account settings to fully revoke).', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_list_letters', description: 'List the letters currently in the digital letterbox (index, sender, title, dates, preview).', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_download_letter', description: 'Download one letter by list index to output_dir. Returns the saved path (YYYY-MM-DD_ePost_<index>.pdf).', inputSchema: { type: 'object', properties: { index: { type: 'number' }, output_dir: { type: 'string' } }, required: ['index', 'output_dir'] } },
  { name: 'epost_download_all', description: 'Download every letter in the letterbox to output_dir. Returns the saved paths.', inputSchema: { type: 'object', properties: { output_dir: { type: 'string' } }, required: ['output_dir'] } },
  { name: 'epost_list_storage', description: 'List the user\'s custom folders (name + document count) in the ePost Storage area plus the unsorted My-Documents count.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_list_storage_documents', description: 'List the individual documents in Storage (index, date, and "Stored in <folder>" tag if filed). Pass scroll_all=true to lazy-load every card before listing.', inputSchema: { type: 'object', properties: { scroll_all: { type: 'boolean', description: 'wheel-scroll until all cards are loaded (default false)' } } } },
  { name: 'epost_create_folder', description: 'Create a new custom folder in the ePost Storage area.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'epost_move_to_folder', description: 'File a Storage document into a custom folder (addressed by index in the loaded My-Documents list, or by a text substring such as a date). ePost documents can belong to several folders, so this ADDS the folder membership; it is idempotent (no-op if already filed there) and never removes an existing membership. Note: filing a document bumps it to the top of the "Last used" order, so re-list before addressing the next one by index.', inputSchema: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, folder: { type: 'string' } }, required: ['folder'] } },
];

const server = new Server({ name: 'epost-mcp', version: '0.5.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
  try {
    if (name === 'epost_status') {
      const p = await getPage();
      const status = await ensureSession(p);
      await saveState();
      return text({ status, passkey: loadPasskey() ? 'enrolled' : 'none' });
    }
    if (name === 'epost_passkey_status') {
      const c = loadPasskey();
      return text(c
        ? { passkey: 'enrolled', rpId: c.rpId, signCount: c.signCount, stored_in: `macOS keychain (${KC_SERVICE})` }
        : { passkey: 'none', hint: 'Run epost_passkey_register once to enable hands-free re-login.' });
    }
    if (name === 'epost_passkey_register') {
      const p = await getPage(true);
      const out = await passkeyRegister(p, Math.max(30, Number(args.wait_seconds) || 480) * 1000);
      return text(out);
    }
    if (name === 'epost_passkey_forget') {
      const removed = keychainDelete(KC_SERVICE);
      return text({ removed, note: 'Also delete the passkey in your SwissID account settings to fully revoke it.' });
    }
    if (name === 'epost_login') {
      const p = await getPage(true);
      await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await p.bringToFront().catch(() => {});
      // Wait (up to 8 min) until the user has ACTUALLY authenticated. Success is
      // signalled by a real authenticated surface — the letterbox itself or the
      // dashboard's "Digital Letterbox" entry — NOT merely being on app.epost.ch
      // (the pre-redirect and login pages also live under that host, which made
      // the old waitForURL predicate resolve instantly without waiting).
      // We only OBSERVE here (no re-navigation), so a half-entered SwissID form
      // is never disrupted; and we require two consecutive positive polls so a
      // brief app-shell flash before a redirect to login can't false-positive.
      const deadline = Date.now() + 480000;
      let authed = false, hits = 0;
      while (Date.now() < deadline) {
        let ok = false;
        if (!(await isLoginPage(p).catch(() => false))) {
          const u = p.url();
          ok = u.includes('DigitalLetterboxOverview')
            || !!(await p.locator('div.letter-wrapper').count().catch(() => 0))
            || !!(await p.getByText('Digital Letterbox', { exact: false }).count().catch(() => 0));
        }
        hits = ok ? hits + 1 : 0;
        if (hits >= 2) { authed = true; break; }
        await p.waitForTimeout(2500);
      }
      // Now that we're authenticated it's safe to navigate into the letterbox.
      const status = authed ? await ensureLetterbox(p) : 'login_required';
      await saveState();
      return text({ status, message: status === 'ok' ? `Login OK — session cached to ${STATE}` : 'Login not completed in time; run epost_login again.' });
    }

    const p = await getPage();

    if (name === 'epost_list_letters') {
      const st = await ensureSession(p);
      if (st !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      const out = await listLetters(p);
      await saveState();
      return text(out);
    }
    if (name === 'epost_download_letter') {
      const st = await ensureSession(p);
      if (st !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      const letters = await listLetters(p);
      const saved = await downloadLetter(p, args.index, args.output_dir, letters[args.index]);
      await saveState();
      return text({ saved });
    }
    if (name === 'epost_download_all') {
      const st = await ensureSession(p);
      if (st !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      const letters = await listLetters(p);
      const saved = [];
      for (const l of letters) saved.push(await downloadLetter(p, l.index, args.output_dir, l));
      await saveState();
      return text({ count: saved.length, saved });
    }
    if (name === 'epost_list_storage') {
      const out = await listStorage(p);
      await saveState();
      if (out.status !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_list_storage_documents') {
      const out = await listStorageDocuments(p, { scrollAll: args.scroll_all === true });
      await saveState();
      if (out.status !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_create_folder') {
      const out = await createFolder(p, args.name);
      await saveState();
      if (out.status && out.status !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_move_to_folder') {
      const out = await moveToFolder(p, { index: args.index, title: args.title, folder: args.folder });
      await saveState();
      if (out.status && out.status !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    return text({ error: `unknown tool ${name}` });
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
