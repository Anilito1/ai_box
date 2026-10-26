import { app, systemPreferences } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DictationEvent, DictationSettings, DictationSupport } from '../../shared/dictation';
import { AppleEngine, appleSupported, checkApple, helperPath } from './apple';
import type { DictationEngine } from './engine';
import { applyTerms, mergeTerms } from './terms';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The dictation of the window: picks the engine, asks for the microphone, and hands the engine's events on (with the
 * spelling of the terms restored). One dictation at a time.
 */
export class Dictation {
  private engine: DictationEngine | null = null;
  private terms: string[] = [];
  private supportFor = '';
  private supportCache: Promise<DictationSupport> | null = null;
  /** Bumped by every start and cancel: a start that awaits something finds out it was overtaken. */
  private generation = 0;

  constructor(
    private readonly settings: () => DictationSettings,
    private readonly emit: (event: DictationEvent) => void,
  ) {}

  private helper(): string {
    return helperPath(process.resourcesPath, join(here, '..'), app.isPackaged);
  }

  /** Only Apple's engine exists for now: macOS 26 and later. */
  support(): Promise<DictationSupport> {
    const { enabled, language } = this.settings();
    if (!enabled || !appleSupported()) return Promise.resolve({ available: false, installed: false });
    // Asked once per language: the helper is a process to start.
    if (!this.supportCache || this.supportFor !== language) {
      this.supportFor = language;
      this.supportCache = checkApple(this.helper(), language);
    }
    return this.supportCache;
  }

  /** The system's answer for the microphone, asking the user the first time. */
  async permission(): Promise<boolean> {
    if (process.platform !== 'darwin') return true;
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'granted') return true;
    if (status === 'not-determined') return systemPreferences.askForMediaAccess('microphone');
    return false;
  }

  async start(own: unknown): Promise<boolean> {
    this.cancel();
    const generation = this.generation;
    const support = await this.support();
    if (!support.available || generation !== this.generation) return false;
    this.terms = mergeTerms(own);
    const engine = new AppleEngine(this.helper());
    engine.onEvent((event) => {
      if (this.engine !== engine) return;
      if (event.type === 'partial' || event.type === 'final') this.emit({ ...event, text: applyTerms(event.text, this.terms) });
      else this.emit(event);
      if (event.type === 'final' || event.type === 'error') this.engine = null;
    });
    this.engine = engine;
    engine.start({ language: this.settings().language, terms: this.terms });
    return true;
  }

  feed(pcm: Buffer): void {
    this.engine?.feed(pcm);
  }

  stop(): void {
    this.engine?.stop();
  }

  cancel(): void {
    this.generation++;
    this.engine?.cancel();
    this.engine = null;
  }
}
