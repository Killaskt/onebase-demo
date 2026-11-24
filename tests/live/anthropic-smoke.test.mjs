// Opt-in live smoke test: ONE real call to the Anthropic API through askModel().
// Skipped unless ANTHROPIC_API_KEY is set. Never run it in CI or in a loop.
// Hard limits (do not raise): at most 1 request, max_tokens capped at 150, effort low.
// The key is never printed; only token usage is reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setKey, askModel } from '../../js/agent.js';

const MAX_CALLS = 1;
const MAX_TOKENS = 150;
const KEY = process.env.ANTHROPIC_API_KEY;

test('live: one tiny call to Claude succeeds', { skip: !KEY && 'ANTHROPIC_API_KEY not set', timeout: 130_000 }, async (t) => {
  assert.ok(!process.env.CI, 'the live test must not run in CI');
  const realFetch = globalThis.fetch;
  let calls = 0;
  let usage = null;
  let status = null;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    if (calls > MAX_CALLS) throw new Error(`live test call cap (${MAX_CALLS}) reached; refusing another request`);
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(init.body);
    body.max_tokens = Math.min(body.max_tokens, MAX_TOKENS);
    body.output_config = { ...(body.output_config || {}), effort: 'low' };
    const res = await realFetch(url, { ...init, body: JSON.stringify(body) });
    status = res.status;
    try { usage = (await res.clone().json()).usage || null; } catch { /* not JSON */ }
    return res;
  };
  try {
    setKey(KEY);
    const out = await askModel({ chat: [{ role: 'user', text: 'Reply with just the word OK. Do not send any JSON.' }], schema: [] });
    t.diagnostic(`HTTP ${status}; reply: ${JSON.stringify(out.reply.slice(0, 60))}`);
    t.diagnostic(`usage: input_tokens=${usage?.input_tokens ?? '?'} output_tokens=${usage?.output_tokens ?? '?'}`);
    assert.equal(status, 200);
    assert.equal(typeof out.reply, 'string');
    assert.equal(out.spec, null);
  } finally {
    globalThis.fetch = realFetch;
    setKey('');
  }
  assert.equal(calls, 1);
});
