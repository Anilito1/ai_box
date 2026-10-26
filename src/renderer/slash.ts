import { filterCommands, HUB_COMMANDS, needsArgument, parseSlash, pickOption, resolveSlash, type CliCommand, type HubCommand, type SlashInput } from '../shared/slash';
import { EFFORTS, MENU_MODES, type Effort, type HubApi, type Mode, type ModelOption, type SessionView } from '../shared/types';
import { h } from './dom';
import { effortLabel, t } from './i18n';

/** What the menu needs from its composer. */
export interface SlashHost {
  session(): SessionView | null;
  models(): ModelOption[];
  /** The composer's own menus, for a command typed without its argument. */
  openModelMenu(): void;
  openModeMenu(bypass: boolean): void;
  /** A short line above the field (an unknown command, a wrong argument): nothing is sent. */
  note(text: string): void;
  /** Empties the text field; images waiting in the draft stay. */
  clearText(): void;
}

interface Entry {
  name: string;
  args: string;
  description: string;
  hub: HubCommand | null;
  cli: CliCommand | null;
}

const MODE_ALIASES: Partial<Record<Mode, string>> = { bypassPermissions: 'bypass', acceptEdits: 'accept' };
let menus = 0;

/**
 * The "/" menu of a composer: the hub's own commands (the same in every session), then Claude Code's commands and
 * skills of the session, filtered as the name is typed. ↑↓ choose, Tab completes, Enter runs, Escape closes.
 */
export class SlashMenu {
  readonly root = h('div', 'slash');
  private readonly list = h('div', 'slash-list');
  private readonly confirmBox = h('div', 'slash-confirm');
  private cli: CliCommand[] = [];
  private cliFor = '';
  private loading: Promise<void> | null = null;
  private shown: Entry[] = [];
  private index = 0;
  /** Closed with Escape: it stays closed until the text changes. */
  private dismissed = '';
  private confirming = false;
  /** The selection was moved by hand (arrows, pointer) since the list was last filtered. */
  private chosen = false;

  constructor(
    private readonly input: HTMLTextAreaElement,
    private readonly hub: HubApi,
    private readonly host: SlashHost,
  ) {
    this.list.id = `slash-${++menus}`;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', t('slash.title'));
    this.root.append(this.list, h('div', 'slash-keys', t('slash.keys')));
    this.root.hidden = true;
    this.confirmBox.hidden = true;
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.setAttribute('aria-expanded', 'false');
  }

