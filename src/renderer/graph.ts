/*---------------------------------------------------------------------------------------------
 *  Swimlane graph of the Source Control Graph view, ported from Visual Studio Code:
 *  src/vs/workbench/contrib/scm/browser/scmHistory.ts (microsoft/vscode).
 *
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License:
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 *  associated documentation files (the "Software"), to deal in the Software without restriction,
 *  including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
 *  and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
 *  subject to the following conditions:
 *
 *  The above copyright notice and this permission notice shall be included in all copies or substantial
 *  portions of the Software.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
 *  LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 *  NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 *  WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 *  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *--------------------------------------------------------------------------------------------*/

import type { GitRef } from '../shared/types';

export const SWIMLANE_HEIGHT = 22;
export const SWIMLANE_WIDTH = 11;
const SWIMLANE_CURVE_RADIUS = 5;
const CIRCLE_RADIUS = 4;
const CIRCLE_STROKE_WIDTH = 2;

export const INCOMING_ID = 'scm-graph-incoming-changes';
export const OUTGOING_ID = 'scm-graph-outgoing-changes';

/** Colors are CSS custom properties: --graph-ref, --graph-remote, --graph-base, --graph-1…5. */
export const REF_COLOR = 'ref';
export const REMOTE_REF_COLOR = 'remote';
export const BASE_REF_COLOR = 'base';
export const COLORS = ['1', '2', '3', '4', '5'];
export const cssColor = (color: string) => `var(--graph-${color})`;

export interface HistoryRef extends GitRef {
  /** Color of the badge; undefined for a ref drawn with no badge of its own. */
  color?: string;
}

export interface HistoryItem {
  id: string;
  parentIds: string[];
  subject: string;
  message: string;
  author?: string;
  email?: string;
  at?: number;
  references?: HistoryRef[];
}

/** The ref the graph is drawn for (HEAD, its upstream, the base branch) and the commit it points at. */
export interface HistoryItemRef {
  id: string;
  name: string;
  revision?: string;
}

export interface GraphNode {
  id: string;
  color: string;
}

export type ViewModelKind = 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes';

export interface HistoryItemViewModel {
  historyItem: HistoryItem;
  inputSwimlanes: GraphNode[];
  outputSwimlanes: GraphNode[];
  kind: ViewModelKind;
}

const clone = (node: GraphNode): GraphNode => ({ ...node });
const rot = (index: number, modulo: number) => (modulo + (index % modulo)) % modulo;

function findLastIdx<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
}

function getLabelColor(historyItem: HistoryItem, colorMap: Map<string, string | undefined>): string | undefined {
  if (historyItem.id === INCOMING_ID) return REMOTE_REF_COLOR;
  if (historyItem.id === OUTGOING_ID) return REF_COLOR;
  for (const ref of historyItem.references ?? []) {
    const color = colorMap.get(ref.id);
    if (color !== undefined) return color;
  }
  return undefined;
}

/** Lane of the commit's circle: where it comes in, or a new lane on the right. */
export function getHistoryItemIndex(viewModel: HistoryItemViewModel): number {
  const inputIndex = viewModel.inputSwimlanes.findIndex((node) => node.id === viewModel.historyItem.id);
  return inputIndex !== -1 ? inputIndex : viewModel.inputSwimlanes.length;
}

/**
 * Input and output swimlanes of each commit, newest first. A lane carries the id of the commit it leads to;
 * the first parent continues the commit's lane, the other parents open new ones with the next color.
 */
