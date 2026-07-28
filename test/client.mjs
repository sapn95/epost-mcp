// Minimal MCP client over stdio, so tests drive the server exactly as a real
// client would rather than importing its internals.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

export async function startServer(env = {}, { timeout = 15000 } = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Never let a test reach the real service or a real browser.
      EPOST_SWISSID_USER: 'test@example.invalid',
      EPOST_API_PASSWORD: 'test-password',
      EPOST_STATE: '/dev/null',
      ...env,
    },
  });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  const pending = new Map();
  let id = 1;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    line = line.trim();
    if (!line) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const i = id++;
    pending.set(i, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
    // unref: a pending timeout must not hold the test runner's event loop open
    setTimeout(() => reject(new Error(`${method} timed out after ${timeout}ms`)), timeout).unref();
  });

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    init,
    stderr: () => stderr,
    async tools() { return (await rpc('tools/list')).result.tools; },
    async call(name, args = {}) {
      const r = await rpc('tools/call', { name, arguments: args });
      const t = (r.result?.content || []).map(c => c.text).join('\n');
      let parsed;
      try { parsed = JSON.parse(t); } catch { parsed = t; }
      return { raw: t, isError: !!r.result?.isError, ...(typeof parsed === 'object' && parsed !== null ? { data: parsed } : { data: {} }), parsed };
    },
    stop() { child.stdin.end(); child.kill(); },
  };
}
