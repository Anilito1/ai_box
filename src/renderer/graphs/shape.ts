import { PRESETS, type MediaType, type ModelShape, type Port, type PresetId } from '../../shared/modelCaps';
import { h } from '../dom';
import { t } from '../i18n';

// A model's shape in words and colours: what goes in, an arrow, what comes out. One colour per type of data, the same
// on the graphs' ports and wires and in a provider's form.

export const typeLabel = (type: MediaType, many = false): string => t(many ? `shape.types.${type}` : `shape.type.${type}`);

/** A port's type as a chip says it: "image", "images ×4". */
export const portLabel = (port: Port): string => ((port.max ?? 1) > 1 ? `${typeLabel(port.type, true)} ×${port.max}` : typeLabel(port.type));

export const presetLabel = (preset: PresetId): string => t(`shape.preset.${preset}`);
export const sourceLabel = (source: ModelShape['source']): string => t(`shape.source.${source}`);

/** The ports of a shape, with the number of images it takes when it says. */
export function shapePorts(shape: Pick<ModelShape, 'preset' | 'maxImages'>): { inputs: Port[]; outputs: Port[] } {
  const p = PRESETS[shape.preset];
  return { inputs: p.inputs.map((port) => (port.id === 'images' && shape.maxImages ? { ...port, max: shape.maxImages } : port)), outputs: p.outputs };
}

/** What a model does in a few words: "text + images ×4 → image". */
export function signatureText(ports: { inputs: Port[]; outputs: Port[] }): string {
  const side = (list: Port[]) => list.map(portLabel).join(' + ') || '∅';
  return `${side(ports.inputs)} → ${side(ports.outputs)}`;
}

/** The same as coloured chips. */
export function signatureView(ports: { inputs: Port[]; outputs: Port[] }): HTMLElement {
  const chips = (list: Port[]) => list.map((p) => h('span', `shape-chip type-${p.type}`, portLabel(p)));
  const box = h('span', 'shape-sig');
  box.append(...chips(ports.inputs), h('span', 'shape-arrow', '→'), ...chips(ports.outputs));
  return box;
}
