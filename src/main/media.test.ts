import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mediaType, remoteMedia } from '../shared/media';
import { MediaFiles, parseRange, privateAddress, publicHost, type MediaGet } from './media';

const get = (url: string, headers: Record<string, string> = {}, method = 'GET') => new Request(url, { method, headers });
const bytes = async (res: Response) => Buffer.from(await res.arrayBuffer());

test('media links: images and videos by extension, local or web, nothing else', () => {
  assert.deepEqual(mediaType('C:/Users/x/Videos/AI-Box/clip.MP4'), { kind: 'video', type: 'video/mp4' });
  assert.deepEqual(mediaType('shot.webp'), { kind: 'image', type: 'image/webp' });
  assert.equal(mediaType('clip.mov')?.kind, 'video');
  for (const name of ['logo.svg', 'notes.md', 'archive.mp4.zip', 'video', 'run.exe']) assert.equal(mediaType(name), null, name);
  assert.deepEqual(remoteMedia('https://cdn.example.com/a/b/chat%20roux.png?x=1#top'), { kind: 'image', host: 'cdn.example.com', name: 'chat roux.png', secure: true });
  assert.equal(remoteMedia('http://example.com/v.webm')?.secure, false);
  // The name "Save as" offers stays a name: an encoded folder part cannot lead out of the chosen folder.
  assert.equal(remoteMedia('https://example.com/a/..%2F..%5Cevil.png')?.name, 'evil.png');
  for (const href of ['https://example.com/page', 'ftp://example.com/a.png', 'javascript:alert(1)//.png', 'C:/x/a.png']) assert.equal(remoteMedia(href), null, href);
});

