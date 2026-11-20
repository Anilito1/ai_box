// Strips what could identify the person or the machine from the report: account and computer names, profile paths,
// SIDs, e-mail addresses, GUID-like user ids. The collector already leaves serial numbers, SSIDs and command lines out.
import { hostname, userInfo } from 'node:os';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The identifying strings of the current session. */
export function localSecrets(env = process.env) {
  const names = [env.USERNAME, env.COMPUTERNAME, env.USERDOMAIN, safe(() => hostname()), safe(() => userInfo().username)];
  return { profile: env.USERPROFILE ?? null, names: [...new Set(names.filter((n) => n && n.length >= 3))] };
}

function safe(f) {
  try {
    return f();
  } catch {
    return null;
  }
}

/** Replaces the secrets and the generic identifiers in a text. */
export function scrub(text, { profile = null, names = [] } = {}) {
  let out = String(text);
  if (profile) out = out.replace(new RegExp(escape(profile), 'gi'), '%USERPROFILE%');
  out = out.replace(/([A-Z]:\\Users\\)(?!Public\\|Default\\|%)[^\\"\s]+/gi, '$1<compte>');
  out = out.replace(/S-1-5-21(-\d+){3,4}/g, 'S-1-5-21-…');
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<e-mail>');
  out = out.replace(/(?<![0-9a-f-])[0-9a-f]{32,}(?![0-9a-f-])/gi, '<id>'); // per-profile hashes (Edge auto-launch...)
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\w-])${escape(n)}(?![\\w-])`, 'gi'), '<machine-ou-compte>');
  }
  return out;
}