export function toViewModels(
  historyItems: HistoryItem[],
  colorMap = new Map<string, string | undefined>(),
  currentRef?: HistoryItemRef,
  currentRemoteRef?: HistoryItemRef,
  currentBaseRef?: HistoryItemRef,
  addIncomingChanges?: boolean,
  addOutgoingChanges?: boolean,
  mergeBase?: string,
): HistoryItemViewModel[] {
  let colorIndex = -1;
  const viewModels: HistoryItemViewModel[] = [];

  for (const historyItem of historyItems) {
    const kind: ViewModelKind = historyItem.id === currentRef?.revision ? 'HEAD' : 'node';
    const inputSwimlanes = (viewModels.at(-1)?.outputSwimlanes ?? []).map(clone);
    const outputSwimlanes: GraphNode[] = [];

    let firstParentAdded = false;

    // Add first parent to the output
    if (historyItem.parentIds.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === historyItem.id) {
          if (!firstParentAdded) {
            outputSwimlanes.push({ id: historyItem.parentIds[0], color: getLabelColor(historyItem, colorMap) ?? node.color });
            firstParentAdded = true;
          }
          continue;
        }
        outputSwimlanes.push(clone(node));
      }
    }

    // Add unprocessed parent(s) to the output
    for (let i = firstParentAdded ? 1 : 0; i < historyItem.parentIds.length; i++) {
      let color: string | undefined;
      if (i === 0) {
        color = getLabelColor(historyItem, colorMap);
      } else {
        const parent = historyItems.find((h) => h.id === historyItem.parentIds[i]);
        color = parent ? getLabelColor(parent, colorMap) : undefined;
      }
      if (!color) {
        colorIndex = rot(colorIndex + 1, COLORS.length);
        color = COLORS[colorIndex];
      }
      outputSwimlanes.push({ id: historyItem.parentIds[i], color });
    }

    // Add colors to references
    const references = (historyItem.references ?? []).map((ref) => {
      let color = colorMap.get(ref.id);
      if (colorMap.has(ref.id) && color === undefined) {
        const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id);
        const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
        color =
          circleIndex < outputSwimlanes.length
            ? outputSwimlanes[circleIndex].color
            : circleIndex < inputSwimlanes.length
              ? inputSwimlanes[circleIndex].color
              : REF_COLOR;
      }
      return { ...ref, color };
    });
    references.sort((a, b) => compareRefs(a, b, currentRef, currentRemoteRef, currentBaseRef));

    viewModels.push({ historyItem: { ...historyItem, references }, kind, inputSwimlanes, outputSwimlanes });
  }

  addIncomingOutgoingChanges(viewModels, currentRef, currentRemoteRef, addIncomingChanges, addOutgoingChanges, mergeBase);
  return viewModels;
}

/**
 * Inserts the "Incoming Changes" node above the merge base (on the upstream's lane) and the "Outgoing Changes"
 * node above HEAD, rewiring the lanes around them.
 */
function addIncomingOutgoingChanges(
  viewModels: HistoryItemViewModel[],
  currentRef?: HistoryItemRef,
  currentRemoteRef?: HistoryItemRef,
  addIncomingChanges?: boolean,
  addOutgoingChanges?: boolean,
  mergeBase?: string,
): void {
  if (currentRef?.revision === currentRemoteRef?.revision || !mergeBase) return;

  // Incoming changes node
  if (addIncomingChanges && currentRemoteRef && currentRemoteRef.revision !== mergeBase) {
    // The merge base may not be loaded yet.
    const beforeIndex = findLastIdx(viewModels, (vm) => vm.outputSwimlanes.some((node) => node.id === mergeBase));
    const afterIndex = viewModels.findIndex((vm) => vm.historyItem.id === mergeBase);

    if (beforeIndex !== -1 && afterIndex !== -1) {
      // Incoming changes already merged: no node (microsoft/vscode#276064).
      const before = viewModels[beforeIndex].historyItem;
      const incomingChangeMerged = before.parentIds.length === 2 && before.parentIds.includes(mergeBase);

      if (!incomingChangeMerged) {
        // The upstream's lane now leads to the incoming changes node instead of the merge base.
        const redirect = (node: GraphNode) => (node.id === mergeBase && node.color === REMOTE_REF_COLOR ? { ...node, id: INCOMING_ID } : node);
        viewModels[beforeIndex] = {
          ...viewModels[beforeIndex],
          inputSwimlanes: viewModels[beforeIndex].inputSwimlanes.map(redirect),
          outputSwimlanes: viewModels[beforeIndex].outputSwimlanes.map(redirect),
        };

        viewModels.splice(afterIndex, 0, {
          historyItem: { id: INCOMING_ID, parentIds: [mergeBase], author: currentRemoteRef.name, subject: 'Incoming Changes', message: '' },
          kind: 'incoming-changes',
          inputSwimlanes: viewModels[beforeIndex].outputSwimlanes.map(clone),
          outputSwimlanes: viewModels[afterIndex].inputSwimlanes.map(clone),
        });
      }
    }
  }

  // Outgoing changes node
  if (addOutgoingChanges && currentRef?.revision && currentRef.revision !== mergeBase) {
    const headIndex = viewModels.findIndex((vm) => vm.kind === 'HEAD' && vm.historyItem.id === currentRef.revision);
    if (headIndex !== -1) {
      const inputSwimlanes = viewModels[headIndex].inputSwimlanes.slice(0);
      viewModels.splice(headIndex, 0, {
        historyItem: { id: OUTGOING_ID, parentIds: [currentRef.revision], author: currentRef.name, subject: 'Outgoing Changes', message: '' },
        kind: 'outgoing-changes',
        inputSwimlanes,
        outputSwimlanes: inputSwimlanes.concat({ id: currentRef.revision, color: REF_COLOR }),
      });
      // HEAD now hangs from the outgoing changes node.
      viewModels[headIndex + 1].inputSwimlanes.push({ id: currentRef.revision, color: REF_COLOR });
    }
  }
}