  /** The bar that asks before /clear; the composer puts it above its field. */
  get confirmation(): HTMLElement {
    return this.confirmBox;
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  /** Another session in the composer: its own commands, nothing left open. */
  reset(): void {
    this.close();
    this.cancelClear();
    this.dismissed = '';
  }

  /** After each keystroke: open and filtered while the first word is a "/name" being typed. */
  update(): void {
    // The text changed under the /clear question: it no longer stands.
    if (this.confirming) this.cancelClear();
    const value = this.input.value;
    const typing = /^\/[^\s]*$/.test(value) && value !== this.dismissed;
    if (!typing) return this.close();
    // Asked once each time the menu opens (a skill may have appeared since), not at every keystroke.
    if (!this.open) void this.load();
    this.draw(value.slice(1));
  }

  /** Keys while the menu or the /clear question is open; true when the key was used. */
  onKey(e: KeyboardEvent): boolean {
    if (this.confirming) {
      if (e.key === 'Enter' && !e.isComposing) this.confirmClear();
      else if (e.key === 'Escape') this.cancelClear();
      else return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    if (!this.open) return false;
    const entry = this.shown[this.index];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      this.select(this.index + (e.key === 'ArrowDown' ? 1 : -1));
      this.chosen = true;
    } else if (e.key === 'Tab' && !e.shiftKey && entry) {
      this.complete(entry);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && entry) {
      // Found only by its description, and not picked: the name typed is sent for what it is (a command whose list
      // has not arrived yet, or an unknown one, which is refused).
      if (!this.chosen && !entry.name.toLowerCase().startsWith(this.input.value.slice(1).toLowerCase())) {
        this.close();
        return false;
      }
      if (entry.cli && needsArgument(entry.cli.argumentHint)) this.complete(entry);
      else {
        this.close();
        void this.run({ name: entry.name, arg: '' });
      }
    } else if (e.key === 'Escape') {
      this.dismissed = this.input.value;
      this.close();
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  /**
   * A message on its way out: a command is run here (or refused with a note) and true is returned; plain text, or a
   * Claude Code command, gives false and the composer sends `text`.
   */
  async intercept(text: string): Promise<{ handled: true } | { handled: false; text: string }> {
    const input = parseSlash(text);
    if (!input) return { handled: false, text };
    this.close();
    if (!HUB_COMMANDS.includes(input.name.toLowerCase() as HubCommand)) await this.load();
    const target = resolveSlash(input, this.cli);
    if (target.kind === 'cli') return { handled: false, text: `/${target.command.name}${target.arg ? ` ${target.arg}` : ''}` };
    await this.run(input);
    return { handled: true };
  }

  // ---------- running ----------

  private async run(input: SlashInput): Promise<void> {
    const s = this.host.session();
    if (!s) return;
    const target = resolveSlash(input, this.cli);
    if (target.kind === 'unknown') {
      this.host.note(this.cli.length > 0 ? t('slash.unknown', { name: target.name }) : t('slash.unknownNoList', { name: target.name }));
      return;
    }
    if (target.kind === 'cli') {
      // Picked from the menu without an argument: sent as it is.
      this.host.clearText();
      this.hub.send(s.id, `/${target.command.name}`, []);
      return;
    }
    const arg = target.arg;
    switch (target.command) {
      case 'compact':
        this.hub.compact(s.id, arg);
        break;
      case 'clear':
        this.askClear();
        return;
      case 'model': {
        if (!arg) {
          this.host.openModelMenu();
          break;
        }
        const models = this.host.models();
        const value = pickOption(
          models.map((m) => ({ value: m.value, names: [m.value, m.label] })),
          arg,
        );
        if (!value) return this.host.note(t('slash.badModel', { arg, list: models.map((m) => m.value).join(', ') || '—' }));
        this.hub.setModel(s.id, value);
        break;
      }
      case 'effort': {
        if (!arg) {
          this.host.openModelMenu();
          break;
        }
        const efforts = this.efforts(s);
        const value = pickOption(
          efforts.map((e) => ({ value: e, names: [e, effortLabel(e)] })),
          arg,
        );
        if (!value) return this.host.note(t('slash.badEffort', { arg, list: efforts.join(', ') }));
        this.hub.setEffort(s.id, value);
        break;
      }
      case 'mode': {
        if (!arg) {
          this.host.openModeMenu(false);
          break;
        }
        const value = pickOption(
          MENU_MODES.map((m) => ({ value: m, names: [m, t(`mode.${m}`), MODE_ALIASES[m] ?? ''] })),
          arg,
        );
        if (!value) return this.host.note(t('slash.badMode', { arg, list: MENU_MODES.map((m) => MODE_ALIASES[m] ?? m).join(', ') }));
        // Never without the explicit confirmation of the mode menu.
        if (value === 'bypassPermissions' && s.mode !== value) this.host.openModeMenu(true);
        else this.hub.setMode(s.id, value);
        break;
      }
      case 'cost':
        this.hub.showCost(s.id);
        break;
      case 'help':
        // The list is the help: the menu opens with every command.
        this.input.value = '/';
        this.dismissed = '';
        this.update();
        this.input.focus();
        return;
    }
    this.host.clearText();
  }

  /** The efforts the session's model takes, as the model menu offers them. */
  private efforts(s: SessionView): Effort[] {
    const current = this.host.models().find((m) => m.value === s.model);
    return current?.efforts.length ? current.efforts : EFFORTS;
  }

  // ---------- /clear: a light confirmation above the field ----------

  private askClear(): void {
    const yes = h('button', 'btn small primary', t('slash.clearYes'));
    yes.addEventListener('click', () => this.confirmClear());
    const no = h('button', 'btn small ghost', t('setup.cancel'));
    no.addEventListener('click', () => this.cancelClear());
    this.confirmBox.replaceChildren(h('span', 'slash-confirm-text', t('slash.clearConfirm')), yes, no);
    this.confirmBox.hidden = false;
    this.confirming = true;
    this.input.focus();
  }

  private confirmClear(): void {
    const s = this.host.session();
    this.cancelClear();
    if (!s) return;
    this.hub.clear(s.id);
    this.host.clearText();
  }

  private cancelClear(): void {
    this.confirming = false;
    this.confirmBox.hidden = true;
    this.confirmBox.replaceChildren();
  }

  // ---------- the list ----------

  /** The session's Claude Code commands, asked each time the menu opens (a skill may have appeared). */
  private load(): Promise<void> {
    const id = this.host.session()?.id;
    if (!id) return Promise.resolve();
    if (this.loading && this.cliFor === id) return this.loading;
    if (this.cliFor !== id) this.cli = [];
    this.cliFor = id;
    const loading = this.hub
      .sessionCommands(id)
      .then((list) => {
        if (this.cliFor !== id) return;
        this.cli = list;
        if (this.open) this.draw(this.input.value.slice(1));
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.loading === loading) this.loading = null;
      });
    this.loading = loading;
    return loading;
  }

  private hubEntries(): Entry[] {
    const s = this.host.session();
    const args: Record<HubCommand, string> = {
      compact: t('slash.arg.compact'),
      clear: '',
      model: t('slash.arg.model'),
      effort: `[${(s ? this.efforts(s) : EFFORTS).join(' | ')}]`,
      mode: `[${MENU_MODES.map((m) => MODE_ALIASES[m] ?? m).join(' | ')}]`,
      cost: '',
      help: '',
    };
    return HUB_COMMANDS.map((c) => ({ name: c, args: args[c], description: t(`slash.${c}`), hub: c, cli: null }));
  }

  private draw(query: string): void {
    const hub = filterCommands(this.hubEntries(), query);
    const cli = filterCommands(
      this.cli.map((c) => ({ name: c.name, args: c.argumentHint, description: c.description, hub: null, cli: c })),
      query,
    );
    this.shown = [...hub, ...cli];
    const rows: HTMLElement[] = [];
    const row = (entry: Entry, i: number) => {
      const el = h('div', 'slash-row');
      el.id = `${this.list.id}-${i}`;
      el.setAttribute('role', 'option');
      const head = h('span', 'slash-head');
      head.append(h('span', 'slash-name', `/${entry.name}`));
      if (entry.args) head.append(h('span', 'slash-args', entry.args));
      el.append(head, h('span', 'slash-desc', entry.description));
      el.title = entry.description;
      // Chosen with the pointer: the field keeps the focus.
      el.addEventListener('mousedown', (e) => e.preventDefault());
      el.addEventListener('pointermove', () => this.index !== i && this.select(i));
      el.addEventListener('click', () => {
        this.select(i);
        this.chosen = true;
        this.onKey(new KeyboardEvent('keydown', { key: 'Enter' }));
      });
      return el;
    };
    if (hub.length) rows.push(h('div', 'slash-label', t('slash.section.hub')), ...hub.map((e, i) => row(e, i)));
    if (cli.length) rows.push(h('div', 'slash-label', t('slash.section.cli')), ...cli.map((e, i) => row(e, hub.length + i)));
    if (this.loading && this.cli.length === 0) rows.push(h('div', 'slash-note', t('slash.loading')));
    else if (this.shown.length === 0) rows.push(h('div', 'slash-note', t('slash.none')));
    this.list.replaceChildren(...rows);
    this.root.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-controls', this.list.id);
    // The command typed in full, else the first whose name starts with it: "/context" never runs /compact (whose
    // description mentions the context).
    this.chosen = false;
    const q = query.toLowerCase();
    const exact = this.shown.findIndex((e) => e.name.toLowerCase() === q);
    this.select(exact >= 0 ? exact : Math.max(0, this.shown.findIndex((e) => e.name.toLowerCase().startsWith(q))));
  }

  private select(i: number): void {
    this.index = Math.max(0, Math.min(this.shown.length - 1, i));
    for (const el of this.list.querySelectorAll('.slash-row')) el.setAttribute('aria-selected', String(el.id === `${this.list.id}-${this.index}`));
    const current = document.getElementById(`${this.list.id}-${this.index}`);
    if (current) {
      this.input.setAttribute('aria-activedescendant', current.id);
      current.scrollIntoView({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
  }

  /** "/name " in the field, ready for its argument; the menu closes. */
  private complete(entry: Entry): void {
    this.input.value = entry.args ? `/${entry.name} ` : `/${entry.name}`;
    this.dismissed = this.input.value;
    this.close();
    this.input.dispatchEvent(new Event('input'));
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }
}
