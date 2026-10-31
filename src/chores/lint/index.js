// Lint fixing. Every rule a project breaks is a monster whose HP is how often
// it is broken. Slaying it runs ESLint's own autofix for that one rule;
// rules ESLint cannot fix can be silenced with a marked comment or logged in
// a quest log. Every file touched is snapshotted for undo.
import { createHash } from 'node:crypto';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exists } from '../../core/fsx.js';
import { within } from '../../core/safety.js';

const CONFIG_FILES = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];
export const QUEST_LOG = 'LINT_QUESTLOG.md';

export const LINT_ACTIONS = [
  { id: 'fix', label: 'Autofix', key: 'F', color: '#22c55e' },
  { id: 'disable', label: 'Silence with a marked comment', key: 'S', color: '#facc15' },
  { id: 'log', label: 'Add to quest log', key: 'L', color: '#38bdf8' },
  { id: 'skip', label: 'Skip', key: 'X', color: '#64748b' },
];

const sha = (s) => createHash('sha1').update(s).digest('hex');

/** Prefer the project's own ESLint so its plugins and config load; fall back to ours. */
async function loadEslint(root) {
  try {
    const found = createRequire(join(root, 'package.json')).resolve('eslint');
    if (!found.startsWith(root)) throw new Error('resolved outside the project');
    return { mod: await import(pathToFileURL(found).href), own: true };
  } catch {
    return { mod: await import('eslint'), own: false };
  }
}

async function defaultConfig() {
  const js = (await import('@eslint/js')).default;
  const globals = (await import('globals')).default;
  return [
    { ignores: ['**/node_modules/', '**/dist/', '**/build/', '**/coverage/', '**/.chorecade-trash/'] },
    js.configs.recommended,
    {
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, ...globals.node } },
      rules: {
        'prefer-const': 'warn',
        'no-var': 'warn',
        'object-shorthand': 'warn',
        'prefer-template': 'warn',
        'no-else-return': 'warn',
        'dot-notation': 'warn',
        curly: 'warn',
        eqeqeq: 'warn',
        yoda: 'warn',
        'prefer-arrow-callback': 'warn',
        'no-useless-rename': 'warn',
      },
    },
  ];
}