/** Badges order: current branch, its upstream, the base, then the other colored refs. */
export function compareRefs(
  a: HistoryRef,
  b: HistoryRef,
  currentRef?: HistoryItemRef,
  currentRemoteRef?: HistoryItemRef,
  currentBaseRef?: HistoryItemRef,
): number {
  const order = (ref: HistoryRef) =>
    ref.id === currentRef?.id ? 1 : ref.id === currentRemoteRef?.id ? 2 : ref.id === currentBaseRef?.id ? 3 : ref.color !== undefined ? 4 : 99;
  return order(a) - order(b);
}

// ---------- rendering ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

function createPath(color: string, strokeWidth = 1): SVGPathElement {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-width', `${strokeWidth}px`);
  path.setAttribute('stroke-linecap', 'round');
  path.style.stroke = cssColor(color);
  return path;
}

function drawCircle(index: number, radius: number, strokeWidth: number, color?: string): SVGCircleElement {
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', `${SWIMLANE_WIDTH * (index + 1)}`);
  circle.setAttribute('cy', `${SWIMLANE_WIDTH}`);
  circle.setAttribute('r', `${radius}`);
  circle.style.strokeWidth = `${strokeWidth}px`;
  if (color) circle.style.fill = cssColor(color);
  return circle;
}

function drawDashedCircle(index: number, strokeWidth: number, color: string): SVGCircleElement {
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', `${SWIMLANE_WIDTH * (index + 1)}`);
  circle.setAttribute('cy', `${SWIMLANE_WIDTH}`);
  circle.setAttribute('r', `${CIRCLE_RADIUS + 1}`);
  circle.style.stroke = cssColor(color);
  circle.style.strokeWidth = `${strokeWidth}px`;
  circle.style.strokeDasharray = '4,2';
  return circle;
}

function drawVerticalLine(x1: number, y1: number, y2: number, color: string, strokeWidth = 1): SVGPathElement {
  const path = createPath(color, strokeWidth);
  path.setAttribute('d', `M ${x1} ${y1} V ${y2}`);
  return path;
}