test('byte ranges: start-end, open end, suffix, past the end, malformed', () => {
  assert.deepEqual(parseRange('bytes=2-5', 10), [2, 5]);
  assert.deepEqual(parseRange('bytes=4-', 10), [4, 9]);
  assert.deepEqual(parseRange('bytes=8-99', 10), [8, 9]);
  assert.deepEqual(parseRange('bytes=-3', 10), [7, 9]);
  assert.deepEqual(parseRange('bytes=-30', 10), [0, 9]);
  assert.equal(parseRange('bytes=10-', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
  for (const header of [null, '', 'bytes=5-2', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-']) assert.equal(parseRange(header, 10), null, String(header));
});

test('media boundary: allowed folders only, no "..", no link out, no private or unknown files', async () => {
  const base = await mkdtemp(join(tmpdir(), 'media-files-'));
  const workspace = join(base, 'workspace');
  const videos = join(base, 'videos');
  const outside = join(base, 'outside');
  try {
    await Promise.all([mkdir(join(workspace, '.hidden'), { recursive: true }), mkdir(videos), mkdir(outside)]);
    await Promise.all([
      writeFile(join(workspace, 'shot.png'), 'png'),
      writeFile(join(workspace, 'notes.txt'), 'txt'),
      writeFile(join(workspace, 'logo.svg'), '<svg/>'),
      writeFile(join(workspace, '.hidden', 'a.png'), 'png'),
      writeFile(join(videos, 'clip.mp4'), 'mp4'),
      writeFile(join(outside, 'elsewhere.png'), 'png'),
    ]);
    const media = new MediaFiles();
    const shot = await media.resolve(workspace, 'shot.png');
    assert.equal(shot.ok && shot.kind, 'image');
    assert.equal(shot.ok && shot.size, 3);
    assert.match(shot.ok ? shot.url : '', /^aibox-media:\/\/m\/[0-9a-f]{32}$/);
    // The same file keeps its address: the page's cache and the card stay valid across redraws.
    assert.deepEqual(await media.resolve(workspace, join(workspace, 'shot.png')), shot);
    // The generated videos, from any conversation.
    assert.equal((await media.resolve(workspace, join(videos, 'clip.mp4'))).ok, false);
    assert.equal((await media.resolve(workspace, join(videos, 'clip.mp4'), [videos])).ok, true);
    assert.deepEqual(await media.resolve(workspace, '../outside/elsewhere.png', [videos]), { ok: false, error: 'outside' });
    assert.deepEqual(await media.resolve(workspace, join(videos, '..', 'outside', 'elsewhere.png'), [videos]), { ok: false, error: 'outside' });
    assert.deepEqual(await media.resolve(workspace, join(outside, 'elsewhere.png')), { ok: false, error: 'outside' });
    assert.deepEqual(await media.resolve(workspace, 'notes.txt'), { ok: false, error: 'unsupported' });
    assert.deepEqual(await media.resolve(workspace, 'logo.svg'), { ok: false, error: 'unsupported' });
    assert.deepEqual(await media.resolve(workspace, '.hidden/a.png'), { ok: false, error: 'unsupported' });
    assert.deepEqual(await media.resolve(workspace, 'gone.mp4'), { ok: false, error: 'missing' });
    assert.deepEqual(await media.resolve(workspace, 'https://example.com/a.png'), { ok: false, error: 'invalid' });
    assert.deepEqual(await media.resolve(undefined, 'shot.png'), { ok: false, error: 'invalid' });
    // A folder link inside the workspace leading out of it (a junction needs no rights on Windows).
    await symlink(outside, join(workspace, 'link'), 'junction');
    assert.deepEqual(await media.resolve(workspace, 'link/elsewhere.png'), { ok: false, error: 'outside' });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('media protocol: whole file, ranges, 416, HEAD, unknown tokens and methods, a file gone since', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-serve-'));
  try {
    const content = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < content.length; i++) content[i] = i % 251;
    await writeFile(join(dir, 'clip.mp4'), content);
    const media = new MediaFiles();
    const r = await media.resolve(dir, 'clip.mp4');
    assert.ok(r.ok);
    const whole = await media.handle(get(r.url));
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'video/mp4');
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(whole.headers.get('content-length'), String(content.length));
    assert.ok((await bytes(whole)).equals(content));
    const part = await media.handle(get(r.url, { range: 'bytes=1048576-1048600' }));
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 1048576-1048600/${content.length}`);
    assert.equal(part.headers.get('content-length'), '25');
    assert.ok((await bytes(part)).equals(content.subarray(1048576, 1048601)));
    const tail = await media.handle(get(r.url, { range: 'bytes=-17' }));
    assert.equal(tail.status, 206);
    assert.ok((await bytes(tail)).equals(content.subarray(content.length - 17)));
    const past = await media.handle(get(r.url, { range: `bytes=${content.length}-` }));
    assert.equal(past.status, 416);
    assert.equal(past.headers.get('content-range'), `bytes */${content.length}`);
    const head = await media.handle(get(r.url, {}, 'HEAD'));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(content.length));
    assert.equal((await bytes(head)).length, 0);
    assert.equal((await media.handle(get(r.url, {}, 'POST'))).status, 405);
    assert.equal((await media.handle(get(`aibox-media://m/${'0'.repeat(32)}`))).status, 404);
    assert.equal((await media.handle(get('aibox-media://m/../../etc/passwd'))).status, 404);
    await rm(join(dir, 'clip.mp4'));
    assert.equal((await media.handle(get(r.url))).status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('media download: "Save as" copies the checked file; canceled, unknown and deleted files say so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-save-'));
  try {
    await writeFile(join(dir, 'shot.png'), 'png bytes');
    const media = new MediaFiles();
    const r = await media.resolve(dir, 'shot.png');
    assert.ok(r.ok);
    const asked: string[] = [];
    const dest = join(dir, 'copy.png');
    assert.deepEqual(await media.save(r.url, async (name) => (asked.push(name), dest)), { ok: true });
    assert.deepEqual(asked, ['shot.png']);
    assert.equal(await readFile(dest, 'utf8'), 'png bytes');
    assert.deepEqual(await media.save(r.url, async () => undefined), { ok: false, error: 'canceled' });
    assert.deepEqual(await media.save('aibox-media://m/nothing', async () => dest), { ok: false, error: 'missing' });
    assert.deepEqual(await media.save(42, async () => dest), { ok: false, error: 'missing' });
    const shown: string[] = [];
    assert.equal(await media.reveal(r.url, (p) => shown.push(p)), true);
    assert.equal(shown.length, 1);
    await rm(join(dir, 'shot.png'));
    assert.deepEqual(await media.save(r.url, async () => join(dir, 'again.png')), { ok: false, error: 'missing' });
    assert.equal(await media.reveal(r.url, (p) => shown.push(p)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('remote media: https public hosts only, each redirect checked, served under its own type', async () => {
  assert.equal(publicHost('cdn.example.com'), true);
  assert.equal(publicHost('93.184.216.34'), true);
  for (const host of ['localhost', 'printer.local', 'intranet', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '[::1]', '[fd00::1]', '[::ffff:127.0.0.1]']) assert.equal(publicHost(host), false, host);
  assert.equal(privateAddress('::ffff:10.0.0.1'), true);
  // The form a URL gives an IPv4-mapped address, and IPv4 reached through NAT64 or 6to4.
  assert.equal(new URL('https://[::ffff:127.0.0.1]/').hostname, '[::ffff:7f00:1]');
  for (const ip of ['::ffff:7f00:1', '64:ff9b::a00:1', '2002:c0a8:101::1', '198.18.0.1', 'not-an-ip']) assert.equal(privateAddress(ip), true, ip);
  assert.equal(publicHost('[::ffff:7f00:1]'), false);
  assert.equal(privateAddress('2606:4700::1'), false);

  const calls: { url: string; range: string | null }[] = [];
  const routes: Record<string, () => Response> = {
    'https://cdn.example.com/clip.mp4': () => new Response('0123456789', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-9/100', 'content-length': '10', 'set-cookie': 'x=1' } }),
    'https://cdn.example.com/page.png': () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    'https://cdn.example.com/hop.png': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/a.png' } }),
    'https://cdn.example.com/moved.png': () => new Response(null, { status: 301, headers: { location: '/real.png' } }),
    'https://cdn.example.com/real.png': () => new Response('PNG', { headers: { 'content-type': 'image/png' } }),
    // Cut halfway: a save fails without leaving a cut file or removing the one it would replace.
    'https://cdn.example.com/cut.png': () =>
      new Response(new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode('PN')); c.error(new Error('reset')); } }), { headers: { 'content-type': 'image/png' } }),
  };
  const web: MediaGet = async (url, init) => {
    calls.push({ url, range: new Headers(init.headers).get('range') });
    return routes[url]?.() ?? new Response(null, { status: 404 });
  };
  const lookup = async (host: string) => (host === 'rebind.example.com' ? ['127.0.0.1'] : ['93.184.216.34']);
  const media = new MediaFiles({ get: web, lookup });

  assert.deepEqual(await media.remote('http://cdn.example.com/clip.mp4'), { ok: false, error: 'unsupported' });
  assert.deepEqual(await media.remote('https://localhost/clip.mp4'), { ok: false, error: 'unsupported' });
  assert.deepEqual(await media.remote('https://rebind.example.com/clip.mp4'), { ok: false, error: 'unsupported' });
  assert.deepEqual(await media.remote('https://user:pw@cdn.example.com/clip.mp4'), { ok: false, error: 'unsupported' });
  assert.deepEqual(await media.remote('https://cdn.example.com/page'), { ok: false, error: 'invalid' });
  assert.equal(calls.length, 0, 'nothing is fetched before a request for the file');

  const clip = await media.remote('https://cdn.example.com/clip.mp4#t=3');
  assert.ok(clip.ok);
  assert.equal(clip.kind, 'video');
  const res = await media.handle(get(clip.url, { range: 'bytes=0-9' }));
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(await res.text(), '0123456789');
  assert.deepEqual(calls.at(-1), { url: 'https://cdn.example.com/clip.mp4', range: 'bytes=0-9' });

  const page = await media.remote('https://cdn.example.com/page.png');
  assert.ok(page.ok);
  assert.equal((await media.handle(get(page.url))).status, 415);
  const hop = await media.remote('https://cdn.example.com/hop.png');
  assert.ok(hop.ok);
  assert.equal((await media.handle(get(hop.url))).status, 502);
  assert.ok(!calls.some((c) => c.url.includes('127.0.0.1')), 'a redirect to this computer is not followed');
  const moved = await media.remote('https://cdn.example.com/moved.png');
  assert.ok(moved.ok);
  const png = await media.handle(get(moved.url));
  assert.equal(png.status, 200);
  assert.equal(await png.text(), 'PNG');

  const dir = await mkdtemp(join(tmpdir(), 'media-remote-save-'));
  try {
    assert.deepEqual(await media.save(moved.url, async () => join(dir, 'real.png')), { ok: true });
    assert.equal(await readFile(join(dir, 'real.png'), 'utf8'), 'PNG');
    assert.deepEqual(await media.save(page.url, async () => join(dir, 'page.png')), { ok: false, error: 'failed' });
    const cut = await media.remote('https://cdn.example.com/cut.png');
    assert.ok(cut.ok);
    assert.deepEqual(await media.save(cut.url, async () => join(dir, 'real.png')), { ok: false, error: 'failed' });
    assert.equal(await readFile(join(dir, 'real.png'), 'utf8'), 'PNG');
    assert.deepEqual(await readdir(dir), ['real.png']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
