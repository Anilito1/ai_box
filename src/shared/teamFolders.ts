/**
 * Folders of the sidebar's Team section: the user's own arrangement of the posts, nothing else (the groups and the
 * master never see it). Posts are named by id, which a rename keeps. A post in no folder is in the root list: first
 * the ones the user placed there, in their order, then the others in the team's order (a new post arrives last).
 */

export const FOLDER_LIMITS = { folders: 40, name: 40, posts: 200, post: 40 } as const;
export const FOLDER_ID = /^f-[a-z0-9]{8}$/;

export interface TeamFolder {
  id: string;
  name: string;
  collapsed: boolean;
  /** Post ids, first to last. */
  posts: string[];
}

export interface TeamFolderPrefs {
  folders: TeamFolder[];
  /** Order of the posts placed at the root; empty until the user moves one there. */
  root: string[];
}

export const NO_FOLDERS: TeamFolderPrefs = { folders: [], root: [] };

/** A folder's name as typed: trimmed, one line, cut to the limit; empty = not a name. */
export const folderName = (raw: string) =>
  raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, FOLDER_LIMITS.name)
    .trim();

const isIds = (v: unknown): v is string[] => Array.isArray(v) && v.length <= FOLDER_LIMITS.posts && v.every((k) => typeof k === 'string' && k.length <= FOLDER_LIMITS.post);

const isFolder = (v: unknown): v is TeamFolder => {
  const f = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return typeof f.id === 'string' && FOLDER_ID.test(f.id) && typeof f.name === 'string' && f.name !== '' && folderName(f.name) === f.name && typeof f.collapsed === 'boolean' && isIds(f.posts);
};

export const isFolderPrefs = (v: unknown): v is TeamFolderPrefs => {
  const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return Array.isArray(p.folders) && p.folders.length <= FOLDER_LIMITS.folders && p.folders.every(isFolder) && isIds(p.root);
};

/**
 * Only the posts of `team`, each in one place (the first one met); a folder id met twice keeps its first folder. Only
 * the known fields are copied: nothing else reaches the settings file.
 */
export function pruneFolders(prefs: TeamFolderPrefs, team: string[]): TeamFolderPrefs {
  const seen = new Set<string>();
  const keep = (ids: string[]) =>
    ids.filter((id) => {
      if (!team.includes(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const folders = prefs.folders.filter((f, i) => prefs.folders.findIndex((o) => o.id === f.id) === i).map((f) => ({ id: f.id, name: f.name, collapsed: f.collapsed, posts: keep(f.posts) }));
  return { folders, root: keep(prefs.root) };
}

export interface Arranged<T> {
  folders: { folder: TeamFolder; posts: T[] }[];
  root: T[];
}

/** Where each post of `posts` (in the team's order) is shown; ids the team no longer has are skipped. */
export function arrangeTeam<T>(posts: T[], idOf: (p: T) => string, prefs: TeamFolderPrefs): Arranged<T> {
  const byId = new Map(posts.map((p) => [idOf(p), p]));
  const placed = new Set<string>();
  const take = (ids: string[]) =>
    ids.flatMap((id) => {
      const p = byId.get(id);
      if (!p || placed.has(id)) return [];
      placed.add(id);
      return [p];
    });
  const folders = prefs.folders.map((folder) => ({ folder, posts: take(folder.posts) }));
  const listed = take(prefs.root);
  return { folders, root: [...listed, ...posts.filter((p) => !placed.has(idOf(p)))] };
}

const insert = (ids: string[], id: string, before: string | null) => {
  const at = before === null ? -1 : ids.indexOf(before);
  return at < 0 ? [...ids, id] : [...ids.slice(0, at), id, ...ids.slice(at)];
};

export function addFolder(prefs: TeamFolderPrefs, id: string, name: string): TeamFolderPrefs {
  const clean = folderName(name);
  if (!clean || !FOLDER_ID.test(id) || prefs.folders.some((f) => f.id === id) || prefs.folders.length >= FOLDER_LIMITS.folders) return prefs;
  return { ...prefs, folders: [...prefs.folders, { id, name: clean, collapsed: false, posts: [] }] };
}

export function renameFolder(prefs: TeamFolderPrefs, id: string, name: string): TeamFolderPrefs {
  const clean = folderName(name);
  if (!clean) return prefs;
  return { ...prefs, folders: prefs.folders.map((f) => (f.id === id ? { ...f, name: clean } : f)) };
}

/** Its posts go back to the root, never away. */
export function removeFolder(prefs: TeamFolderPrefs, id: string): TeamFolderPrefs {
  const gone = prefs.folders.find((f) => f.id === id);
  if (!gone) return prefs;
  // Placed after the root's own, in the folder's order; unlisted posts would follow the team's order anyway.
  return { folders: prefs.folders.filter((f) => f.id !== id), root: prefs.root.length > 0 ? [...prefs.root, ...gone.posts] : [] };
}

export const toggleFolder = (prefs: TeamFolderPrefs, id: string): TeamFolderPrefs => ({
  ...prefs,
  folders: prefs.folders.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f)),
});

/** The folder takes the place of `before` (null: last). */
export function moveFolder(prefs: TeamFolderPrefs, id: string, before: string | null): TeamFolderPrefs {
  const folder = prefs.folders.find((f) => f.id === id);
  if (!folder || id === before) return prefs;
  const ids = insert(
    prefs.folders.filter((f) => f.id !== id).map((f) => f.id),
    id,
    before,
  );
  return { ...prefs, folders: ids.map((i) => prefs.folders.find((f) => f.id === i) as TeamFolder) };
}

/**
 * The post goes into folder `to` (null: the root) before post `before` (null or absent: last). `shownRoot` is the
 * root as shown, which the root's saved order becomes when the post lands there.
 */
export function placePost(prefs: TeamFolderPrefs, shownRoot: string[], id: string, to: string | null, before: string | null): TeamFolderPrefs {
  if (id === before || (to !== null && !prefs.folders.some((f) => f.id === to))) return prefs;
  const folders = prefs.folders.map((f) => {
    const posts = f.posts.filter((p) => p !== id);
    return { ...f, posts: f.id === to ? insert(posts, id, before) : posts };
  });
  const root = to === null ? insert(shownRoot.filter((p) => p !== id), id, before) : prefs.root.filter((p) => p !== id);
  return { folders, root };
}