/** One row of the graph: the lanes passing through, the curves into and out of the commit, and its circle. */
export function renderGraph(viewModel: HistoryItemViewModel): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('graph');

  const { historyItem, inputSwimlanes, outputSwimlanes } = viewModel;
  const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id);
  const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
  const circleColor =
    circleIndex < outputSwimlanes.length
      ? outputSwimlanes[circleIndex].color
      : circleIndex < inputSwimlanes.length
        ? inputSwimlanes[circleIndex].color
        : REF_COLOR;

  let outputSwimlaneIndex = 0;
  for (let index = 0; index < inputSwimlanes.length; index++) {
    const color = inputSwimlanes[index].color;

    if (inputSwimlanes[index].id === historyItem.id) {
      // Current commit
      if (index !== circleIndex) {
        // Base commit: draw / then -
        const path = createPath(color);
        path.setAttribute(
          'd',
          [
            `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
            `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${SWIMLANE_WIDTH}`,
            `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`,
          ].join(' '),
        );
        svg.append(path);
      } else {
        outputSwimlaneIndex++;
      }
    } else if (outputSwimlaneIndex < outputSwimlanes.length && inputSwimlanes[index].id === outputSwimlanes[outputSwimlaneIndex].id) {
      // Not the current commit
      if (index === outputSwimlaneIndex) {
        svg.append(drawVerticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, color));
      } else {
        // The lane shifts left: | / - / |
        const path = createPath(color);
        path.setAttribute(
          'd',
          [
            `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
            'V 6',
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${SWIMLANE_WIDTH * (index + 1) - SWIMLANE_CURVE_RADIUS} ${SWIMLANE_HEIGHT / 2}`,
            `H ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1) + SWIMLANE_CURVE_RADIUS}`,
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)} ${SWIMLANE_HEIGHT / 2 + SWIMLANE_CURVE_RADIUS}`,
            `V ${SWIMLANE_HEIGHT}`,
          ].join(' '),
        );
        svg.append(path);
      }
      outputSwimlaneIndex++;
    }
  }

  // Add remaining parent(s): -\
  for (let i = 1; i < historyItem.parentIds.length; i++) {
    const parentOutputIndex = findLastIdx(outputSwimlanes, (node) => node.id === historyItem.parentIds[i]);
    if (parentOutputIndex === -1) continue;
    const path = createPath(outputSwimlanes[parentOutputIndex].color);
    path.setAttribute(
      'd',
      [
        `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
        `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * (parentOutputIndex + 1)} ${SWIMLANE_HEIGHT}`,
        `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
        `H ${SWIMLANE_WIDTH * (circleIndex + 1)} `,
      ].join(' '),
    );
    svg.append(path);
  }

  // | to *
  if (inputIndex !== -1) {
    svg.append(drawVerticalLine(SWIMLANE_WIDTH * (circleIndex + 1), 0, SWIMLANE_HEIGHT / 2, inputSwimlanes[inputIndex].color));
  }

  // | from *
  if (historyItem.parentIds.length > 0) {
    svg.append(drawVerticalLine(SWIMLANE_WIDTH * (circleIndex + 1), SWIMLANE_HEIGHT / 2, SWIMLANE_HEIGHT, circleColor));
  }

  // *
  if (viewModel.kind === 'HEAD') {
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor));
    svg.append(drawCircle(circleIndex, CIRCLE_STROKE_WIDTH, CIRCLE_RADIUS));
  } else if (viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes') {
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor));
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH + 1));
    svg.append(drawDashedCircle(circleIndex, CIRCLE_STROKE_WIDTH - 1, circleColor));
  } else if (historyItem.parentIds.length > 1) {
    // Merge commit
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 2, CIRCLE_STROKE_WIDTH, circleColor));
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS - 1, CIRCLE_STROKE_WIDTH, circleColor));
  } else {
    svg.append(drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH, circleColor));
  }

  svg.style.height = `${SWIMLANE_HEIGHT}px`;
  svg.style.width = `${SWIMLANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1)}px`;
  return svg;
}

/** The lanes alone, for the rows under an expanded commit and the "load more" row. */
export function renderGraphPlaceholder(columns: GraphNode[], highlightIndex?: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('graph');
  svg.style.height = `${SWIMLANE_HEIGHT}px`;
  svg.style.width = `${SWIMLANE_WIDTH * (columns.length + 1)}px`;
  columns.forEach((column, index) => {
    svg.append(drawVerticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, column.color, index === highlightIndex ? 3 : 1));
  });
  return svg;
}
