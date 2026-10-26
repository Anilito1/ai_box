import { isAccountRef } from './accounts';
import type { Lang } from './i18n';
import { EFFORTS, type Effort, type Metrics, type Mode, type TeamRole } from './types';

// The team of permanent workers: checks, templates, and the rules that pick a mission's model and effort.
// No Node and no DOM: the settings screen checks a post with the same rules as the main process.

export const TEAM_MAX = 12;
export const FOLDERS_MAX = 5;
export const ROLE_LIMITS = { name: 24, description: 400, instructions: 8000 } as const;
/** Modes a post may run in; "Allow everything" only once the user confirms it in the settings. */
export const ROLE_MODES: Mode[] = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];
/** Models the settings offer for the master's choice, strongest first. */
export const AUTO_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
/** Never a leading dash: the name goes on Claude Code's command line. */
const MODEL = /^\w[\w.:[\]-]{0,79}$/;
const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;
/** The master's session is "hub-maitre" or "hub-master"; "hub" and "worker" would read as the hub itself. */
const RESERVED = new Set(['master', 'maitre', 'hub', 'worker']);

/** Lowercase ASCII slug: "Front end (React)" → "front-end-react". */
export function slugify(raw: string, max: number): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^hub-/, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

export const sessionNameOf = (role: Pick<TeamRole, 'name'>) => `hub-${role.name}`;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A post as the user or the master typed it, trimmed, with its name as a slug. Wrong types become empty values. */
export function normalizeRole(raw: unknown): TeamRole {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: str(o.id),
    name: slugify(str(o.name), ROLE_LIMITS.name),
    description: str(o.description).trim(),
    instructions: str(o.instructions).trim(),
    folders: Array.isArray(o.folders) ? o.folders.map(str).map((f) => f.trim()).filter(Boolean) : [],
    model: str(o.model).trim(),
    effort: EFFORTS.includes(o.effort as Effort) ? (o.effort as Effort) : '',
    mode: ROLE_MODES.includes(o.mode as Mode) ? (o.mode as Mode) : '',
    account: str(o.account).trim(),
    enabled: o.enabled !== false,
  };
}

export type RoleField = 'name' | 'description' | 'instructions' | 'folders' | 'model' | 'account' | 'enabled' | 'team';
/** `locked`: the master may not move a post that has a permission mode of its own. */
export type RoleProblem = 'required' | 'tooLong' | 'format' | 'reserved' | 'taken' | 'tooMany' | 'duplicate' | 'locked';
export interface RoleError {
  field: RoleField;
  problem: RoleProblem;
}

/** First problem of a normalized post among the others of the team, or null. Folders' existence is the main process's. */
export function checkRole(role: TeamRole, others: TeamRole[]): RoleError | null {
  const fail = (field: RoleField, problem: RoleProblem): RoleError => ({ field, problem });
  const rest = others.filter((o) => o.id !== role.id || !role.id);
  if (!role.id && rest.length >= TEAM_MAX) return fail('team', 'tooMany');
  if (!role.name) return fail('name', 'required');
  if (RESERVED.has(role.name)) return fail('name', 'reserved');
  if (rest.some((o) => o.name === role.name)) return fail('name', 'taken');
  if (!role.description) return fail('description', 'required');
  if (role.description.length > ROLE_LIMITS.description) return fail('description', 'tooLong');
  if (role.instructions.length > ROLE_LIMITS.instructions) return fail('instructions', 'tooLong');
  if (role.folders.length === 0) return fail('folders', 'required');
  if (role.folders.length > FOLDERS_MAX) return fail('folders', 'tooMany');
  if (role.folders.some((f) => !ABSOLUTE.test(f) || f.length > 1000 || f.includes('\0'))) return fail('folders', 'format');
  if (new Set(role.folders.map((f) => f.replace(/[\\/]+$/, '').toLowerCase())).size < role.folders.length) return fail('folders', 'duplicate');
  if (role.model && !MODEL.test(role.model)) return fail('model', 'format');
  if (role.account && !isAccountRef(role.account)) return fail('account', 'format');
  return null;
}

/** What the worker itself is told about its post: a change reaches it with its next message. */
export const roleKey = (r: TeamRole) => JSON.stringify([r.name, r.description, r.instructions, r.folders]);

// ---------- templates ----------

