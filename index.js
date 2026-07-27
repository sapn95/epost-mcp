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
//   EPOST_PROFILE   persistent browser profile (default: ~/.epost-mcp/profile)
//   EPOST_BROWSER   chrome | chrome-canary | edge | brave | chromium | abs. path
//   EPOST_SWISSID_USER  account e-mail (or keychain epost-mcp-swissid-user)
//   EPOST_TRANSPORT auto (default) | api | browser
//   EPOST_API_PASSWORD  API password (or keychain epost-mcp-api-password)
//   EPOST_DEBUG     1 = trace the login steps on stderr

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import { existsSync, readdirSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// Name and version come from package.json, never from a second copy here:
// `npm version` only bumps package.json, so a hardcoded string silently
// advertises a stale version to every client.
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const STATE = process.env.EPOST_STATE || join(homedir(), '.epost-mcp', 'state.json');
const PROFILE = process.env.EPOST_PROFILE || join(homedir(), '.epost-mcp', 'profile');
const APP_URL = 'https://app.epost.ch';

// --- browser bootstrap ------------------------------------------------------

// Which browser to drive. This matters for more than taste: Playwright's own
// Chromium is an unsigned test build with no access to the macOS platform
// authenticator — it reports isUserVerifyingPlatformAuthenticatorAvailable()
// === false, so Touch ID is never offered and SwissID falls back to password
// plus SMS. An installed, signed browser reports true and can reach the Secure
// Enclave, which is what makes the assisted passkey login possible.
const BROWSERS = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'chrome-canary': '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};
const BROWSER_ORDER = ['chrome', 'chrome-canary', 'edge', 'brave'];

// What we settled on and why — reported by epost_settings.
let browserChoice = { path: undefined, key: null, reason: '' };

function findChromium() {
  const pick = (path, key, reason) => { browserChoice = { path, key, reason }; return path; };

  // 1. Explicit choice: a key from BROWSERS, or an absolute path.
  const want = process.env.EPOST_BROWSER || process.env.EPOST_CHROMIUM;
  if (want && want !== 'chromium') {
    const path = BROWSERS[want] || want;
    if (!existsSync(path)) throw new Error(`EPOST_BROWSER="${want}" not found (looked at ${path})`);
    return pick(path, BROWSERS[want] ? want : 'custom', 'EPOST_BROWSER');
  }
  // 2. Otherwise prefer a signed system browser, so passkeys stay possible.
  if (!want) {
    for (const key of BROWSER_ORDER) {
      if (existsSync(BROWSERS[key])) return pick(BROWSERS[key], key, 'signed system browser (passkey-capable)');
    }
  }
  // 3. Fall back to Playwright's Chromium: fine for everything but passkeys.
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return pick(p, 'chromium', 'bundled Chromium — no Touch ID support');
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

// Re-seed a fresh context from the cached storageState. A persistent profile
// drops session cookies when the browser closes, so the two mechanisms cover
// different halves of the problem — see getContext.
async function seedFromState(c) {
  if (!existsSync(STATE)) return;
  try {
    const saved = JSON.parse(readFileSync(STATE, 'utf8'));
    if (saved.cookies?.length) await c.addCookies(saved.cookies).catch(() => {});
  } catch { /* a corrupt state file just means "log in again" */ }
}

async function getContext(wantHeaded = false) {
  // Reuse an existing context unless we specifically need a headed one but only
  // have a headless one (the interactive login case).
  if (ctx && (!wantHeaded || headed)) return ctx;
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
  if (browserObj) { await browserObj.close().catch(() => {}); browserObj = null; }

  // A PERSISTENT profile plus the cached storageState, deliberately both:
  //   - the profile keeps everything a fresh context throws away, notably
  //     SwissID's "this device is known" state, so an expired session costs a
  //     password but not a fresh SMS code;
  //   - storageState carries the session cookies, which a persistent profile
  //     drops on close.
  // v0.3.0 replaced the profile with storageState alone, which is why every
  // expiry meant the full two-factor dance again.
  mkdirSync(PROFILE, { recursive: true });
  const launch = () => chromium.launchPersistentContext(PROFILE, {
    headless: !wantHeaded,
    executablePath: findChromium(),
    acceptDownloads: true,
    locale: 'de-CH',
    viewport: { width: 1400, height: 1000 },
  });
  try {
    ctx = await launch();
  } catch (e) {
    // A browser that was killed rather than closed leaves SingletonLock behind,
    // and Chrome then refuses to start at all ("Failed to create a
    // ProcessSingleton for your profile directory"). Every later call fails the
    // same way until the file goes, so clear the stale lock and retry once.
    if (!/ProcessSingleton|SingletonLock/.test(e.message || '')) throw e;
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { rmSync(join(PROFILE, f), { force: true }); } catch { /* nothing to clear */ }
    }
    ctx = await launch();
  }
  browserObj = null;              // a persistent context owns its browser
  await seedFromState(ctx);
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


// --- public API (preferred transport) ---------------------------------------
//
// ePost publishes a documented REST API for the Digital Letterbox, and a private
// tenant can use it: set a password once on the Keycloak account
// (login.epost.ch/auth/realms/klara/account/ -> Authentication -> set password)
// and authenticate with e-mail + password. See
// https://developer.epost.ch/docs/api-docs/v6nqmmjkxcery-how-to-access-the-letterbox-public-ap-is-with-a-private-tenant
//
// This is strictly better than driving the portal: the listing carries a real
// `description` ("Invoice from ...") and `documentTypes` instead of the
// uniform "Gescannter Brief" the UI shows, archiving is one PATCH instead of a
// two-step folder sheet, and nothing depends on a selector. Browser automation
// remains as the fallback for whatever the API does not cover, and for when it
// is unavailable.
//
// Auth chain (both documented):
//   POST /core/latest/tenants  {username,password}                -> tenant_id, company_id
//   POST /core/latest/token    {username,password,grant_type=password,tenant_id,company_id}
//                                                                  -> access_token (600s)

const API_BASE = process.env.EPOST_API_BASE || 'https://api.epost.ch';
// auto (default) = API when it can serve the call, browser otherwise.
// Forcing one is for diagnosis and for the operations only the browser can do.
const TRANSPORT = (process.env.EPOST_TRANSPORT || 'auto').toLowerCase();
const KC_API_PASSWORD = 'epost-mcp-api-password';

let apiToken = null;          // { value, expiresAt, tenant }
let apiUnavailable = null;    // why the API cannot be used, once known

function apiCredentials() {
  if (TRANSPORT === 'browser') return null;      // pinned to the browser
  const user = swissIdUser();
  const password = process.env.EPOST_API_PASSWORD || keychainRead(KC_API_PASSWORD);
  return user && password ? { user, password } : null;
}

async function apiFetch(method, path, { params, form, token, raw } = {}) {
  const url = new URL(path, API_BASE);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    const err = new Error(`${method} ${path} -> ${res.status}${detail ? ` ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  if (raw) return Buffer.from(await res.arrayBuffer());
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// A token lasts 600s. Re-authenticate slightly early rather than tracking the
// refresh token: the password is already at hand, so a refresh buys nothing.
async function apiAuth() {
  if (apiToken && Date.now() < apiToken.expiresAt) return apiToken.value;
  const creds = apiCredentials();
  if (!creds) {
    apiUnavailable = 'no API password configured (keychain item epost-mcp-api-password)';
    return null;
  }
  try {
    const tenants = await apiFetch('POST', '/core/latest/tenants',
      { form: { username: creds.user, password: creds.password } });
    const tenant = (Array.isArray(tenants) ? tenants : [tenants])[0];
    if (!tenant?.tenant_id) throw new Error('no tenant returned');
    const tok = await apiFetch('POST', '/core/latest/token', {
      form: {
        username: creds.user, password: creds.password, grant_type: 'password',
        tenant_id: tenant.tenant_id, company_id: tenant.company_id,
      },
    });
    apiToken = {
      value: tok.access_token,
      expiresAt: Date.now() + Math.max(30, (tok.expires_in || 600) - 60) * 1000,
      tenant,
    };
    apiUnavailable = null;
    if (DEBUG) console.error('[api] authenticated, expires_in', tok.expires_in);
    return apiToken.value;
  } catch (e) {
    apiUnavailable = e.message;
    if (DEBUG) console.error('[api] auth failed:', e.message);
    return null;
  }
}

// Run `fn` against the API; return null if the API cannot serve it, so the
// caller falls back to the browser instead of failing.
async function withApi(fn) {
  const token = await apiAuth();
  if (!token) return null;
  try {
    return await fn(token);
  } catch (e) {
    if (e.status === 401) { apiToken = null; }   // expired mid-call: retry once
    if (e.status === 401 && await apiAuth()) {
      try { return await fn(apiToken.value); } catch (e2) { apiUnavailable = e2.message; return null; }
    }
    apiUnavailable = e.message;
    if (DEBUG) console.error('[api] call failed:', e.message);
    return null;
  }
}

// Shape one API letter like the browser tools report them, so both transports
// return the same thing to a client.
function apiLetterRow(l, i) {
  return {
    index: i,
    id: l.id,
    sender: l.description || null,          // "Invoice from <sender>" when known
    title: l.letterTitle || null,
    documentTypes: l.documentTypes || [],
    date: (l.receivedDateTime || '').slice(0, 10).split('-').reverse().join('.') || null,
    receivedDateTime: l.receivedDateTime || null,
    fileName: l.fileName || null,
    read: l.readStatus === 'READ',
    storedIn: l.directoryNames || l.directoryName || undefined,
  };
}

const apiListLetters = (limit = 200) => withApi(t => apiFetch('GET', '/epost/v2/letters', {
  token: t, params: { 'letter-types': 'CLASSIC_LETTER', 'letter-folder': 'INBOX_FOLDER', limit },
}));

const apiListDirectories = () => withApi(t => apiFetch('GET', '/epost/v2/archives/directories', { token: t }));

const apiListArchive = (directoryId, limit = 1000) => withApi(t => apiFetch('GET', '/epost/v2/archives/letters', {
  token: t, params: { limit, 'directory-id': directoryId || undefined },
}));

const apiLetterContent = id => withApi(t => apiFetch('GET', `/epost/v2/letters/${id}/content`, { token: t, raw: true }));

const apiArchiveLetter = (id, directoryId) => withApi(t => apiFetch('PATCH', `/epost/v2/letters/${id}/archive`, {
  token: t, params: { 'destination-directory-id': directoryId || undefined },
}).then(() => true));


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
async function moveToFolder(p, { index, title, folder, add = true, remove = null }) {
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
  const picked = await p.evaluate(({ folderName, add, removeName }) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const boxFor = name => [...document.querySelectorAll('.brand-container')]
      .find(c => clean(c.innerText) === name && c.offsetParent !== null);
    // The box is a toggle, so clicking is only correct when the current state
    // differs from the state we want. Ticking an existing membership would
    // silently REMOVE it, and vice versa.
    const toggle = (bc, want) => {
      const box = bc.querySelector('.ui-chkbox-box');
      const on = box ? box.classList.contains('ui-state-active') : false;
      const tgt = box || bc.querySelector('.folder-wrapper') || bc;
      tgt.scrollIntoView({ block: 'center', inline: 'center' });
      const click = want ? !on : on;
      if (click) tgt.click();
      return { on, click };
    };
    const bc = boxFor(folderName);
    if (!bc) return { ok: false };
    const main = toggle(bc, add);
    // Re-filing: drop the old membership in the SAME sheet. Doing it alone
    // would leave an empty folder set, which the portal refuses to commit.
    let removed = null;
    if (removeName && removeName !== folderName) {
      const rc = boxFor(removeName);
      if (rc) removed = toggle(rc, false).click;
    }
    return { ok: true, already: main.on, changed: main.click || !!removed, removed };
  }, { folderName: folder, add, removeName: remove });
  if (!picked.ok) throw new Error(`folder "${folder}" not offered in the move sheet`);
  await p.waitForTimeout(600);

  if (!picked.changed) {
    const cancel = p.locator('[id$=":cancel"]').first();
    if (await cancel.count()) await cancel.click({ timeout: 5000, force: true }).catch(() => {});
    return { status: 'ok', folder, unchanged: true, in_folder: picked.already };
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

// The SwissID account e-mail, used to skip the "which account?" step.
function swissIdUser() {
  return process.env.EPOST_SWISSID_USER || keychainRead('epost-mcp-swissid-user') || '';
}

// Assisted login: drive every step of the SwissID chain that does NOT need a
// human, and stop at the one that does — the biometric prompt.
//
//   app.epost.ch → login.epost.ch    click "Login mit SwissID"
//                → login-email        fill the account e-mail, "Weiter"
//                → confirm-passkey    "Weiter"  → macOS asks for Touch ID
//                → (login-password)   fallback: "Mit Passkey anmelden"
//                → app.epost.ch, authenticated
//
// This is the practical answer to unattended login being impossible: a passkey
// cannot be used without genuine user presence, but everything around it can be
// automated, so an expired session costs one fingerprint instead of an e-mail,
// a password and an SMS code. Needs a signed browser — see findChromium.
async function assistedLogin(p, waitMs = 300000) {
  const user = swissIdUser();
  await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await p.bringToFront().catch(() => {});

  const deadline = Date.now() + waitMs;
  const done = new Set();
  let lastSeen = '';
  const once = async (step, action) => {
    if (done.has(step)) return false;
    done.add(step);
    if (DEBUG) console.error('[login]', step);
    await action();
    return true;
  };

  while (Date.now() < deadline) {
    await p.waitForTimeout(1500);
    const u = p.url();
    if (DEBUG && u !== lastSeen) { console.error('[login] at', u.slice(0, 90)); lastSeen = u; }

    if (/app\.epost\.ch/.test(u) && !/oauth_login|openid-connect/.test(u)
      && (u.includes('DigitalLetterboxOverview')
        || await p.locator('div.letter-wrapper').count().catch(() => 0)
        || await p.getByText('Digital Letterbox', { exact: false }).count().catch(() => 0))) {
      return await ensureLetterbox(p);
    }
    if (/login\.epost\.ch/.test(u) && await once('swissid', async () => {
      const b = p.getByRole('button', { name: /Login mit SwissID/i }).first();
      if (await b.count().catch(() => 0)) await b.click({ timeout: 8000 }).catch(() => {});
    })) continue;

    if (/login-email/.test(u) && user && await once('email', async () => {
      const i = p.locator('input[type=text], input[type=email]').first();
      if (await i.count().catch(() => 0)) {
        await i.fill(user, { timeout: 8000 }).catch(() => {});
        const n = p.getByRole('button', { name: /^Weiter$|^Continue$/i }).first();
        if (await n.count().catch(() => 0)) await n.click({ timeout: 8000 }).catch(() => {});
      }
    })) continue;

    // Clicking Weiter here raises the Touch ID sheet — the one step only the
    // human can finish.
    if (/confirm-passkey/.test(u) && await once('confirm', async () => {
      const n = p.getByRole('button', { name: /^Weiter$|^Continue$/i }).first();
      if (await n.count().catch(() => 0)) await n.click({ timeout: 8000 }).catch(() => {});
    })) continue;

    if (/login-password/.test(u) && await once('offer-passkey', async () => {
      const b = p.getByRole('button', { name: /Mit Passkey anmelden|passkey/i }).first();
      if (await b.count().catch(() => 0)) await b.click({ timeout: 8000 }).catch(() => {});
    })) continue;
  }
  return 'login_required';
}

// Did the relying party accept the freshly created credential? Returns
// 'accepted' | 'rejected' | 'unknown'. The registration page navigates to
// .../register-passkey-error when the server says no.
async function waitForRegistrationVerdict(p, ms = 45000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const u = p.url();
    if (/register-passkey-error|error/i.test(u)) return 'rejected';
    if (!/register-passkey/i.test(u)) return 'accepted';   // moved on = stored
    if (await p.getByText(/nicht geklappt|fehlgeschlagen|failed|error/i).count().catch(() => 0)) return 'rejected';
    await p.waitForTimeout(1500);
  }
  return 'unknown';
}

// One-time interactive enrolment: opens a headed window with a virtual
// authenticator already attached, waits while YOU add a passkey in the SwissID
// security settings, then exports the created credential to the keychain.
//
// NOTE: against SwissID this cannot succeed — see waitForRegistrationVerdict.
// The tools are kept because the mechanism is sound for relying parties that
// accept software authenticators; SwissID is not one of them.
async function passkeyRegister(p, waitMs = 480000) {
  const { cdp, ids } = await attachAuthenticator(p);
  try {
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await p.bringToFront().catch(() => {});
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const c = await findCredential(cdp, ids);
      if (c?.credentialId && c?.privateKey) {
        // A key in the authenticator only means the KEY was made. The relying
        // party still has to accept the attestation and store it on the account,
        // and SwissID rejects software authenticators outright:
        //   POST /api-login/authenticate/webauthn-register -> HTTP 400
        //   -> /login/register-passkey-error
        // Never report success on the local key alone — wait for the verdict.
        const verdict = await waitForRegistrationVerdict(p);
        if (verdict !== 'accepted') {
          return {
            status: 'rejected',
            message: 'The key was created locally but the identity provider refused to register it '
              + '(SwissID requires attested hardware authenticators). Nothing was stored.',
            page: p.url(),
          };
        }
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


// Move a letter out of the inbox into Storage ("Store" in the card menu). This
// is the archive action: unlike Delete it keeps the document, it just stops
// cluttering the inbox. Letters are addressed the same way as elsewhere — by
// list index, or by a text substring such as a date.
async function storeLetter(p, { index, title, folder }) {
  const st = await ensureSession(p);
  if (st !== 'ok') return { status: st };
  // Storing re-renders the list, and a menu or overlay left over from the
  // previous call silently swallows the next click ("locator.click: Timeout").
  // Start every store from a freshly rendered overview instead.
  await p.keyboard.press('Escape').catch(() => {});
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(2500);
  const cards = p.locator('div.letter-wrapper');
  await cards.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  let card = null;
  if (typeof index === 'number') {
    if (index >= await cards.count()) throw new Error(`index ${index} out of range (${await cards.count()} letters)`);
    card = cards.nth(index);
  } else if (title) {
    card = p.locator('div.letter-wrapper', { hasText: title }).first();
    if (!(await card.count())) throw new Error(`no letter matching "${title}"`);
  } else throw new Error('pass either index or title');

  const label = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 80);
  await card.scrollIntoViewIfNeeded().catch(() => {});
  const menu = card.locator('.letter-action-menu').first();
  if (!(await menu.count())) throw new Error('action menu ("...") not found on the letter');
  await menu.click({ timeout: 8000 });
  await p.waitForTimeout(1000);
  if (!(await clickVisibleByText(p, 'Store'))) throw new Error('"Store" menu item did not become visible');
  await p.waitForTimeout(2200);

  // Store is TWO steps. The menu item only opens a "Select a folder" sheet with
  // one checkbox per folder and its own Store button, greyed out until a folder
  // is ticked. Clicking the menu item and stopping leaves that sheet open: the
  // call looks successful, nothing is archived, and the open overlay swallows
  // every later click.
  // Scope the tile lookup to the SHEET. `.brand-container` also matches letter
  // cards in the list behind it, so a document-wide scan reads the inbox instead
  // of the folder tiles — and reports the letter's own text as an offered
  // "folder". Wait until the sheet actually holds tiles before reading.
  const sheet = p.locator('[id*="storage-folder-selection"]').first();
  await sheet.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await sheet.locator('.brand-container').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  const picked = await sheet.evaluate((root, folderName) => {
    // Normalise: macOS and the portal disagree on whether "ä" is one code point
    // or "a" plus a combining diaeresis, and a byte-exact compare then fails on
    // a folder name that looks identical on screen.
    const clean = s => (s || '').replace(/\s+/g, ' ').trim().normalize('NFC');
    // The tiles sit in a horizontally scrolling strip, so the ones off to the
    // right are not "visible" — filtering on offsetParent silently hides half
    // the folders and the target looks unavailable. Take them all and scroll
    // the wanted one into view before clicking.
    const tiles = [...root.querySelectorAll('.brand-container')];
    const offered = tiles.map(c => clean(c.innerText));
    const want = folderName.normalize('NFC');
    const bc = tiles.find(c => clean(c.innerText) === want)
      || tiles.find(c => clean(c.innerText).toLowerCase() === want.toLowerCase());
    if (!bc) return { ok: false, offered };
    bc.scrollIntoView({ block: 'center', inline: 'center' });
    const box = bc.querySelector('.ui-chkbox-box');
    // Checkboxes are toggles: only click when the state differs from what we want.
    if (!(box && box.classList.contains('ui-state-active'))) (box || bc).click();
    return { ok: true, offered };
  }, folder);
  if (!picked.ok) {
    const cancel = p.locator('[id$=":cancel"]').first();
    if (await cancel.count()) await cancel.click({ timeout: 5000, force: true }).catch(() => {});
    throw new Error(`folder "${folder}" not in the store sheet. Offered: ${picked.offered.join(' | ')}`);
  }
  await p.waitForTimeout(700);

  // Confirm with the sheet's own Store button. aria-disabled lags behind the
  // real state once a folder is ticked, so force the click.
  const confirm = sheet.getByText('Store', { exact: true }).last();
  if (await confirm.count().catch(() => 0)) {
    await confirm.click({ timeout: 8000, force: true }).catch(() => {});
  } else if (!(await clickVisibleByText(p, 'Store'))) {
    throw new Error('store confirm button not found in the sheet');
  }
  await p.waitForTimeout(3000);
  return { status: 'ok', stored: label, folder };
}


// Open a Storage document and read what the portal knows about it — optionally
// saving the PDF. This is the piece that makes sorting the archive possible: the
// card list only ever says "Gescannter Brief", while the detail panel names the
// actual sender, the document type and the amount.
//
// Storage documents ARE downloadable, contrary to what the card's "..." menu
// suggests: the menu only offers Copy / Move / Delete, but clicking the card
// opens a viewer whose toolbar carries the same "Download File" button as the
// inbox. Looking only at the menu is what made this look impossible.
async function readStorageDocument(p, { index, title, outputDir }) {
  const st = await goToStorage(p);
  if (st !== 'ok') return { status: st };
  await p.waitForTimeout(1500);
  await loadAllCards(p);

  const cards = p.locator('div.letter-wrapper');
  let card = null;
  if (typeof index === 'number') {
    if (index >= await cards.count()) throw new Error(`index ${index} out of range (${await cards.count()} documents)`);
    card = cards.nth(index);
  } else if (title) {
    card = p.locator('div.letter-wrapper', { hasText: title }).first();
    if (!(await card.count())) throw new Error(`no document matching "${title}"`);
  } else throw new Error('pass either index or title');

  await card.scrollIntoViewIfNeeded().catch(() => {});
  // The click target is the card body; the outer wrapper does not carry it.
  const body = card.locator('.letter-content').first();
  await (await body.count() ? body : card).click({ timeout: 10000 });
  await p.waitForTimeout(3500);

  const meta = await p.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const body = clean(document.body.innerText);
    const pick = re => (re.exec(body) || [])[1]?.trim() || null;
    return {
      subject: pick(/Gescannter Brief\s+(Invoice from [^C]+?)(?=\s+CHF|\s+Document type)/i),
      documentType: pick(/Document type\s+(\S+)/i),
      documentDate: pick(/Document date\s+(\d{2}\.\d{2}\.\d{4})/i),
      amount: pick(/CHF\s+([\d'’,.]+)/),
      storedIn: [...body.matchAll(/Stored in\s+([^\n]{1,60}?)(?=\s+Example|\s+Tracking|$)/gi)].map(m => m[1].trim())[0] || null,
      trackingNumber: pick(/Tracking number:\s*(\S+)/i),
      letterId: pick(/Letter ID:\s*(\S+)/i),
    };
  });

  let saved = null;
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
    const btn = p.getByRole('button', { name: 'Download File' }).first();
    const target = (await btn.count()) ? btn : p.locator('a.st-harddrive-download').first();
    if (await target.count()) {
      const [d] = await Promise.all([
        p.waitForEvent('download', { timeout: 25000 }),
        target.click({ timeout: 10000 }),
      ]);
      const stamp = (meta.documentDate || '').split('.').reverse().join('-') || 'undated';
      saved = join(outputDir, `${stamp}_ePostStorage_${index ?? 'x'}.pdf`);
      await d.saveAs(saved);
    }
  }
  await p.keyboard.press('Escape').catch(() => {});
  await p.waitForTimeout(1200);
  return { status: 'ok', index, ...meta, saved };
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
  { name: 'epost_login', description: 'Open a VISIBLE browser window and drive the whole SwissID login except the biometric prompt: it goes to SwissID, fills the account e-mail and requests the passkey, so you only confirm with Touch ID. Falls back to a normal manual login. Caches the session afterwards.', inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', description: 'how long to keep the window open (default 300)' } } } },
  { name: 'epost_settings', description: 'Show the resolved configuration: which browser is driven and why, whether it can use Touch ID passkeys, the profile/state paths, and whether the SwissID account e-mail is configured.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_passkey_status', description: 'Report whether a software passkey is enrolled for hands-free SwissID re-login.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_passkey_register', description: 'ONE-TIME: open a visible window with a virtual FIDO2 authenticator attached; add a passkey in your SwissID security settings and the credential is exported to the macOS keychain. Afterwards expired sessions re-login automatically, with no Touch ID or SMS code. SECURITY: this key is software-held and exportable — it trades phishing-resistance for automation.', inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', description: 'how long to keep the window open (default 480)' } } } },
  { name: 'epost_passkey_forget', description: 'Delete the locally stored passkey from the macOS keychain (also remove it in the SwissID account settings to fully revoke).', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_list_letters', description: 'List the letters currently in the digital letterbox (index, sender, title, dates, preview).', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_download_letter', description: 'Download one letter by list index to output_dir. Returns the saved path (YYYY-MM-DD_ePost_<index>.pdf).', inputSchema: { type: 'object', properties: { index: { type: 'number' }, output_dir: { type: 'string' } }, required: ['index', 'output_dir'] } },
  { name: 'epost_download_all', description: 'Download every letter in the letterbox to output_dir. Returns the saved paths.', inputSchema: { type: 'object', properties: { output_dir: { type: 'string' } }, required: ['output_dir'] } },
  { name: 'epost_store_letter', description: 'Archive a letter into a Storage folder (the "Store" action): keeps the document, this is not a delete. A target folder is REQUIRED — Store opens a "Select a folder" sheet and will not commit without one. Address the letter by index in the inbox list, or by a text substring such as a date; indices shift after each store, so re-list between calls.', inputSchema: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, letter_id: { type: 'string', description: 'API letter id (preferred — indices shift)' }, folder: { type: 'string', description: 'existing Storage folder to file it into' } }, required: ['folder'] } },
  { name: 'epost_list_storage', description: 'List the user\'s custom folders (name + document count) in the ePost Storage area plus the unsorted My-Documents count.', inputSchema: { type: 'object', properties: {} } },
  { name: 'epost_list_storage_documents', description: 'List the documents in Storage. Over the API each carries a real description ("Invoice from ...") and documentTypes; over the browser fallback only a date and the folder tag. Pass folder_id to list one folder, scroll_all for the browser path.', inputSchema: { type: 'object', properties: { folder_id: { type: 'string', description: 'limit to one folder (API only)' }, limit: { type: 'number' }, scroll_all: { type: 'boolean', description: 'browser fallback: load every card first' } } } },
  { name: 'epost_read_storage_document', description: 'Open one Storage document and report what the portal knows about it: the real sender/subject line, document type, date, amount and current folder. The card list only ever shows "Gescannter Brief", so this is the only way to classify an archived document. Pass output_dir to also save the PDF.', inputSchema: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, letter_id: { type: 'string' }, folder_id: { type: 'string' }, output_dir: { type: 'string', description: 'save the PDF here as well' } } } },
  { name: 'epost_create_folder', description: 'Create a new custom folder in the ePost Storage area.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'epost_unfile_from_folder', description: 'Remove a Storage document from a folder. NOTE: the portal will not commit an empty folder set, so this only works when the document is in more than one folder; to empty a folder that holds the document\'s only membership, use epost_move_to_folder with remove_from instead.', inputSchema: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, folder: { type: 'string' } }, required: ['folder'] } },
  { name: 'epost_move_to_folder', description: 'File a Storage document into a custom folder (addressed by index in the loaded My-Documents list, or by a text substring such as a date). Pass remove_from to re-file: the old folder is unticked in the same sheet, which is the only way to empty a folder that holds the document\'s only membership. ePost documents can belong to several folders, so this ADDS the folder membership; it is idempotent (no-op if already filed there) and never removes an existing membership. Note: filing a document bumps it to the top of the "Last used" order, so re-list before addressing the next one by index.', inputSchema: { type: 'object', properties: { index: { type: 'number' }, title: { type: 'string' }, folder: { type: 'string' }, remove_from: { type: 'string', description: 'folder to drop in the same step (re-file)' } }, required: ['folder'] } },
];

const server = new Server({ name: PKG.name, version: PKG.version }, { capabilities: { tools: {} } });
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
      const status = await assistedLogin(p, Math.max(30, Number(args.wait_seconds) || 300) * 1000);
      await saveState();
      const passkeyCapable = browserChoice.key && browserChoice.key !== 'chromium';
      return text({
        status,
        browser: browserChoice.key,
        message: status === 'ok'
          ? `Login OK — session cached to ${STATE}`
          : (passkeyCapable
            ? 'Not completed in time. The window drives everything except the biometric prompt — confirm that with Touch ID.'
            : 'Not completed in time. NOTE: the bundled Chromium cannot use Touch ID; set EPOST_BROWSER=chrome for a one-touch login.'),
      });
    }
    if (name === 'epost_settings') {
      const p = await getPage();
      const uvpaa = await p.evaluate(() =>
        PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(() => false)).catch(() => 'unknown');
      const user = swissIdUser();
      // The probe usually runs in the headless context, which has no biometric
      // UI and so always answers false. That says nothing about the headed
      // window epost_login opens, which is where Touch ID actually happens —
      // reporting the raw false here would be plain wrong.
      const signedBrowser = browserChoice.key && browserChoice.key !== 'chromium';
      const touchId = uvpaa === true ? 'available'
        : headed ? 'NOT available in this browser — login falls back to password + SMS'
          : signedBrowser
            ? `not probeable headless; expected to work in the headed login window (${browserChoice.key} is signed)`
            : 'NOT available — the bundled Chromium cannot reach the platform authenticator; set EPOST_BROWSER=chrome';
      return text({
        transport: TRANSPORT === 'auto' ? (apiCredentials() ? 'auto (API preferred)' : 'auto (browser — no API password set)') : TRANSPORT,
        api: apiUnavailable ? `unavailable: ${apiUnavailable}` : (apiCredentials() ? 'configured' : 'no password configured'),
        browser: { key: browserChoice.key, path: browserChoice.path, chosen_because: browserChoice.reason },
        touch_id_passkeys: touchId,
        swissid_user: user ? user.replace(/^(.).*(@.*)$/, '$1***$2') : 'not set — epost_login cannot skip the e-mail step',
        paths: { state: STATE, profile: PROFILE },
        settings: {
          EPOST_BROWSER: 'chrome | chrome-canary | edge | brave | chromium | /absolute/path',
          EPOST_SWISSID_USER: 'account e-mail (or macOS keychain item "epost-mcp-swissid-user")',
          EPOST_STATE: 'cached session file',
          EPOST_PROFILE: 'persistent browser profile',
          EPOST_TRANSPORT: 'auto (default) | api | browser',
          EPOST_API_PASSWORD: 'API password (or keychain item "epost-mcp-api-password")',
          EPOST_DEBUG: '1 to trace the login steps on stderr',
        },
      });
    }

    const p = await getPage();

    if (name === 'epost_list_letters') {
      const viaApi = await apiListLetters(args.limit || 200);
      if (viaApi) return text({ transport: 'api', count: viaApi.length, letters: viaApi.map(apiLetterRow) });
      const st = await ensureSession(p);
      if (st !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      const out = await listLetters(p);
      await saveState();
      return text(out);
    }
    if (name === 'epost_download_letter') {
      const apiLetters = await apiListLetters(200);
      if (apiLetters) {
        const l = args.letter_id ? apiLetters.find(x => x.id === args.letter_id) : apiLetters[args.index];
        if (l) {
          const bytes = await apiLetterContent(l.id);
          if (bytes) {
            mkdirSync(args.output_dir, { recursive: true });
            const stamp = (l.receivedDateTime || '').slice(0, 10) || 'undated';
            const saved = join(args.output_dir, `${stamp}_ePost_${args.index ?? l.id}.pdf`);
            writeFileSync(saved, bytes);
            return text({ transport: 'api', saved, bytes: bytes.length, description: l.description });
          }
        }
      }
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
    if (name === 'epost_store_letter') {
      if (!args.folder) throw new Error('folder is required — the Store sheet will not commit without one');
      // The API archives in one PATCH; the browser needs the two-step folder
      // sheet. Resolve the folder name to its id, and address the letter by id.
      const dirs = await apiListDirectories();
      if (dirs) {
        const want = String(args.folder).normalize('NFC').toLowerCase();
        const dir = dirs.find(d => d.directoryId && (d.directoryName || '').normalize('NFC').toLowerCase() === want);
        if (!dir) {
          return text({ error: `folder "${args.folder}" not found`, available: dirs.filter(d => d.directoryId).map(d => d.directoryName) });
        }
        const letters = await apiListLetters(200);
        if (letters) {
          const l = args.letter_id ? letters.find(x => x.id === args.letter_id)
            : typeof args.index === 'number' ? letters[args.index]
              : args.title ? letters.find(x => JSON.stringify(x).includes(args.title)) : null;
          if (l && await apiArchiveLetter(l.id, dir.directoryId)) {
            await saveState();
            return text({ transport: 'api', stored: l.description || l.letterTitle, folder: dir.directoryName, id: l.id });
          }
        }
      }
      const out = await storeLetter(p, { index: args.index, title: args.title, folder: args.folder });
      await saveState();
      if (out.status !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_list_storage') {
      const dirs = await apiListDirectories();
      if (dirs) {
        return text({
          transport: 'api',
          folders: dirs.filter(d => d.directoryId).map(d => ({ name: d.directoryName, count: d.numberOfDocuments, id: d.directoryId })),
          companyFolders: dirs.filter(d => !d.directoryId).map(d => ({ name: d.directoryName, count: d.numberOfDocuments })),
        });
      }
      const out = await listStorage(p);
      await saveState();
      if (out.status !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_list_storage_documents') {
      const viaApi = await apiListArchive(args.folder_id, args.limit || 1000);
      if (viaApi) {
        const items = Array.isArray(viaApi) ? viaApi : (viaApi.letters || viaApi.content || []);
        return text({ transport: 'api', count: items.length, documents: items.map(apiLetterRow) });
      }
      const out = await listStorageDocuments(p, { scrollAll: args.scroll_all === true });
      await saveState();
      if (out.status !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_read_storage_document') {
      // Over the API a Storage document is just a letter with an id: the listing
      // already carries the description, and the same content endpoint serves
      // the PDF. No card to open, no viewer to drive.
      const arch = await apiListArchive(args.folder_id, 1000);
      if (arch) {
        const items = Array.isArray(arch) ? arch : (arch.letters || arch.content || []);
        const l = args.letter_id ? items.find(x => x.id === args.letter_id)
          : typeof args.index === 'number' ? items[args.index]
            : args.title ? items.find(x => JSON.stringify(x).includes(args.title)) : null;
        if (l) {
          let saved = null;
          if (args.output_dir) {
            const bytes = await apiLetterContent(l.id);
            if (bytes) {
              mkdirSync(args.output_dir, { recursive: true });
              saved = join(args.output_dir, `${(l.receivedDateTime || '').slice(0, 10) || 'undated'}_ePostStorage_${args.index ?? l.id}.pdf`);
              writeFileSync(saved, bytes);
            }
          }
          return text({ transport: 'api', ...apiLetterRow(l, args.index ?? 0), saved });
        }
      }
      const out = await readStorageDocument(p, { index: args.index, title: args.title, outputDir: args.output_dir });
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
    if (name === 'epost_unfile_from_folder') {
      const out = await moveToFolder(p, { index: args.index, title: args.title, folder: args.folder, add: false });
      await saveState();
      if (out.status && out.status !== 'ok') return text({ status: 'login_required', message: 'Run epost_login first (SwissID).' });
      return text(out);
    }
    if (name === 'epost_move_to_folder') {
      const out = await moveToFolder(p, { index: args.index, title: args.title, folder: args.folder, remove: args.remove_from || null });
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
