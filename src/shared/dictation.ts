/** Voice dictation: the settings and the messages between the window and the engine in the main process. */

/** Keys that start a dictation when held (a quick tap toggles it instead). */
export type DictationKey = 'Alt+Space' | 'Ctrl+Space' | 'F9';
export const DICTATION_KEYS: DictationKey[] = ['Alt+Space', 'Ctrl+Space', 'F9'];

/** Languages offered in the settings; the file may hold any well-formed tag. */
export const DICTATION_LANGUAGES = ['fr-FR', 'en-US', 'en-GB', 'es-ES', 'de-DE', 'it-IT', 'pt-BR'];
export const isDictationLanguage = (v: unknown): v is string => typeof v === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(v);

/** `native`: the system's own recogniser (Apple's, macOS 26+). `api`: a transcription service reached with a key. */
export type SttEngine = 'native' | 'api';
export const STT_ENGINES: SttEngine[] = ['native', 'api'];

/** The services offered for the `api` engine; `custom` is any OpenAI-compatible address. */
export type SttPresetId = 'groq' | 'openai' | 'xai' | 'custom';
export const STT_PRESET_IDS: SttPresetId[] = ['groq', 'openai', 'xai', 'custom'];

export interface SttPreset {
  label: string;
  /** Address of the API, up to the version (`…/v1`); empty for `custom`, where the user gives it. */
  baseUrl: string;
  /** `openai`: POST {base}/audio/transcriptions with `model`, `language`, `prompt`. `xai`: POST {base}/stt with `keyterm`s. */
  protocol: 'openai' | 'xai';
  /** Suggested models, the first being the default. */
  models: string[];
  /** Where the user creates a key. */
  keyUrl: string;
}

export const STT_PRESETS: Record<SttPresetId, SttPreset> = {
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', protocol: 'openai', models: ['whisper-large-v3-turbo', 'whisper-large-v3'], keyUrl: 'https://console.groq.com/keys' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'], keyUrl: 'https://platform.openai.com/api-keys' },
  xai: { label: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1', protocol: 'xai', models: ['grok-voice-transcribe-2.0'], keyUrl: 'https://console.x.ai' },
  custom: { label: '', baseUrl: '', protocol: 'openai', models: [], keyUrl: '' },
};

export const isSttEngine = (v: unknown): v is SttEngine => STT_ENGINES.includes(v as SttEngine);
export const isSttPreset = (v: unknown): v is SttPresetId => STT_PRESET_IDS.includes(v as SttPresetId);
/** A model id as services write them (`whisper-large-v3-turbo`, `org/model:tag`); empty is the preset's default. */
export const isSttModel = (v: unknown): v is string => typeof v === 'string' && /^[\w./:@-]{0,100}$/.test(v);
/** An http(s) address, or empty. Plain http is for a service on this machine or the local network. */
export const isSttUrl = (v: unknown): v is string => typeof v === 'string' && (v === '' || (v.length <= 300 && /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(v)));

export interface DictationSettings {
  enabled: boolean;
  /** BCP 47 tag of the spoken language. */
  language: string;
  key: DictationKey;
  /** `native` where the machine has no native engine stands for `api`. */
  engine: SttEngine;
  preset: SttPresetId;
  /** Empty: the preset's first model. */
  model: string;
  /** The address of the `custom` preset. */
  baseUrl: string;
}

export const DICTATION_DEFAULTS: DictationSettings = { enabled: true, language: 'fr-FR', key: 'Alt+Space', engine: 'native', preset: 'groq', model: '', baseUrl: '' };

/** The engine a dictation runs on: `native` only where the machine has one. */
export const engineOf = (d: Pick<DictationSettings, 'engine'>, nativeHere: boolean): SttEngine => (d.engine === 'native' && nativeHere ? 'native' : 'api');

/** The model sent to the service: the one set, else the preset's default. */
export const modelOf = (d: Pick<DictationSettings, 'preset' | 'model'>): string => d.model || STT_PRESETS[d.preset].models[0] || '';

/** The service's address: the preset's, or the one set for `custom`; no trailing slash. */
export const baseUrlOf = (d: Pick<DictationSettings, 'preset' | 'baseUrl'>): string => (d.preset === 'custom' ? d.baseUrl : STT_PRESETS[d.preset].baseUrl).replace(/\/+$/, '');

export const isDictationKey = (v: unknown): v is DictationKey => DICTATION_KEYS.includes(v as DictationKey);

/**
 * What the engine can do on this machine. `installed`: the language's voice asset is on the Mac already. `streaming`:
 * words come while the user speaks (Apple's); else the whole text comes once the audio has been sent (a service).
 */
export interface DictationSupport {
  available: boolean;
  installed: boolean;
  streaming: boolean;
}

/** Terms handed to the engine to favour (names, jargon); a few dozen short ones at most. */
export const TERMS_MAX = 60;
export const TERM_MAX_LENGTH = 40;

/** The composer's text leaves only when it is whole: a dictation still writing in it holds words that may yet change. */
export const canSend = (c: { hasContent: boolean; preparing: number; dictating: boolean }): boolean => c.hasContent && c.preparing === 0 && !c.dictating;

/** What an engine reports. `partial` is the whole dictation so far, `final` the settled text once the audio has ended. */
export type DictationEvent =
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: string; message: string };
