import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdvisor } from '../src/ai/advisor.js';

function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        async create(params) {
          calls.push(params);
          return typeof reply === 'function' ? reply(params) : reply;
        },
      },
    },
  };
}

const chore = { id: 'expenses', actions: [{ id: 'cat:Food' }, { id: 'cat:Bills' }, { id: 'flag' }] };

test('advisor fills only the suggestions the rules could not make', async () => {
  const client = fakeClient({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'merchant:NOODLE BAR', choice: 'cat:Food' }] }) }],
  });
  const groups = [
    { id: 'merchant:NOODLE BAR', label: 'NOODLE BAR', suggestion: null },
    { id: 'merchant:PG&E', label: 'PG&E', suggestion: 'cat:Bills' },
  ];
  const n = await createAdvisor({ client }).advise(chore, groups);
  assert.equal(n, 1);
  assert.equal(groups[0].suggestion, 'cat:Food');
  assert.equal(groups[0].aiSuggested, true);
  assert.equal(groups[1].aiSuggested, undefined);

  const [params] = client.calls;
  assert.match(params.messages[0].content, /NOODLE BAR/);
  assert.doesNotMatch(params.messages[0].content, /PG&E/, 'already-known merchants are not sent');
  assert.deepEqual(params.output_config.format.schema.properties.answers.items.properties.choice.enum, ['cat:Food', 'cat:Bills', 'flag']);
});

test('advisor ignores refusals, unknown ids and API errors', async () => {
  const groups = () => [{ id: 'merchant:X', label: 'X', suggestion: null }];
  const refused = groups();
  await createAdvisor({ client: fakeClient({ stop_reason: 'refusal', content: [] }) }).advise(chore, refused);
  assert.equal(refused[0].suggestion, null);

  const bogus = groups();
  const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"answers":[{"id":"merchant:Y","choice":"cat:Food"}]}' }] });
  assert.equal(await createAdvisor({ client }).advise(chore, bogus), 0);

  const failing = fakeClient(() => {
    throw Object.assign(new Error('overloaded'), { status: 529 });
  });
  const warnings = [];
  assert.equal(await createAdvisor({ client: failing, log: { warn: (m) => warnings.push(m) } }).advise(chore, groups()), 0);
  assert.match(warnings[0], /529 overloaded/);
});
