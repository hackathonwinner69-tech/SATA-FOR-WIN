// Optional Claude advisor (--ai). When the heuristics have no idea where a
// pack of files belongs or what a merchant is, Claude makes the suggestion the
// game highlights. It only ever suggests: the player still makes every move.
// Only each group's id, label and count are sent (plus the total for
// merchants); never file contents, addresses, samples or bodies.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const BATCH = 60;
const CACHE_MAX = 5000;

const TASKS = {
  files: {
    pick: (g) => g.kind === 'unknown',
    question:
      'Each item is a pack of files from a messy Downloads folder. Pick the bin each pack belongs in. Answer "keep" when the files could be important and you cannot tell what they are.',
  },
  expenses: {
    pick: (g) => !g.suggestion,
    item: (g) => ({ id: g.id, label: g.label, count: g.count, total: g.total }),
    question:
      'Each item is a merchant from a bank export, with its transaction count and total (negative is money spent). Pick the spending category. Answer "flag" for transfers to people or anything you cannot identify.',
  },
};

const baseItem = (g) => ({ id: g.id, label: g.label, count: g.count });

export function createAdvisor({ client = new Anthropic({ timeout: 30_000, maxRetries: 1 }), log = console } = {}) {
  // A rescan sees the same groups again; their advice is already paid for.
  const cache = new Map();
  const remember = (key, choice) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, choice);
  };

  async function classify(question, choices, items) {
    const schema = {
      type: 'object',
      properties: {
        answers: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, choice: { type: 'string', enum: choices } },
            required: ['id', 'choice'],
            additionalProperties: false,
          },
        },
      },
      required: ['answers'],
      additionalProperties: false,
    };
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Refusals reroute to a fallback model chosen by the API instead of failing the scan.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: `${question}\n\nItems:\n${JSON.stringify(items, null, 1)}` }],
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.find((b) => b.type === 'text')?.text;
    return text ? JSON.parse(text).answers : null;
  }

  return {
    /** Fill in suggestions the chore's own rules could not make. Mutates the groups. */
    async advise(chore, groups) {
      const task = TASKS[chore.id];
      if (!task) return 0;
      const choices = chore.actions.map((a) => a.id);
      const keyOf = (g) => JSON.stringify([chore.id, choices, g.id, g.label]);
      let advised = 0;
      const suggest = (group, choice) => {
        group.suggestion = choice;
        group.aiSuggested = true;
        advised++;
      };
      const open = [];
      for (const group of groups.filter(task.pick)) {
        const key = keyOf(group);
        if (!cache.has(key)) open.push(group);
        else if (cache.get(key)) suggest(group, cache.get(key));
      }
      const item = task.item ?? baseItem;
      for (let i = 0; i < open.length; i += BATCH) {
        const batch = open.slice(i, i + BATCH);
        try {
          const answers = await classify(task.question, choices, batch.map(item));
          if (!answers) continue;
          const byId = new Map(answers.map((a) => [a.id, a.choice]));
          for (const group of batch) {
            const choice = choices.includes(byId.get(group.id)) ? byId.get(group.id) : null;
            // No answer is remembered too: asking again about the same group would get the same shrug.
            remember(keyOf(group), choice);
            if (choice) suggest(group, choice);
          }
        } catch (err) {
          // The game works without advice; say why once and carry on.
          log.warn(`Claude advisor skipped (${err.status ?? ''} ${err.message})`);
          return advised;
        }
      }
      return advised;
    },
  };
}
