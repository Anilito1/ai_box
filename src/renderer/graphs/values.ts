import type { ClientValue } from '../../shared/graph/protocol';
import type { HubApi } from '../../shared/types';
import { t } from '../i18n';
import { el } from './dom';

// How a value a run made is shown: on a node (small) and in the test chat (full). A medium is a file of the run in
// the main process: it is asked for once, then shown from memory.

const urls = new Map<string, Promise<string>>();

function mediaUrl(hub: HubApi, runId: string, file: string): Promise<string> {
  const key = `${runId}/${file}`;
  let url = urls.get(key);
  if (!url) {
    url = hub.graphsMedia(runId, file).then((m) => (m ? URL.createObjectURL(new Blob([new Uint8Array(m.data)], { type: m.mime })) : ''));
    urls.set(key, url);
  }
  return url;
}

/** The files of runs no longer shown leave memory. */
export function forgetMedia(keep: string): void {
  for (const [key, url] of urls) {
    if (key.startsWith(`${keep}/`)) continue;
    void url.then((u) => u && URL.revokeObjectURL(u));
    urls.delete(key);
  }
}

export function valueView(hub: HubApi, runId: string, value: ClientValue, small: boolean): HTMLElement {
  if (value.type === 'text') return el('div', small ? 'gr-text small' : 'gr-text', value.text);
  const box = el('div', `gr-media type-${value.type}${small ? ' small' : ''}`);
  const missing = () => box.replaceChildren(el('div', 'gr-note', t('graphs.media.gone')));
  void mediaUrl(hub, runId, value.file).then((url) => {
    if (!url) return missing();
    if (value.type === 'image') {
      const img = el('img');
      img.src = url;
      img.alt = value.label ?? t('graphs.type.image');
      box.prepend(img);
    } else if (value.type === 'video') {
      const video = el('video');
      video.src = url;
      video.controls = !small;
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      box.prepend(video);
    } else {
      const audio = el('audio');
      audio.src = url;
      audio.controls = true;
      box.prepend(audio);
    }
  });
  if (value.label && !small) box.append(el('div', 'gr-note', value.label));
  return box;
}

/** A node's outputs, port by port, as previews. */
export function outputsView(hub: HubApi, runId: string, outputs: Record<string, ClientValue[]>, small: boolean): HTMLElement {
  const box = el('div', 'gr-outputs');
  for (const values of Object.values(outputs)) {
    if (values.length === 0) continue;
    const media = values.filter((v) => v.type !== 'text');
    for (const v of values) if (v.type === 'text') box.append(valueView(hub, runId, v, small));
    if (media.length) box.append(el('div', media.length > 1 ? 'gr-media-row many' : 'gr-media-row', ...media.map((v) => valueView(hub, runId, v, small))));
  }
  return box;
}
