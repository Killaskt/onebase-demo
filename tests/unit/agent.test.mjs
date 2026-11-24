// agent.js with fetch mocked: key cleaning, request shape, reply parsing, error mapping.
// No network: every test replaces globalThis.fetch.
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { getKey, setKey, askModel } from '../../js/agent.js';

const KEY_STORE = 'onebase.apiKey';
const FAKE = 'sk-ant-test-0000';
const realFetch = globalThis.fetch;
let calls;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const textReply = (text, extra = {}) => json({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text }], ...extra });
function mockFetch(...responses) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses[Math.min(calls.length, responses.length) - 1];
    return typeof r === 'function' ? r(url, init) : r.clone();
  };
}
const ask = (text = 'Track my car mileage for work trips', extra = {}) =>
  askModel({ chat: [{ role: 'user', text }], schema: [{ table: 'games', columns: [{ name: 'score', kind: 'number' }] }], ...extra });

const SPEC = {
  name: 'Mileage', needs: [{ slot: 'trips', access: 'write', columns: [{ key: 'date', kind: 'date' }, { key: 'miles', kind: 'number' }] }],
  blocks: [{ type: 'form', slot: 'trips', fields: [{ col: 'miles' }] }],
};
const fenced = (spec, pre = 'Here you go.') => `${pre}\n\`\`\`json\n${JSON.stringify(spec)}\n\`\`\``;

beforeEach(() => { calls = []; localStorage.clear(); setKey(FAKE); });
afterEach(() => { globalThis.fetch = realFetch; });

