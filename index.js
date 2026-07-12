#!/usr/bin/env node
// epost-mcp — MCP server for the Swiss ePost digital letterbox (app.epost.ch).
//
// ePost offers no public retrieval API for private customers, so this server
// drives the web portal with Playwright. Sessions (SwissID) are kept in a
// persistent browser profile; when the session expires, call `epost_login`
// and complete SwissID interactively in the opened window.
//
// Env:
//   EPOST_PROFILE   browser profile dir   (default: ~/.epost-mcp/profile)
//   EPOST_CHROMIUM  chromium executable   (default: auto-detect playwright cache)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROFILE = process.env.EPOST_PROFILE || join(homedir(), '.epost-mcp', 'profile');
const LETTERBOX_URL = 'https://app.epost.ch';

function findChromium() {
  if (process.env.EPOST_CHROMIUM) return process.env.EPOST_CHROMIUM;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* fall through to cache scan */ }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter(n => n.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined; // let playwright resolve (may require `npx playwright install chromium`)
}

let ctx = null;
let headed = false;

async function browser(wantHeaded = false) {
  if (ctx && (headed || !wantHeaded)) return ctx;
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
  mkdirSync(PROFILE, { recursive: true });
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: !wantHeaded,
    executablePath: findChromium(),
    locale: 'de-CH',
    viewport: { width: 1400, height: 1000 },
  });
  headed = wantHeaded;
  return ctx;
}

async function page() {
  const c = await browser(headed);
  return c.pages()[0] || await c.newPage();
}

// Returns 'ok' when the letterbox is reachable, 'login_required' otherwise.
async function ensureLetterbox(p, timeout = 30000) {
  if (!p.url().includes('DigitalLetterboxOverview')) {
    await p.goto(LETTERBOX_URL, { waitUntil: 'domcontentloaded', timeout });
  }
  await p.waitForTimeout(3000);
  for (let i = 0; i < 10; i++) {
    const u = p.url();
    if (u.includes('DigitalLetterboxOverview') || (u.includes('app.epost.ch') && !u.includes('oauth_login'))) {
      if (!u.includes('DigitalLetterboxOverview')) {
        await p.goto(LETTERBOX_URL, { waitUntil: 'domcontentloaded', timeout }).catch(() => {});
        await p.waitForTimeout(3000);
      }
      if (p.url().includes('DigitalLetterboxOverview')) return 'ok';
    }
    if (u.includes('swissid.ch') || u.includes('login.epost.ch')) return 'login_required';
    await p.waitForTimeout(1500);
  }
  return p.url().includes('DigitalLetterboxOverview') ? 'ok' : 'login_required';
}

async function listLetters(p) {
  await p.waitForSelector('div.letter-wrapper', { timeout: 20000 });
  return p.$$eval('div.letter-wrapper', els => els.map((el, i) => {
    const pick = sel => { const n = el.querySelector(sel); return n ? n.innerText.replace(/\s+/g, ' ').trim() : ''; };
    const dates = [...el.innerText.matchAll(/\d{2}\.\d{2}\.\d{4}/g)].map(m => m[0]);
    return { index: i, sender: pick('.sender-name'), title: pick('.letter-title-name'), dates, preview: el.innerText.replace(/\s+/g, ' ').slice(0, 120) };
  }));
}

async function downloadLetter(p, index, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const wrappers = p.locator('div.letter-wrapper');
  const n = await wrappers.count();
  if (index >= n) throw new Error(`index ${index} >= ${n} Briefe`);
  await wrappers.nth(index).click();
  await p.waitForTimeout(4000);
  // Download-Knopf im Detail-Dialog (JSF-ids sind instabil → mehrere Strategien)
  const candidates = [
    p.locator('[id*="letterDetailForm"]').locator('a,button').filter({ hasText: /download/i }).first(),
    p.getByLabel(/download file/i).first(),
    p.locator('[aria-label*="ownload"], [title*="ownload"]').first(),
  ];
  let saved = null;
  for (const c of candidates) {
    if (!(await c.count())) continue;
    try {
      const [dl] = await Promise.all([
        p.waitForEvent('download', { timeout: 15000 }),
        c.click(),
      ]);
      const meta = (await listLetters(p).catch(() => []))[index] || {};
      const stamp = (meta.dates && meta.dates[0]) ? meta.dates[0].split('.').reverse().join('-') : 'undatiert';
      const base = `${stamp}_ePost_${(meta.sender || 'Brief').replace(/[^A-Za-z0-9äöüÄÖÜ]+/g, '_')}_${index}.pdf`;
      saved = join(outputDir, base);
      await dl.saveAs(saved);
      break;
    } catch { /* nächste Strategie */ }
  }
  await p.keyboard.press('Escape').catch(() => {});
  await p.waitForTimeout(1500);
  if (!saved) throw new Error('Download-Knopf nicht gefunden / kein Download ausgelöst');
  return saved;
}

const TOOLS = [
  { name: 'epost_status', description: 'Check whether the ePost session is alive (ok) or interactive SwissID login is needed (login_required).', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_login', description: 'Open a visible browser window on app.epost.ch so the user can complete the SwissID login. Waits up to 8 minutes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_list_letters', description: 'List the letters currently in the digital letterbox (index, sender, title, dates).', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_download_letter', description: 'Download one letter by list index to output_dir; returns the saved path.', inputSchema: { type: 'object', properties: { index: { type: 'number' }, output_dir: { type: 'string' } }, required: ['index', 'output_dir'] } },
  { name: 'epost_download_all', description: 'Download every letter in the letterbox to output_dir; returns the saved paths.', inputSchema: { type: 'object', properties: { output_dir: { type: 'string' } }, required: ['output_dir'] } },
];

const server = new Server({ name: 'epost-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
  try {
    if (name === 'epost_status') {
      const p = await page();
      return text({ status: await ensureLetterbox(p) });
    }
    if (name === 'epost_login') {
      await browser(true);
      const p = await page();
      await p.goto(LETTERBOX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.bringToFront().catch(() => {});
      await p.waitForURL(u => String(u).includes('DigitalLetterboxOverview'), { timeout: 480000 });
      return text({ status: 'ok', message: 'Login erfolgreich, Session im Profil gespeichert.' });
    }
    const p = await page();
    const st = await ensureLetterbox(p);
    if (st !== 'ok') return text({ status: 'login_required', message: 'Bitte zuerst epost_login ausführen (SwissID).' });
    if (name === 'epost_list_letters') return text(await listLetters(p));
    if (name === 'epost_download_letter') return text({ saved: await downloadLetter(p, args.index, args.output_dir) });
    if (name === 'epost_download_all') {
      const letters = await listLetters(p);
      const saved = [];
      for (const l of letters) saved.push(await downloadLetter(p, l.index, args.output_dir));
      return text({ count: saved.length, saved });
    }
    return text({ error: `unknown tool ${name}` });
  } catch (e) {
    return { content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
