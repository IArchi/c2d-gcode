const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");

const app = vm.createContext({
  document: { getElementById: () => ({}) },
  window: { initSqlJs: () => new Promise(() => {}) },
  TextDecoder,
  Uint8Array,
  console,
});
vm.runInContext(fs.readFileSync(`${__dirname}/app.js`, "utf8"), app);

function generate({ tabs = [{ pos: [50, 0] }], ignoreTabs = false, stepdown = 3, zeroX = 0, zeroY = 0, closed = true } = {}) {
  const element = {
    uuid: "shape",
    points: [[0, 0], [100, 0], [100, 100], [0, 100]],
    point_type: closed ? [0, 1, 1, 1, 4] : [0, 1, 1, 1],
    cp1: [],
    cp2: [],
    tabs,
  };
  return app.generateGcode({
    document: { safeZ: 8, thickness: 15, zeroX, zeroY },
    parseWarnings: [],
    elementsByUuid: new Map([[element.uuid, element]]),
    toolpaths: [{
      type: "contour",
      elements: [{ uuid: element.uuid }],
      end_depth: 16,
      stepdown,
      tab_width: 12,
      tab_height: 3,
      ignore_tabs: ignoreTabs,
      tool: { diameter: 6 },
      speeds: { feedrate: 2000, plungerate: 400 },
    }],
  }, "tabs.c2d");
}

test("tabs lift the cutter on deep passes and account for cutter diameter", () => {
  const result = generate();
  const crossings = result.playbackSegments.filter((segment) => segment.motionType === "cut" && segment.start.y === 0 && segment.start.x === 41 && segment.end.x === 59);
  assert.equal(crossings.length, 2);
  assert.ok(crossings.every((segment) => segment.start.z === -13 && segment.end.z === -13));
  assert.ok(result.gcode.includes("G1 Z-13 F400"));
  assert.ok(!result.warnings.some((warning) => warning.includes("tabs")));
});

test("ignore_tabs keeps the original continuous cuts", () => {
  assert.equal(generate({ ignoreTabs: true }).previewPaths[0].paths[0].tabSegments.length, 0);
  assert.ok(!generate({ ignoreTabs: true }).gcode.includes("Z-13"));
});

test("passes above the tab top do not change", () => {
  const withTabs = generate().playbackSegments.filter((segment) => segment.motionType !== "rapid" && segment.end.z >= -12);
  const withoutTabs = generate({ tabs: [] }).playbackSegments.filter((segment) => segment.motionType !== "rapid" && segment.end.z >= -12);
  assert.equal(JSON.stringify(withTabs), JSON.stringify(withoutTabs));
});

test("tab positions follow the work origin", () => {
  const result = generate({ zeroX: 1000, zeroY: 500 });
  const segments = result.previewPaths[0].paths[0].tabSegments;
  assert.equal(segments[0].start[0], -959);
  assert.equal(segments[0].end[0], -941);
  assert.equal(segments[0].start[1], -500);
});

test("tabs spanning the closed seam protect both sides, including the initial plunge", () => {
  const result = generate({ tabs: [{ pos: [0, 0] }], stepdown: 16 });
  const cuts = result.playbackSegments.filter((segment) => segment.motionType === "cut");
  assert.equal(cuts[0].start.z, -13);
  assert.equal(cuts[cuts.length - 1].end.z, -13);
  assert.ok(!result.playbackSegments.some((segment) => segment.motionType === "plunge" && segment.start.x === 0 && segment.start.y === 0 && segment.end.z < -13));
});

test("overlapping tabs are cut as a continuous raised span", () => {
  const path = { points: [[0, 0], [100, 0]], tabs: [[45, 0], [55, 0]], closed: false };
  const segments = app.buildTabSegments(path, 20);
  const protectedLength = segments.filter((segment) => segment.isTab).reduce((sum, segment) => sum + segment.end[0] - segment.start[0], 0);
  assert.ok(Math.abs(protectedLength - 30) < 1e-6);
});

test("open paths lift at tabs on every deep pass", () => {
  const result = generate({ closed: false, stepdown: 8 });
  const crossings = result.playbackSegments.filter((segment) => segment.motionType === "cut" && segment.start.x === 41 && segment.end.x === 59);
  assert.equal(crossings.length, 1);
  assert.equal(crossings[0].start.z, -13);
});

test("nearest-start rotation and reversal preserve tab positions", () => {
  const path = {
    points: [[0, 0], [100, 0], [100, 100], [0, 100]],
    tabs: [[50, 0]],
    closed: true,
  };
  for (const oriented of [app.rotateClosedPath(path, 2), app.reversePath(path)]) {
    const segments = app.buildTabSegments(oriented, 18).filter((segment) => segment.isTab);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].start[1], 0);
    assert.equal(segments[0].end[1], 0);
    assert.ok(Math.abs(Math.min(segments[0].start[0], segments[0].end[0]) - 41) < 1e-6);
    assert.ok(Math.abs(Math.max(segments[0].start[0], segments[0].end[0]) - 59) < 1e-6);
  }
});

test("a tab wider than the perimeter protects the whole contour", () => {
  const path = { points: [[0, 0], [5, 0], [5, 5], [0, 5]], tabs: [[2, 0]], closed: true };
  assert.ok(app.buildTabSegments(path, 30).every((segment) => segment.isTab));
});
