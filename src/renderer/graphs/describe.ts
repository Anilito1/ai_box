import type { MediaType } from '../../shared/modelCaps';
import { CONVERTERS, GraphFormatError, nodeName, type Catalog, type ConverterId, type Graph, type GraphNode } from '../../shared/graph/format';
import type { Bridge, Issue, Params, RefusalCode } from '../../shared/graph/validate';
import { t } from '../i18n';

// The graphs' problems in words: the shared code says a code and its values (node ids, port ids, types), this file
// names the nodes and says it in the user's language.

export const kindName = (node: GraphNode): string => (node.kind === 'convert' ? converterName(node.convert) : t(`graphs.kind.${node.kind}`));
export const converterName = (id: ConverterId): string => t(`graphs.convert.${id}`);
export const converterHint = (id: ConverterId): string => t(`graphs.convert.${id}.hint`);
export const titleOf = (node: GraphNode, catalog: Catalog): string => nodeName(node, catalog, kindName);
const typeWord = (v: unknown) => (typeof v === 'string' && v ? t(`graphs.type.${v as MediaType}`) : '');

function words(graph: Graph, catalog: Catalog, params: Params): Params {
  const name = (id: unknown) => {
    const node = graph.nodes.find((n) => n.id === id);
    return node ? titleOf(node, catalog) : String(id ?? '');
  };
  return {
    ...params,
    ...(params.node !== undefined ? { node: name(params.node) } : {}),
    ...(params.from !== undefined && !String(params.from).includes('.') ? { from: name(params.from) } : {}),
    ...(params.to !== undefined && !String(params.to).includes('.') ? { to: name(params.to) } : {}),
    ...(params.nodes !== undefined ? { nodes: String(params.nodes).split(',').map(name).join(', ') } : {}),
    ...(params.kind !== undefined ? { kind: t(`graphs.kind.${params.kind as 'chat-input' | 'chat-output'}`) } : {}),
    ...(params.type !== undefined ? { type: typeWord(params.type) } : {}),
    ...(params.have !== undefined ? { have: typeWord(params.have), want: typeWord(params.want) } : {}),
  };
}

/** Why a wire is refused, its nodes named. */
export const refusalText = (graph: Graph, catalog: Catalog, code: RefusalCode, params: Params): string => t(`graphs.refusal.${code}`, words(graph, catalog, params));

export function issueText(graph: Graph, catalog: Catalog, issue: Issue): string {
  if (issue.code === 'edge' && issue.refusal) {
    const p = words(graph, catalog, { ...issue.params, from: String(issue.params.from).split('.')[0], to: String(issue.params.to).split('.')[0] });
    return t('graphs.issue.edge', { from: String(p.from), to: String(p.to), why: refusalText(graph, catalog, issue.refusal, issue.params) });
  }
  return t(`graphs.issue.${issue.code as Exclude<Issue['code'], 'edge'>}`, words(graph, catalog, issue.params));
}

export const bridgeLabel = (bridge: Bridge, catalog: Catalog): string => (bridge.kind === 'convert' ? converterName(bridge.convert) : (catalog.get(bridge.model)?.name || bridge.model));

/** A saved graph that cannot be read, said. */
export const formatText = (err: unknown): string => (err instanceof GraphFormatError ? t(`graphs.format.${err.code}`, err.params) : err instanceof SyntaxError ? t('graphs.format.json', { error: err.message }) : String(err));

/** The ports of a conversion, for the editor's toolbar. */
export const CONVERTER_LIST = Object.keys(CONVERTERS) as ConverterId[];
