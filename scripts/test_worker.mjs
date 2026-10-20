import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const source = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const entries = new Map();
globalThis.caches = {
  default: {
    async match(key) { return entries.get(key.url)?.clone(); },
    async put(key, response) { entries.set(key.url, response.clone()); }
  }
};

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (String(url).startsWith('http://ip-api.com/')) {
    return Response.json({ status: 'success', query: '1.1.1.1' });
  }
  if (String(url).includes('?name=')) {
    return Response.json({ Status: 0, Answer: [{ name: 'example.com', type: 1, TTL: 120, data: '1.1.1.1' }] });
  }
  return new Response('dns-message', { headers: { 'content-type': 'application/dns-message' } });
};

const request = (path, init) => worker.fetch(new Request(`https://example.net${path}`, init), {});
const query = '/?doh=https%3A%2F%2Fdns.google%2Fresolve&domain=example.com&type=A';
assert.equal((await request('/?doh=http%3A%2F%2Fexample.org&domain=example.com')).status, 400);
assert.equal((await request(query)).status, 200);
assert.equal(calls.length, 1);
assert.equal(entries.size, 1);
assert.equal((await request(query)).status, 200);
assert.equal(calls.length, 1, 'second query should hit cache');

assert.equal((await request('/dns-query?name=example.com&type=A')).status, 200);
assert.equal(calls.length, 2, 'JSON DoH should use one upstream request');
assert.equal((await request('/dns-query?dns=AA')).headers.get('content-type'), 'application/dns-message');
assert.equal((await request('/dns-query', { method: 'POST', body: 'query' })).status, 200);

const configured = { DOH: 'https://dns.google/', PATH: 'private', TOKEN: 'different' };
const page = await (await worker.fetch(new Request('https://example.net/'), configured)).text();
assert.match(page, /custom-fix-20261020-personal-fix/);
assert.doesNotMatch(page, /const ipInfoToken = .*different/);
assert.match(page, /const ipInfoToken = .*get\('token'\) \|\| ""/);
assert.match(page, /const currentDohPath = 'private'/);
new Script(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
const escapeHtml = new Script(`(${page.match(/function escapeHtml\(value\) \{[\s\S]*?\n    \}/)[0]})`).runInNewContext();
assert.equal(escapeHtml('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
assert.equal((await worker.fetch(new Request('https://example.net/private?dns=AA'), configured)).status, 200);
assert.equal((await worker.fetch(new Request('https://example.net/ip-info?ip=1.1.1.1&token=different'), configured)).status, 200);
assert.equal((await worker.fetch(new Request('https://example.net/ip-info?ip=1.1.1.1&token=private'), configured)).status, 403);
const tokenPathPage = await (await worker.fetch(new Request('https://example.net/'), { TOKEN: 'personal' })).text();
assert.match(tokenPathPage, /const currentDohPath = 'personal'/);
assert.match(tokenPathPage, /get\('token'\) \|\| "personal"/);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).includes('/dns-query?name=')) return new Response('unsupported', { status: 400 });
  return originalFetch(url, options);
};
assert.equal((await request('/dns-query?name=example.com&type=A')).status, 200);
assert.ok(calls.at(-1).url.includes('/resolve?'), 'failed primary should fall back once');

console.log('Worker routes, cache, configuration and page script: OK');
