import { app, systemPreferences } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrlOf, engineOf, modelOf, STT_PRESETS, type DictationEvent, type DictationSettings, type DictationSupport, type SttPresetId } from '../../shared/dictation';
import { ApiEngine, type ApiTarget } from './api';
import { AppleEngine, appleSupported, checkApple, helperPath } from './apple';
import type { DictationEngine } from './engine';
import { applyTerms, mergeTerms } from './terms';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The dictation of the window: picks the engine (Apple's where the machine has it and the user keeps it, else the
 * transcription service set in Settings › Accounts), asks for the microphone, and hands the engine's events on (with the
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
    /** The key kept for a service, empty when none. */
    private readonly key: (preset: SttPresetId) => string,
  ) {}

  private helper(): string {
    return helperPath(process.resourcesPath, join(here, '..'), app.isPackaged);
  }

  /** The machine has a native engine: Apple's, macOS 26 and later. Elsewhere only a service can be used. */
  nativeOffered(): boolean {
    return appleSupported();
  }

  /** The service a dictation goes to, or null while one is missing (no key, no address for `custom`). */
  private target(): ApiTarget | null {
    const d = this.settings();
    const key = this.key(d.preset);
    const baseUrl = baseUrlOf(d);
    const model = modelOf(d);
    const protocol = STT_PRESETS[d.preset].protocol;
    // xAI has a default model; the OpenAI-style services need one named.
    return key && baseUrl && (model || protocol === 'xai') ? { protocol, baseUrl, model, key } : null;
  }

  support(): Promise<DictationSupport> {
    const { enabled, language } = this.settings();
    if (!enabled) return Promise.resolve({ available: false, installed: false, streaming: false });
    if (engineOf(this.settings(), this.nativeOffered()) === 'api') return Promise.resolve({ available: this.target() !== null, installed: true, streaming: false });
    // Asked once per language: the helper is a process to start.
    if (!this.supportCache || this.supportFor !== language) {
      this.supportFor = language;
      this.supportCache = checkApple(this.helper(), language);
    }
    return this.supportCache;
  }

  /** The system's answer for the microphone, asking the user the first time (macOS); Windows' privacy switch. */
  async permission(): Promise<boolean> {
    // Windows says `denied` when Settings › Privacy › Microphone keeps desktop apps away; Chromium would only fail later.
    if (process.platform === 'win32') return systemPreferences.getMediaAccessStatus('microphone') !== 'denied';
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
    const native = engineOf(this.settings(), this.nativeOffered()) === 'native';
    const target = native ? null : this.target();
    if (!native && !target) return false;
    const engine: DictationEngine = target ? new ApiEngine(target) : new AppleEngine(this.helper());
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
