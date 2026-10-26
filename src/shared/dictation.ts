/** Voice dictation: the settings and the messages between the window and the engine in the main process. */

/** Keys that start a dictation when held (a quick tap toggles it instead). */
export type DictationKey = 'Alt+Space' | 'Ctrl+Space' | 'F9';
export const DICTATION_KEYS: DictationKey[] = ['Alt+Space', 'Ctrl+Space', 'F9'];

/** Languages offered in the settings; the file may hold any well-formed tag. */
export const DICTATION_LANGUAGES = ['fr-FR', 'en-US', 'en-GB', 'es-ES', 'de-DE', 'it-IT', 'pt-BR'];
export const isDictationLanguage = (v: unknown): v is string => typeof v === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(v);

export interface DictationSettings {
  enabled: boolean;
  /** BCP 47 tag of the spoken language. */
  language: string;
  key: DictationKey;
}

export const DICTATION_DEFAULTS: DictationSettings = { enabled: true, language: 'fr-FR', key: 'Alt+Space' };

export const isDictationKey = (v: unknown): v is DictationKey => DICTATION_KEYS.includes(v as DictationKey);

/** What the engine can do on this machine. `installed`: the language's voice asset is on the Mac already. */
export interface DictationSupport {
  available: boolean;
  installed: boolean;
}

/** Terms handed to the engine to favour (names, jargon); a few dozen short ones at most. */
export const TERMS_MAX = 60;
export const TERM_MAX_LENGTH = 40;

/** What an engine reports. `partial` is the whole dictation so far, `final` the settled text once the audio has ended. */
export type DictationEvent =
  | { type: 'ready' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'error'; code: string; message: string };
