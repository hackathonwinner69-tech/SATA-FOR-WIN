// Optional Claude advisor (--ai). When the heuristics have no idea where a
// pack of files belongs or what a merchant is, Claude makes the suggestion the
// game highlights. It only ever suggests: the player still makes every move.
// Only labels, names and short samples are sent; never file contents or bodies.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const BATCH = 60;

const TASKS = {
  files: {
    pick: (g) => g.kind === 'unknown',
    question:
      'Each item is a pack of files from a messy Downloads folder. Pick the bin each pack belongs in. Answer "keep" when the files could be important and you cannot tell what they are.',
  },
  expenses: {
    pick: (g) => !g.suggestion,
    question:
      'Each item is a merchant from a bank export, with its transaction count and total (negative is money spent). Pick the spending category. Answer "flag" for transfers to people or anything you cannot identify.',
  },
};

export function createAdvisor({ client = new Anthropic(), log = console } = {}) {
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
    if (response.stop_reason === 'refusal') return [];
    const text = response.content.find((b) => b.type === 'text')?.text;
    return text ? JSON.parse(text).answers : [];
  }

  return {
    /** Fill in suggestions the chore's own rules could not make. Mutates the groups. */
    async advise(chore, groups) {
      const task = TASKS[chore.id];
      if (!task) return 0;
      const open = groups.filter(task.pick);
      if (!open.length) return 0;
      const choices = chore.actions.map((a) => a.id);
      let advised = 0;
      for (let i = 0; i < open.length; i += BATCH) {
        const batch = open.slice(i, i + BATCH);
        const items = batch.map((g) => ({ id: g.id, label: g.label, detail: g.detail, count: g.count, total: g.total }));
        try {
          for (const { id, choice } of await classify(task.question, choices, items)) {
            const group = batch.find((g) => g.id === id);
            if (!group || !choices.includes(choice)) continue;
            group.suggestion = choice;
            group.aiSuggested = true;
            advised++;
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
