import type { ClientValue } from '../shared/protocol';
import { h } from './dom';

// How a value is shown: on a node (small) and in the conversation (full).

export function valueView(value: ClientValue, small: boolean): HTMLElement {
  if (value.type === 'text') return h('div', small ? 'value-text small' : 'value-text', value.text);
  const box = h('div', `value-media type-${value.type}${small ? ' small' : ''}`);
  if (value.type === 'image') {
    const img = h('img');
    img.src = value.url;
    img.alt = value.label ?? 'image';
    img.loading = 'lazy';
    const link = h('a', '', img);
    link.href = value.url;
    link.target = '_blank';
    link.title = 'Ouvrir en grand';
    box.append(link);
  } else if (value.type === 'video') {
    const video = h('video');
    video.src = value.url;
    video.controls = !small;
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.addEventListener('error', () => box.replaceChildren(h('div', 'value-note', 'Ce navigateur ne lit pas cette vidéo. '), Object.assign(h('a', '', 'Ouvrir le fichier'), { href: value.url, target: '_blank' })));
    box.append(video);
  } else {
    const audio = h('audio');
    audio.src = value.url;
    audio.controls = true;
    box.append(audio);
  }
  if (value.label && !small) box.append(h('div', 'value-note', value.label));
  return box;
}

/** A node's outputs, port by port, as small previews. */
export function outputsView(outputs: Record<string, ClientValue[]>, small: boolean): HTMLElement {
  const box = h('div', 'outputs');
  for (const values of Object.values(outputs)) {
    if (values.length === 0) continue;
    const media = values.filter((v) => v.type !== 'text');
    for (const v of values) if (v.type === 'text') box.append(valueView(v, small));
    if (media.length) box.append(h('div', media.length > 1 ? 'media-row many' : 'media-row', ...media.map((v) => valueView(v, small))));
  }
  return box;
}
