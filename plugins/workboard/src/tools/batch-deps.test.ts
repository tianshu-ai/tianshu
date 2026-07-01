// Unit tests for the intra-batch dependency graph helpers used by
// task_create: cycle detection + topological ordering.

import { describe, it, expect } from "vitest";
import { detectCycleMembers, topoOrder } from "./index.js";

describe("detectCycleMembers", () => {
  it("no cycle in a linear chain", () => {
    // 0 -> 1 -> 2 (edges[i] = deps i needs first)
    const edges = [[], [0], [1]];
    expect([...detectCycleMembers(edges)]).toEqual([]);
  });

  it("flags a simple 2-cycle", () => {
    const edges = [[1], [0]];
    expect(detectCycleMembers(edges)).toEqual(new Set([0, 1]));
  });

  it("flags a 3-cycle but leaves acyclic nodes alone", () => {
    // 0->1->2->0 cycle; 3 depends on 0 (not in cycle itself)
    const edges = [[2], [0], [1], [0]];
    const c = detectCycleMembers(edges);
    expect(c.has(0)).toBe(true);
    expect(c.has(1)).toBe(true);
    expect(c.has(2)).toBe(true);
    expect(c.has(3)).toBe(false);
  });

  it("handles diamond (no cycle)", () => {
    // 3 depends on 1 and 2; both depend on 0
    const edges = [[], [0], [0], [1, 2]];
    expect([...detectCycleMembers(edges)]).toEqual([]);
  });
});

describe("topoOrder", () => {
  it("orders a linear chain dependency-first", () => {
    const edges = [[], [0], [1]];
    expect(topoOrder(edges, new Set())).toEqual([0, 1, 2]);
  });

  it("puts dependencies before dependents in a diamond", () => {
    const edges = [[], [0], [0], [1, 2]];
    const order = topoOrder(edges, new Set());
    const pos = (i: number) => order.indexOf(i);
    expect(pos(0)).toBeLessThan(pos(1));
    expect(pos(0)).toBeLessThan(pos(2));
    expect(pos(1)).toBeLessThan(pos(3));
    expect(pos(2)).toBeLessThan(pos(3));
    expect(order.length).toBe(4);
  });

  it("still emits every row when a cycle is excluded", () => {
    const edges = [[1], [0], [0]];
    const inCycle = detectCycleMembers(edges); // {0,1}
    const order = topoOrder(edges, inCycle);
    expect(new Set(order)).toEqual(new Set([0, 1, 2]));
  });

  it("reverse-declared chain still orders correctly", () => {
    // row 0 depends on row 2, row 1 depends on row 2, row 2 has none
    const edges = [[2], [2], []];
    const order = topoOrder(edges, new Set());
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(0));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(1));
  });
});