export const TEMPLATE_IDS = ['backend', 'frontend', 'qa', 'devops', 'docs'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
type Template = { description: string; instructions: string };

const TEMPLATES: Record<Lang, Record<TemplateId, Template>> = {
  en: {
    backend: {
      description: 'APIs, server logic, database schema and migrations, serverless or edge functions, background jobs.',
      instructions: [
        '- Keep API contracts backward compatible unless the mission says otherwise; before changing one, tell the master and the workers that use it.',
        '- Migrations: idempotent, reversible when possible, never destructive without an explicit go-ahead.',
        '- Validate inputs at the boundaries, parameterized SQL only, secrets from the environment only.',
        '- Every behaviour change comes with a test; run the tests before you report.',
      ].join('\n'),
    },
    frontend: {
      description: 'User interface: components, pages, styling, accessibility, client state, front-end build.',
      instructions: [
        '- Use the existing design system and components; no new UI library without the master’s agreement.',
        '- Accessibility: everything reachable with the keyboard, labelled controls, visible focus, text contrast of at least 4.5:1.',
        '- Never render external data as HTML without sanitizing it.',
        '- When the repo can run the app, look at the result (screenshot) and say what you checked.',
      ].join('\n'),
    },
    qa: {
      description: 'Reviews diffs, writes and runs tests, reproduces bugs, checks a delivery before it ships. Does not build features.',
      instructions: [
        '- Review, reproduce and test; only change test files unless the mission asks for a fix.',
        '- Report findings ranked by severity, each with file:line and a concrete failing scenario.',
        '- Never approve without running the build and the tests; say plainly what you could not verify.',
      ].join('\n'),
    },
    devops: {
      description: 'CI/CD, deployments, infrastructure, environment configuration, releases, monitoring.',
      instructions: [
        '- Never print or commit a secret: use the platform’s secret store.',
        '- Dry run or preview first; deploy to production only when the mission says so, once build and tests pass.',
        '- Keep every change reversible and say how to roll it back. Report each deployed version or URL.',
      ].join('\n'),
    },
    docs: {
      description: 'README, guides, changelogs, API docs and code comments, kept in step with the code.',
      instructions: [
        '- Short sentences, concrete examples, commands that work as written: check each command and path against the repo.',
        '- Keep the existing tone and structure; no marketing language.',
      ].join('\n'),
    },
  },
  fr: {
    backend: {
      description: 'API, logique serveur, schéma et migrations de base de données, fonctions serverless ou edge, tâches de fond.',
      instructions: [
        "- Garde les contrats d'API rétrocompatibles sauf si la mission dit autre chose ; avant d'en changer un, préviens le maître et les workers qui l'utilisent.",
        '- Migrations : idempotentes, réversibles si possible, jamais destructives sans feu vert explicite.',
        '- Valide les entrées aux frontières, SQL paramétré uniquement, secrets seulement depuis l’environnement.',
        '- Tout changement de comportement s’accompagne d’un test ; lance les tests avant ton rapport.',
      ].join('\n'),
    },
    frontend: {
      description: 'Interface : composants, pages, style, accessibilité, état côté client, build du front.',
      instructions: [
        '- Utilise le design system et les composants existants ; aucune nouvelle librairie UI sans l’accord du maître.',
        '- Accessibilité : tout au clavier, contrôles étiquetés, focus visible, contraste du texte d’au moins 4,5:1.',
        '- N’affiche jamais une donnée externe en HTML sans la nettoyer.',
        '- Quand le repo permet de lancer l’app, regarde le résultat (capture) et dis ce que tu as vérifié.',
      ].join('\n'),
    },
    qa: {
      description: 'Relit les diffs, écrit et lance les tests, reproduit les bugs, vérifie une livraison avant sa sortie. Ne développe pas de feature.',
      instructions: [
        '- Relis, reproduis et teste ; ne modifie que des fichiers de test, sauf si la mission demande un correctif.',
        '- Classe tes constats par gravité, chacun avec fichier:ligne et un scénario d’échec concret.',
        '- Ne valide jamais sans avoir lancé le build et les tests ; dis clairement ce que tu n’as pas pu vérifier.',
      ].join('\n'),
    },
    devops: {
      description: 'CI/CD, déploiements, infrastructure, configuration des environnements, releases, supervision.',
      instructions: [
        '- N’affiche et ne committe jamais un secret : utilise le coffre de secrets de la plateforme.',
        '- D’abord un essai à blanc ou une préproduction ; en production seulement si la mission le prévoit, build et tests passés.',
        '- Garde chaque changement réversible et dis comment revenir en arrière. Donne chaque version ou URL déployée.',
      ].join('\n'),
    },
    docs: {
      description: 'README, guides, changelogs, docs d’API et commentaires du code, tenus à jour avec le code.',
      instructions: [
        '- Phrases courtes, exemples concrets, commandes qui marchent telles quelles : vérifie chaque commande et chaque chemin dans le repo.',
        '- Garde le ton et la structure existants ; pas de langage marketing.',
      ].join('\n'),
    },
  },
};

/** A new post from a template, model and effort left to the master. */
export function fromTemplate(id: TemplateId, lang: Lang, folder: string): TeamRole {
  const t = TEMPLATES[lang][id];
  return { id: '', name: id, description: t.description, instructions: t.instructions, folders: folder ? [folder] : [], model: '', effort: '', mode: '', account: '', enabled: true };
}

// ---------- model and effort of a mission ----------

const rank = (e: Effort) => EFFORTS.indexOf(e);
export const capEffort = (e: Effort, max: Effort): Effort => (rank(e) > rank(max) ? max : e);

export type ChoiceNote = 'modelLocked' | 'effortLocked' | 'modelFixed' | 'effortFixed' | 'effortCapped';
export interface Choice {
  /** null: unchanged (nothing asked, or a choice of the user's kept). */
  model: string | null;
  effort: Effort | null;
  notes: ChoiceNote[];
}

/**
 * The model and effort a mission runs with, from what the master asked. The user's own choices come first: one made
 * by hand on this worker (`locked`), then the post's fixed values; the master picks among the allowed models, its
 * effort capped at the ceiling. A model outside the allowed ones is an error the master must correct.
 */
export function resolveChoice(i: {
  requested: { model?: string | null; effort?: Effort | null };
  post: { model: string; effort: Effort | '' } | null;
  locked: { model: boolean; effort: boolean };
  allowed: string[];
  maxEffort: Effort;
}): Choice | { error: 'model' } {
  const notes: ChoiceNote[] = [];
  let model: string | null = null;
  let effort: Effort | null = null;
  const wanted = i.requested.model?.trim().toLowerCase();
  if (wanted) {
    if (i.locked.model) notes.push('modelLocked');
    else if (i.post?.model) notes.push('modelFixed');
    else {
      // As the settings spell it: an allowed model may carry capitals.
      const allowed = i.allowed.find((a) => a.toLowerCase() === wanted);
      if (!allowed) return { error: 'model' };
      model = allowed;
    }
  }
  const asked = i.requested.effort;
  if (asked) {
    if (i.locked.effort) notes.push('effortLocked');
    else if (i.post?.effort) notes.push('effortFixed');
    else {
      effort = capEffort(asked, i.maxEffort);
      if (effort !== asked) notes.push('effortCapped');
    }
  }
  return { model, effort, notes };
}

export type Tier = 'simple' | 'standard' | 'hard' | 'critical';
export interface GridRow {
  tier: Tier;
  model: string;
  effort: Effort;
  /** Second choice for this tier, when another allowed model fits it too. */
  alt: { model: string; effort: Effort } | null;
}

const prefer = (allowed: string[], order: string[]) => order.find((m) => allowed.includes(m)) ?? allowed[0] ?? '';

/** The decision grid the master's prompt shows, fitted to the models the user allows and the effort ceiling. */
export function modelGrid(allowed: string[], maxEffort: Effort): GridRow[] {
  const cap = (e: Effort) => capEffort(e, maxEffort);
  const strong = prefer(allowed, ['opus', 'fable', 'sonnet', 'haiku']);
  const fast = prefer(allowed, ['sonnet', 'opus', 'fable', 'haiku']);
  const row = (tier: Tier, model: string, effort: Effort, alt: GridRow['alt'] = null): GridRow => ({ tier, model, effort: cap(effort), alt });
  const altOf = (model: string, effort: Effort) => (model && model !== fast ? { model, effort: cap(effort) } : null);
  return [
    row('simple', fast, 'low', allowed.includes('haiku') && fast !== 'haiku' ? { model: 'haiku', effort: cap('medium') } : null),
    row('standard', fast, 'high', altOf(strong, 'medium')),
    row('hard', strong, 'high'),
    row('critical', strong, 'xhigh', allowed.includes('fable') && strong !== 'fable' ? { model: 'fable', effort: cap('high') } : null),
  ];
}

// ---------- context of a worker ----------

/** A worker settling with more than this share of its window starts its next mission afresh. */
export const FRESH_START_PCT = 50;
export const needsFreshStart = (m: Metrics | null) => (m?.contextPct ?? 0) >= FRESH_START_PCT;

// ---------- Claude Code subagent files ----------

/** Frontmatter (a YAML subset: scalars, quoted strings, block scalars, lists) and body of a .claude/agents/*.md file. */
export function parseAgentFile(text: string): { fields: Record<string, string>; body: string } | null {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(src);
  if (!m) return null;
  const fields: Record<string, string> = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, raw] = kv;
    const value = raw.trim();
    // Indented lines that follow belong to this key: a block scalar or a list.
    const block: string[] = [];
    while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i]);
    if (/^[|>][+-]?$/.test(value)) {
      const indent = Math.min(...block.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0));
      const body = block.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      fields[key] = (value[0] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ')).trim();
    } else if (value === '' && block.some((l) => /^\s*-\s/.test(l))) {
      fields[key] = block.map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1].trim() ?? '').filter(Boolean).join(', ');
    } else if (value.startsWith('"')) {
      const quoted = /^"((?:[^"\\]|\\.)*)"/.exec([value, ...block.map((l) => l.trim())].join(' '));
      fields[key] = quoted ? quoted[1].replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t' })[c] ?? c) : value;
    } else if (value.startsWith("'")) {
      const quoted = /^'((?:[^']|'')*)'/.exec([value, ...block.map((l) => l.trim())].join(' '));
      fields[key] = quoted ? quoted[1].replace(/''/g, "'") : value;
    } else {
      fields[key] = [value, ...block.map((l) => l.trim())].filter(Boolean).join(' ');
    }
  }
  return { fields, body: m[2].trim() };
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
/** Subagent fields a post carries; any other one present in the file is named as not carried over. */
const CARRIED = new Set(['name', 'description', 'model', 'effort', 'permissionMode']);
/** What the settings say a subagent field is, when a post does not carry it; the rest are "other settings". */
const NOT_CARRIED: Record<string, AgentDrop> = { tools: 'tools', disallowedTools: 'tools', mcpServers: 'mcp', hooks: 'hooks', skills: 'skills', memory: 'memory' };
export const AGENT_DROPS = ['tools', 'mcp', 'hooks', 'skills', 'memory', 'bypass', 'mode', 'other'] as const;
export type AgentDrop = (typeof AGENT_DROPS)[number];

