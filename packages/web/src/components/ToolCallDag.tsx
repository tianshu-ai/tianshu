/**
 * SVG DAG visualization for tool call pipelines.
 *
 * Layout: left-to-right flow. Each batch (LLM turn) is a column.
 * Parallel calls within a batch stack vertically.
 * Edges connect every node in batch[i] to every node in batch[i+1].
 *
 * Node states:
 *   - running: accent border + pulse animation
 *   - failed:  red border + red text
 *   - done:    green left-edge accent + muted text
 */

import { useMemo } from "react";
import type { MergedToolCall } from "../lib/merge-tool-turns";

// ── Layout constants ──────────────────────────────────────
const NODE_H = 22;          // node pill height
const NODE_PAD_X = 8;       // horizontal text padding inside pill
const NODE_GAP_Y = 5;       // vertical gap between parallel nodes
const COL_GAP = 24;         // horizontal gap between columns (for edges)
const FONT_SIZE = 10;
const ICON_R = 3.5;          // status dot radius
const ICON_GAP = 5;          // gap between status dot and text
const CHAR_W = 6;            // approx monospace char width at 10px
const MAX_LABEL_CHARS = 16;  // truncate long tool names

// ── Types ─────────────────────────────────────────────────
interface ToolBatch {
  calls: MergedToolCall[];
}

interface NodeLayout {
  id: string;
  name: string;
  running: boolean;
  failed: boolean;
  done: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

interface EdgeLayout {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

// ── Helpers ───────────────────────────────────────────────
function shortToolName(name: string): string {
  const bridgeM = name.match(/^bridge_.*?_local_(.+)$/);
  if (bridgeM) return bridgeM[1];
  return name;
}

function truncLabel(s: string): string {
  return s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS - 1) + "…" : s;
}

// ── Component ─────────────────────────────────────────────
export default function ToolCallDag({ batches }: { batches: ToolBatch[] }) {
  const { nodes, edges, width, height } = useMemo(() => {
    const allNodes: NodeLayout[] = [];
    const allEdges: EdgeLayout[] = [];

    // First pass: compute node sizes
    const columns: { nodes: NodeLayout[]; colW: number }[] = [];
    let curX = 8; // left margin

    for (const batch of batches) {
      const colNodes: NodeLayout[] = [];
      let maxW = 0;
      for (const c of batch.calls) {
        const label = truncLabel(shortToolName(c.name));
        const textW = label.length * CHAR_W;
        const w = ICON_GAP + ICON_R * 2 + NODE_PAD_X * 2 + textW + 4;
        colNodes.push({
          id: c.id,
          name: c.name,
          label,
          running: !c.result,
          failed: !!c.result && !c.result.ok,
          done: !!c.result && c.result.ok !== false,
          x: 0, y: 0,
          w: Math.max(w, 50),
          h: NODE_H,
        });
        maxW = Math.max(maxW, Math.max(w, 50));
      }
      columns.push({ nodes: colNodes, colW: maxW });
      curX += maxW + COL_GAP;
    }

    // Second pass: assign positions
    curX = 8;
    const totalH: number[] = [];
    for (const col of columns) {
      const colH = col.nodes.reduce((s, n) => s + n.h + NODE_GAP_Y, -NODE_GAP_Y);
      totalH.push(colH);
    }
    const maxColH = Math.max(...totalH, NODE_H);

    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci];
      const colH = totalH[ci];
      let curY = (maxColH - colH) / 2 + 8; // center vertically + top margin

      for (const node of col.nodes) {
        node.x = curX;
        node.y = curY;
        allNodes.push(node);
        curY += node.h + NODE_GAP_Y;
      }
      curX += col.colW + COL_GAP;
    }

    // Third pass: edges
    for (let ci = 0; ci < columns.length - 1; ci++) {
      const fromCol = columns[ci].nodes;
      const toCol = columns[ci + 1].nodes;
      for (const from of fromCol) {
        for (const to of toCol) {
          allEdges.push({
            fromX: from.x + from.w,
            fromY: from.y + from.h / 2,
            toX: to.x,
            toY: to.y + to.h / 2,
          });
        }
      }
    }

    const svgW = curX - COL_GAP + 8; // remove last gap, add right margin
    const svgH = maxColH + 16; // top+bottom margin

    return { nodes: allNodes, edges: allEdges, width: svgW, height: svgH };
  }, [batches]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      role="img"
      aria-label="Tool execution pipeline"
    >
      <defs>
        {/* Arrowhead marker */}
        <marker
          id="dag-arrow"
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--border-default, #334155)" />
        </marker>
        {/* Running pulse */}
        <filter id="dag-pulse">
          <feFlood floodColor="var(--accent, #c9a96e)" floodOpacity="0.4" result="color" />
          <feComposite in="color" in2="SourceGraphic" operator="in" result="shadow" />
          <feGaussianBlur in="shadow" stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Edges */}
      {edges.map((e, i) => {
        const dx = e.toX - e.fromX;
        const cp = dx * 0.4;
        return (
          <path
            key={`e${i}`}
            d={`M ${e.fromX} ${e.fromY} C ${e.fromX + cp} ${e.fromY}, ${e.toX - cp} ${e.toY}, ${e.toX} ${e.toY}`}
            fill="none"
            stroke="var(--border-default, #334155)"
            strokeWidth={1}
            markerEnd="url(#dag-arrow)"
            opacity={0.5}
          />
        );
      })}

      {/* Nodes */}
      {nodes.map((n) => {
        const borderColor = n.running
          ? "var(--accent, #c9a96e)"
          : n.failed
            ? "#f43f5e"
            : "var(--border-default, #334155)";
        const bgColor = n.running
          ? "rgba(201, 169, 110, 0.08)"
          : n.failed
            ? "rgba(244, 63, 94, 0.08)"
            : "var(--bg-surface, #131a27)";
        const textColor = n.running
          ? "var(--accent, #c9a96e)"
          : n.failed
            ? "#f43f5e"
            : "var(--fg-muted, #94a3b8)";
        const dotColor = n.running
          ? "var(--accent, #c9a96e)"
          : n.failed
            ? "#f43f5e"
            : "#22c55e";

        return (
          <g key={n.id} filter={n.running ? "url(#dag-pulse)" : undefined}>
            {/* Pill background */}
            <rect
              x={n.x}
              y={n.y}
              width={n.w}
              height={n.h}
              rx={8}
              ry={8}
              fill={bgColor}
              stroke={borderColor}
              strokeWidth={n.running ? 1.5 : 1}
            />
            {/* Status dot */}
            <circle
              cx={n.x + NODE_PAD_X + ICON_R}
              cy={n.y + NODE_H / 2}
              r={ICON_R}
              fill={dotColor}
            >
              {n.running && (
                <animate
                  attributeName="opacity"
                  values="1;0.3;1"
                  dur="1.5s"
                  repeatCount="indefinite"
                />
              )}
            </circle>
            {/* Tool name */}
            <text
              x={n.x + NODE_PAD_X + ICON_R * 2 + ICON_GAP}
              y={n.y + NODE_H / 2}
              dominantBaseline="central"
              fill={textColor}
              fontSize={FONT_SIZE}
              fontFamily="var(--font-mono, ui-monospace, monospace)"
              fontWeight={n.running ? 600 : 500}
            >
              {n.label}
            </text>

          </g>
        );
      })}
    </svg>
  );
}
