/**
 * SVG DAG visualization for tool call pipelines.
 *
 * Layout: top-to-bottom flow. Each batch (LLM turn) is a row.
 * Parallel calls within a batch spread horizontally.
 * Edges connect every node in row[i] to every node in row[i+1].
 *
 * Node states:
 *   - running: accent border + pulse animation
 *   - failed:  red border + red text
 *   - done:    green dot + muted text
 */

import { useMemo } from "react";
import type { MergedToolCall } from "../lib/merge-tool-turns";

// ── Layout constants ──────────────────────────────────────
const NODE_H = 22;          // node pill height
const NODE_PAD_X = 8;       // horizontal text padding inside pill
const NODE_GAP_X = 8;       // horizontal gap between parallel nodes
const ROW_GAP = 20;         // vertical gap between rows (for edges)
const FONT_SIZE = 10;
const ICON_R = 3.5;          // status dot radius
const ICON_GAP = 5;          // gap between status dot and text
const CHAR_W = 6;            // approx monospace char width at 10px
const MAX_LABEL_CHARS = 16;  // truncate long tool names
const MARGIN = 8;            // svg margin

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

function nodeWidth(label: string): number {
  const textW = label.length * CHAR_W;
  return Math.max(ICON_GAP + ICON_R * 2 + NODE_PAD_X * 2 + textW + 4, 50);
}

// ── Component ─────────────────────────────────────────────
export default function ToolCallDag({ batches }: { batches: ToolBatch[] }) {
  const { nodes, edges, width, height } = useMemo(() => {
    const allNodes: NodeLayout[] = [];
    const allEdges: EdgeLayout[] = [];

    // Build rows: each batch is a horizontal row
    const rows: { nodes: NodeLayout[]; rowW: number }[] = [];

    for (const batch of batches) {
      const rowNodes: NodeLayout[] = [];
      let totalW = 0;
      for (let i = 0; i < batch.calls.length; i++) {
        const c = batch.calls[i];
        const label = truncLabel(shortToolName(c.name));
        const w = nodeWidth(label);
        rowNodes.push({
          id: c.id,
          name: c.name,
          label,
          running: !c.result,
          failed: !!c.result && !c.result.ok,
          done: !!c.result && c.result.ok !== false,
          x: 0, y: 0,
          w,
          h: NODE_H,
        });
        totalW += w + (i > 0 ? NODE_GAP_X : 0);
      }
      rows.push({ nodes: rowNodes, rowW: totalW });
    }

    // Find max row width for centering
    const maxRowW = Math.max(...rows.map((r) => r.rowW));

    // Assign positions: center each row horizontally
    let curY = MARGIN;
    for (const row of rows) {
      let curX = MARGIN + (maxRowW - row.rowW) / 2; // center
      for (const node of row.nodes) {
        node.x = curX;
        node.y = curY;
        allNodes.push(node);
        curX += node.w + NODE_GAP_X;
      }
      curY += NODE_H + ROW_GAP;
    }

    // Edges: from bottom-center of each node in row[i] to top-center of each node in row[i+1]
    for (let ri = 0; ri < rows.length - 1; ri++) {
      const fromRow = rows[ri].nodes;
      const toRow = rows[ri + 1].nodes;
      for (const from of fromRow) {
        for (const to of toRow) {
          allEdges.push({
            fromX: from.x + from.w / 2,
            fromY: from.y + from.h,
            toX: to.x + to.w / 2,
            toY: to.y,
          });
        }
      }
    }

    const svgW = maxRowW + MARGIN * 2;
    const svgH = curY - ROW_GAP + MARGIN; // remove last gap, add bottom margin

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
        <marker
          id="dag-arrow"
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--fg-fainter, #475569)" />
        </marker>
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

      {/* Edges — vertical bezier curves */}
      {edges.map((e, i) => {
        const dy = e.toY - e.fromY;
        const cp = dy * 0.4;
        return (
          <path
            key={`e${i}`}
            d={`M ${e.fromX} ${e.fromY} C ${e.fromX} ${e.fromY + cp}, ${e.toX} ${e.toY - cp}, ${e.toX} ${e.toY}`}
            fill="none"
            stroke="var(--fg-fainter, #475569)"
            strokeWidth={1.5}
            markerEnd="url(#dag-arrow)"
            opacity={0.7}
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