/** A subagent file as a post working in `folder`; bypass is never imported: only the user turns it on. */
export function agentToRole(file: { fields: Record<string, string>; body: string }, folder: string): { role: Omit<TeamRole, 'id'>; ignored: AgentDrop[] } {
  const f = file.fields;
  const model = (f.model ?? '').trim().toLowerCase();
  const mode = (f.permissionMode ?? '').trim();
  const keptMode = ROLE_MODES.includes(mode as Mode) && mode !== 'bypassPermissions' ? (mode as Mode) : '';
  const dropped: AgentDrop[] = Object.keys(f)
    .filter((k) => !CARRIED.has(k))
    .map((k) => NOT_CARRIED[k] ?? 'other');
  if (mode && !keptMode) dropped.push(mode === 'bypassPermissions' ? 'bypass' : 'mode');
  const ignored = AGENT_DROPS.filter((d) => dropped.includes(d));
  return {
    role: {
      name: slugify(f.name ?? '', ROLE_LIMITS.name),
      description: cut((f.description ?? '').trim(), ROLE_LIMITS.description),
      instructions: cut(file.body, ROLE_LIMITS.instructions),
      folders: folder ? [folder] : [],
      model: model && model !== 'inherit' && MODEL.test(model) ? model : '',
      effort: EFFORTS.includes(f.effort as Effort) ? (f.effort as Effort) : '',
      mode: keptMode,
      account: '',
      enabled: true,
    },
    ignored,
  };
}