export function createLintChore({ root, dryRun = false }) {
  root = resolve(root);
  let engine = null;

  async function eslint(extra = {}) {
    if (!engine) {
      const { mod, own } = await loadEslint(root);
      let hasConfig = false;
      for (const f of CONFIG_FILES) if (await exists(join(root, f))) hasConfig = true;
      engine = {
        ESLint: mod.ESLint ?? mod.default?.ESLint,
        base: hasConfig ? { cwd: root } : { cwd: root, overrideConfigFile: true, overrideConfig: await defaultConfig() },
        source: `${own ? "project's" : 'bundled'} ESLint, ${hasConfig ? 'project config' : 'ChoreCade default config'}`,
      };
    }
    return new engine.ESLint({ ...engine.base, ...extra });
  }

  async function snapshot(files) {
    const before = {};
    for (const f of files) before[f] = await readFile(f, 'utf8');
    return before;
  }

  async function changesSince(before) {
    const changes = [];
    for (const [file, text] of Object.entries(before)) {
      const now = await readFile(file, 'utf8');
      if (now !== text) changes.push({ file, before: text, afterHash: sha(now) });
    }
    return changes;
  }

  return {
    id: 'lint',
    title: 'Lint Dungeon',
    chore: 'Fix lint errors',
    game: 'dungeon',
    unit: 'lint problems',
    target: root,
    actions: LINT_ACTIONS,

    async scan() {
      const results = await (await eslint()).lintFiles(['.']);
      const rules = new Map();
      for (const r of results) {
        for (const m of r.messages) {
          const id = m.ruleId ?? 'parse-error';
          if (!rules.has(id)) rules.set(id, { messages: [], files: new Set(), fixable: 0, errors: 0 });
          const g = rules.get(id);
          g.messages.push({ file: relative(root, r.filePath), line: m.line, column: m.column, message: m.message });
          g.files.add(r.filePath);
          if (m.fix) g.fixable++;
          if (m.severity === 2) g.errors++;
        }
      }
      const groups = [...rules].map(([rule, g]) => ({
        id: `rule:${rule}`,
        label: rule,
        detail: g.messages[0].message,
        count: g.messages.length,
        fixable: g.fixable,
        errors: g.errors,
        kind: g.fixable ? 'fixable' : 'manual',
        suggestion: g.fixable === g.messages.length ? 'fix' : rule === 'parse-error' ? 'log' : g.fixable ? 'fix' : 'log',
        risk: rule === 'parse-error' ? 'high' : g.fixable ? 'low' : 'medium',
        samples: g.messages.slice(0, 5),
        files: [...g.files],
        rule,
      }));
      groups.sort((a, b) => b.count - a.count);
      return {
        groups,
        stats: {
          problems: groups.reduce((s, g) => s + g.count, 0),
          remaining: groups.reduce((s, g) => s + g.count, 0),
          fixable: groups.reduce((s, g) => s + g.fixable, 0),
          files: results.length,
          engine: engine.source,
        },
      };
    },

    async apply(group, action) {
      if (action === 'skip') return { affected: 0, summary: `skipped ${group.rule}`, impact: {}, undo: null };
      const files = group.files.map((f) => within(root, f));
      if (dryRun) return { affected: group.count, summary: `[dry run] would ${action} ${group.rule}`, impact: {}, undo: null };

      if (action === 'log') {
        const path = within(root, QUEST_LOG);
        const before = (await exists(path)) ? await readFile(path, 'utf8') : null;
        const lines = [`\n## ${group.rule} (${group.count})\n`, ...group.samples.map((s) => `- [ ] ${s.file}:${s.line} ${s.message}`)];
        if (group.count > group.samples.length) lines.push(`- ...and ${group.count - group.samples.length} more`);
        await appendFile(path, (before === null ? '# Lint quest log\n' : '') + lines.join('\n') + '\n');
        const after = await readFile(path, 'utf8');
        return {
          affected: group.count,
          summary: `logged ${group.rule} in ${QUEST_LOG}`,
          impact: { logged: group.count },
          undo: { changes: [{ file: path, before, afterHash: sha(after) }] },
        };
      }

      const before = await snapshot(files);
      let touched = 0;
      if (action === 'fix') {
        const linter = await eslint({ fix: (m) => m.ruleId === group.rule });
        const results = await linter.lintFiles(files);
        await engine.ESLint.outputFixes(results);
        touched = results.filter((r) => r.output !== undefined).length;
      } else if (action === 'disable') {
        // Lint again so line numbers reflect any fixes made since the scan.
        const results = await (await eslint()).lintFiles(files);
        for (const r of results) {
          const lines = [...new Set(r.messages.filter((m) => m.ruleId === group.rule).map((m) => m.line))].sort((a, b) => b - a);
          if (!lines.length) continue;
          const text = await readFile(r.filePath, 'utf8');
          const eol = text.includes('\r\n') ? '\r\n' : '\n';
          const src = text.split(/\r?\n/);
          for (const line of lines) {
            const indent = src[line - 1]?.match(/^\s*/)[0] ?? '';
            src.splice(line - 1, 0, `${indent}// eslint-disable-next-line ${group.rule} -- TODO(chorecade): fix properly`);
          }
          await writeFile(r.filePath, src.join(eol));
          touched++;
        }
      } else {
        throw new Error(`unknown lint action ${action}`);
      }
      const changes = await changesSince(before);
      const verb = action === 'fix' ? 'fixed' : 'silenced';
      return {
        affected: action === 'fix' ? group.fixable : group.count,
        summary: `${verb} ${group.rule} in ${touched} file${touched === 1 ? '' : 's'}`,
        impact: { [verb]: action === 'fix' ? group.fixable : group.count, files: touched },
        undo: { changes },
      };
    },

    /** Restore snapshots, but never over a file that has been edited since. */
    async undo({ changes }) {
      // Check everything first so a refused undo changes nothing at all.
      const conflicts = [];
      for (const { file, afterHash } of changes) {
        const path = within(root, file);
        const now = (await exists(path)) ? await readFile(path, 'utf8') : null;
        if (now === null || sha(now) !== afterHash) conflicts.push(relative(root, path));
      }
      if (conflicts.length) {
        throw new Error(`changed since, left alone: ${conflicts.join(', ')} (undo later moves first)`);
      }
      for (const { file, before } of changes) {
        const path = within(root, file);
        if (before === null) await rm(path);
        else await writeFile(path, before);
      }
      return { restored: changes.length, summary: `restored ${changes.length} files` };
    },
  };
}
