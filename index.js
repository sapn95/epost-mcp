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
  const st = await ensureLetterbox(p);
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

// Best-effort scrape of folder tiles and the unsorted "My Documents (N)" count.
async function listStorage(p) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(2500);
  const data = await p.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const seen = new Set();
    const folders = [];
    // Folder tiles render their name and a "(count)" badge; harvest any short
    // "Name (123)" label on the page.
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 3) continue;
      const t = clean(el.innerText);
      const m = t.match(/^(.{1,40}?)\s*\((\d+)\)$/);
      if (m && !seen.has(t)) { seen.add(t); folders.push({ name: m[1].trim(), count: Number(m[2]) }); }
    }
    const body = clean(document.body.innerText);
    const my = body.match(/My Documents\s*\((\d+)\)/i);
    return {
      url: location.href,
      myDocuments: my ? Number(my[1]) : null,
      folders,
    };
  });
  return { status: 'ok', ...data };
}

async function createFolder(p, name) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  const cf = p.getByText('Create a folder', { exact: false }).first();
  if (!(await cf.count())) throw new Error('"Create a folder" button not found');
  await cf.click({ timeout: 10000 });
  await p.waitForTimeout(1500);
  const input = p.locator('input[type="text"]:visible, input:not([type]):visible, [contenteditable="true"]:visible').first();
  await input.fill(name, { timeout: 8000 });
  const confirm = p.getByRole('button', { name: /create|save|speichern|erstellen|hinzuf(ü|u)gen|add|confirm|ok|anlegen/i }).first();
  if (await confirm.count()) await confirm.click({ timeout: 8000 });
  else await p.keyboard.press('Enter');
  await p.waitForTimeout(2500);
  return { status: 'ok', created: name };
}

// EXPERIMENTAL: the exact move DOM could not be verified against a live session.
// Attempts: locate the document card (by index or title substring in the
// My-Documents list), open its "..." menu, choose Move, then pick the folder.
async function moveToFolder(p, { index, title, folder }) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(2000);

  // Resolve the target document card.
  const cards = p.locator('.document-card, [class*="document"], .letter-wrapper, [class*="doc-card"]');
  let card = null;
  if (typeof index === 'number' && await cards.count() > index) {
    card = cards.nth(index);
  } else if (title) {
    const byTitle = p.locator(`text=${title}`).first();
    if (await byTitle.count()) card = byTitle;
  }
  if (!card || !(await card.count())) {
    throw new Error('document not found (pass a valid index or a title substring)');
  }
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await card.hover().catch(() => {});

  // Open the three-dots menu on/near the card.
  const dots = card.locator('[aria-label*="more" i], [aria-label*="option" i], [aria-label*="menu" i], button:has-text("…"), button:has-text("...")').first();
  const dotsGlobal = p.locator('[aria-label*="more" i], [aria-label*="option" i]').first();
  const menuBtn = (await dots.count()) ? dots : dotsGlobal;
  if (!(await menuBtn.count())) throw new Error('three-dots menu not found on the document card');
  await menuBtn.click({ timeout: 8000 });
  await p.waitForTimeout(1200);

  const moveItem = p.getByText(/^\s*(move|verschieben)/i).first();
  if (!(await moveItem.count())) throw new Error('"Move" entry not found in the document menu');
  await moveItem.click({ timeout: 8000 });
  await p.waitForTimeout(1500);

  const folderChoice = p.getByText(folder, { exact: false }).first();
  if (!(await folderChoice.count())) throw new Error(`target folder "${folder}" not found in the move dialog`);
  await folderChoice.click({ timeout: 8000 });
  await p.waitForTimeout(1000);
  const confirm = p.getByRole('button', { name: /move|verschieben|save|speichern|confirm|ok/i }).first();
  if (await confirm.count()) await confirm.click({ timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(2500);
  return { status: 'ok', moved: { index, title, folder }, note: 'experimental — verify in the ePost UI' };
}

// --- MCP wiring -------------------------------------------------------------

const TOOLS = [
  { name: 'epost_status', description: 'Check whether the ePost session is alive (ok) or an interactive SwissID login is needed (login_required).', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_login', description: 'Open a VISIBLE browser window on app.epost.ch so you can complete the SwissID login (incl. 2FA). Waits up to 8 minutes, then caches the session to disk.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_list_letters', description: 'List the letters currently in the digital letterbox (index, sender, title, dates, preview).', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_download_letter', description: 'Download one letter by list index to output_dir. Returns the saved path (YYYY-MM-DD_ePost_<index>.pdf).', inputSchema: { type: 'object', properties: { index: { type: 'number' }, output_dir: { type: 'string' } }, required: ['index', 'output_dir'] } },
  { name: 'epost_download_all', description: 'Download every letter in the letterbox to output_dir. Returns the saved paths.', inputSchema: { type: 'object', properties: { output_dir: { type: 'string' } }, required: ['output_dir'] } },
  { name: 'epost_list_storage', description: 'List the folders (with document counts) in the ePost Storage area plus the unsorted My-Documents count.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_create_folder', description: 'Create a new folder in the ePost Storage area.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'epost_move_to_folder', description: 'EXPERIMENTAL: move a document (by index or title substring) into a target folder in Storage. Verify the result in the ePost UI.', inputSchema: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, folder: { type: 'string' } }, required: ['folder'] } },
];

const server = new Server({ name: 'epost-mcp', version: '0.3.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
  try {
    if (name === 'epost_status') {
      const p = await getPage();
      const status = await ensureLetterbox(p);
      await saveState();
      return text({ status });
    }
    if (name === 'epost_login') {
      const p = await getPage(true);
      await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.bringToFront().catch(() => {});
      await p.waitForURL(u => String(u).includes('DigitalLetterboxOverview') || String(u).includes('app.epost.ch') && !String(u).includes('oauth_login'), { timeout: 480000 }).catch(() => {});
      // Give the dashboard a moment, then confirm and cache.
      const status = await ensureLetterbox(p);
      await saveState();
      return text({ status, message: status === 'ok' ? `Login OK — session cached to ${STATE}` : 'Login window opened but the letterbox was not reached; try again.' });
    }

    const p = await getPage();

    if (name === 'epost_list_letters') {
      const st = await ensureLetterbox(p);
      if (st !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      const out = await listLetters(p);
      await saveState();
      return text(out);
    }
    if (name === 'epost_download_letter') {
      const st = await ensureLetterbox(p);
      if (st !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      const letters = await listLetters(p);
      const saved = await downloadLetter(p, args.index, args.output_dir, letters[args.index]);
      await saveState();
      return text({ saved });
    }
    if (name === 'epost_download_all') {
      const st = await ensureLetterbox(p);
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