describe('API key cleaning', () => {
  test('setKey strips spaces, line breaks and invisible characters', () => {
    setKey('  sk-ant-\u200Babc\u200C\u200D\u2060\uFEFF-1\u00A02\n\t ');
    assert.equal(localStorage.getItem(KEY_STORE), 'sk-ant-abc-12');
    assert.equal(getKey(), 'sk-ant-abc-12');
  });
  test('getKey cleans a dirty key saved by an older version', () => {
    localStorage.setItem(KEY_STORE, '\u200Bsk-ant-old \n');
    assert.equal(getKey(), 'sk-ant-old');
  });
  test('an empty or whitespace-only key removes the stored key', () => {
    setKey(' \u200B ');
    assert.equal(localStorage.getItem(KEY_STORE), null);
    assert.equal(getKey(), '');
  });
  test('a key with non-Latin-1 characters is rejected before any request', async () => {
    localStorage.setItem(KEY_STORE, 'sk-ant-abc\u2014def'); // em dash from a copy/paste
    mockFetch(textReply('unused'));
    await assert.rejects(ask(), /characters that can't be sent/);
    assert.equal(calls.length, 0);
  });
  test('a key with other non-ASCII characters is rejected too', async () => {
    localStorage.setItem(KEY_STORE, 'sk-ant-é');
    mockFetch(textReply('unused'));
    await assert.rejects(ask(), /characters that can't be sent/);
    assert.equal(calls.length, 0);
  });
});

describe('request shape', () => {
  test('posts to the Messages API with browser-access headers and only schema plus chat', async () => {
    mockFetch(textReply('Sure.'));
    await askModel({
      chat: [{ role: 'agent', text: 'greeting' }, { role: 'user', text: 'first' }, { role: 'user', text: 'second' }],
      schema: [{ table: 'games', columns: [{ name: 'score', kind: 'number' }] }],
      currentSpec: SPEC,
    });
    assert.equal(calls.length, 1);
    const { url, init, body } = calls[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-api-key'], FAKE);
    assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.ok(init.headers['anthropic-version']);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.equal(body.messages.length, 1, 'leading agent turn dropped, consecutive user turns merged');
    assert.equal(body.messages[0].role, 'user');
    assert.match(body.messages[0].content, /"table":"games"/);
    assert.match(body.messages[0].content, /current spec/);
    assert.match(body.messages[0].content, /first\n\nsecond$/);
  });
});

describe('response parsing', () => {
  test('a question-only answer returns the text and no spec', async () => {
    mockFetch(textReply('You have one table.'));
    assert.deepEqual(await ask('What tables do I have?'), { reply: 'You have one table.', spec: null });
  });
  test('a fenced JSON spec is extracted and the fence removed from the reply', async () => {
    mockFetch(textReply(fenced(SPEC, 'Built Mileage.')));
    const out = await ask();
    assert.equal(out.reply, 'Built Mileage.');
    assert.deepEqual(out.spec, SPEC);
    assert.equal(calls.length, 1);
  });
  test('a spec with no prose gets a default reply', async () => {
    mockFetch(textReply(fenced(SPEC, '')));
    assert.equal((await ask()).reply, 'Here is Mileage.');
  });
  test('an invalid spec gets one repair attempt that shows the validator errors', async () => {
    const bad = { ...SPEC, blocks: [{ type: 'map', slot: 'trips' }] };
    mockFetch(textReply(fenced(bad)), textReply(fenced(SPEC, 'Fixed.')));
    const out = await ask();
    assert.equal(calls.length, 2);
    const last = calls[1].body.messages.at(-1);
    assert.equal(last.role, 'user');
    assert.match(last.content, /rejected by the validator/);
    assert.match(last.content, /type must be one of/);
    assert.deepEqual(out, { reply: 'Fixed.', spec: SPEC });
  });
  test('broken JSON twice gives up with a readable message and no spec', async () => {
    mockFetch(textReply('Oops\n```json\n{not json\n```'));
    const out = await ask();
    assert.equal(calls.length, 2);
    assert.equal(out.spec, null);
    assert.match(out.reply, /couldn't produce a valid interface for that \(The JSON did not parse/);
  });
  test('a refusal is reported', async () => {
    mockFetch(json({ stop_reason: 'refusal', content: [] }));
    await assert.rejects(ask(), /The model declined that request\./);
  });
  test('a 200 that is not JSON is reported', async () => {
    mockFetch(new Response('<html>proxy</html>', { status: 200 }));
    await assert.rejects(ask(), /Claude sent a reply OneBase couldn't read\. Try again\./);
  });
});

describe('error mapping', () => {
  test('401 says the key was rejected and includes the API detail', async () => {
    mockFetch(json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));
    await assert.rejects(ask(), { message: 'Claude rejected the API key (401: invalid x-api-key). Check it in the key settings.' });
  });
  test('401 without a body still maps', async () => {
    mockFetch(new Response('', { status: 401 }));
    await assert.rejects(ask(), { message: 'Claude rejected the API key (401). Check it in the key settings.' });
  });
  test('429 is rate limited', async () => {
    mockFetch(json({ error: { message: 'slow down' } }, 429));
    await assert.rejects(ask(), /^Error: Rate limited\. Wait a moment and try again\.$/);
  });
  for (const status of [400, 404, 500, 529]) {
    test(`${status} shows the status and detail`, async () => {
      mockFetch(json({ error: { message: `detail ${status}` } }, status));
      await assert.rejects(ask(), { message: `Claude returned an error (${status}). detail ${status}` });
    });
  }
  test('a network TypeError says Claude could not be reached', async () => {
    mockFetch(() => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(ask(), (e) => e.message.startsWith("Couldn't reach Claude: Failed to fetch. Check your connection"));
  });
  test('a header TypeError points at the key', async () => {
    mockFetch(() => { throw new TypeError("Failed to execute 'fetch': String contains non ISO-8859-1 code point."); });
    await assert.rejects(ask(), /Couldn't reach Claude: .*ISO-8859-1.*Remove it in the key settings and paste it again\./);
  });
  test('a body that fails mid-read counts as a network failure', async () => {
    mockFetch(() => ({ ok: true, status: 200, text: () => Promise.reject(new TypeError('network error')) }));
    await assert.rejects(ask(), /^Error: Couldn't reach Claude: network error\./);
  });
  test('no answer after 2 minutes times out and aborts the request', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    mockFetch((url, init) => new Promise((resolve, reject) => {
      signal = init.signal;
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const p = ask();
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(119999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await assert.rejects(p, { message: "Couldn't reach Claude: no answer after 2 minutes. Check your connection and try again." });
    assert.equal(signal.aborted, true);
  });
});
