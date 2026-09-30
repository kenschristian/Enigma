import test from 'node:test';
import assert from 'node:assert/strict';
import { doctor } from '../src/main.mjs';

const sol = { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] };

function fixture(models, accountType = 'chatgpt') {
  const events = [], logs = [];
  class Client {
    async start() { events.push('start'); }
    async account() { events.push('account'); return { account: { type: accountType } }; }
    async models() { events.push('models'); return models; }
    async close() { events.push('close'); }
  }
  return { events, logs, run: () => doctor(undefined, { Client, log: line => logs.push(line) }) };
}

test('doctor accepts exact Sol Medium without requiring High or Ultra', async () => {
  const f = fixture([sol]); await f.run();
  assert.deepEqual(f.events, ['start', 'account', 'models', 'close']);
  assert.ok(f.logs.includes('PASS: GPT-6.1 Sol supports Medium for Atlas and specialists.'));
});

test('doctor rejects unavailable Sol or Medium without fallback and always closes', async t => {
  const cases = [
    ['missing Sol', [{ model: 'gpt-6-astra', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], /Sol is unavailable/],
    ['ID alias cannot hide another model', [{ ...sol, model: 'gpt-6-astra' }], /Sol is unavailable/],
    ['missing Medium', [{ ...sol, supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }] }], /Sol Medium/],
    ['missing efforts', [{ ...sol, supportedReasoningEfforts: undefined }], /Sol Medium/],
    ['malformed efforts', [{ ...sol, supportedReasoningEfforts: 'medium' }], /Sol Medium/],
    ['unsupported effort format', [{ ...sol, supportedReasoningEfforts: ['medium'] }], /Sol Medium/],
  ];
  for (const [name, models, message] of cases) {
    await t.test(name, async () => {
      const f = fixture(models); await assert.rejects(f.run(), message);
      assert.equal(f.events.at(-1), 'close');
      assert.ok(!f.logs.some(line => line.includes('supports Medium')));
    });
  }
});

test('doctor rejects API-key authentication before checking models', async () => {
  const f = fixture([sol], 'apiKey');
  await assert.rejects(f.run(), /existing ChatGPT account/);
  assert.deepEqual(f.events, ['start', 'account', 'close']);
});
