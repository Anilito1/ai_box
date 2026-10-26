/** `version` ("2.1.287", "1.0.0-beta") is at least `min` ("2.1.284"): numbers compared one by one, not as strings. */
export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
