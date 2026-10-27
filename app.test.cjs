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

function generate({ tabs = [{ pos: [50, 0] }], ignoreTabs = false, stepdown = 3, zeroX = 0, zeroY = 0, closed = true, ramping = false, rampAngle = 5, startDepth = 0, size = 100 } = {}) {
  const element = {
    uuid: "shape",
    points: [[0, 0], [size, 0], [size, size], [0, size]],
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
      start_depth: startDepth,
      enable_ramping: ramping,
      ramp_angle: rampAngle,
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

test("ramping descends in XYZ on every pass, returns, and finishes the full contour", () => {
  const result = generate({ tabs: [], ramping: true });
  const ramps = result.playbackSegments.filter((segment) => segment.motionType === "cut" && segment.end.z < segment.start.z);
  assert.equal(ramps.length, 6);
  assert.equal(ramps[0].start.z, 0);
  assert.ok(Math.abs(ramps[0].end.x - 3 / Math.tan(5 * Math.PI / 180)) < 1e-6);
  assert.equal(ramps[0].end.z, -3);
  assert.equal(ramps.at(-1).end.z, -16);
  for (const ramp of ramps) {
    assert.ok(ramp.endTimeSec - ramp.startTimeSec >= app.distance3D(ramp.start, ramp.end) / 400 * 60 - 1e-6);
    const index = result.playbackSegments.indexOf(ramp);
    const back = result.playbackSegments[index + 1];
    assert.equal(back.end.x, ramp.start.x);
    assert.equal(back.end.y, ramp.start.y);
    assert.equal(back.end.z, ramp.end.z);
    const finish = result.playbackSegments[index + 2];
    assert.equal(finish.end.x, 100);
    assert.equal(finish.start.z, ramp.end.z);
    assert.equal(finish.end.z, ramp.end.z);
  }
  assert.ok(result.gcode.includes("G1 X34.29 Z-3"));
  assert.ok(!result.playbackSegments.some((segment) => segment.motionType === "plunge" && segment.end.z < 0));
  assert.ok(!result.warnings.some((warning) => warning.includes("not implemented")));
  assert.ok(Number.isFinite(result.totalDurationSec));
});

test("short open and closed paths preserve the angle by shuttling along the contour", () => {
  for (const closed of [false, true]) {
    for (const rampAngle of [5, 20]) {
      const result = generate({ tabs: [], closed, ramping: true, rampAngle, size: 2, stepdown: 8 });
      const ramps = result.playbackSegments.filter((segment) => segment.motionType === "cut" && segment.end.z < segment.start.z);
      assert.ok(ramps.some((segment) => segment.end.x < segment.start.x || segment.end.y < segment.start.y));
      for (const ramp of ramps) {
        const distance = Math.hypot(ramp.end.x - ramp.start.x, ramp.end.y - ramp.start.y);
        assert.ok(Math.abs(Math.atan2(ramp.start.z - ramp.end.z, distance) * 180 / Math.PI - rampAngle) < 1e-6);
      }
      assert.ok(result.playbackSegments.every((segment) => segment.start.z >= -16 && segment.end.z >= -16));
      assert.ok(!result.playbackSegments.some((segment) => segment.motionType === "plunge" && segment.end.z < 0));
      assert.ok(result.playbackSegments.some((segment) => segment.end.z === -16));
      assert.ok(result.playbackSegments.every((segment) => segment.start.x >= 0 && segment.end.x <= 2 && segment.start.y >= 0 && segment.end.y <= 2));
    }
  }
});

test("ramping protects tabs at the entry and along the contour on open and closed paths", () => {
  for (const closed of [false, true]) {
    for (const tabs of [[{ pos: [0, 0] }], [{ pos: [50, 0] }]]) {
      const result = generate({ closed, tabs, ramping: true, stepdown: 8 });
      const tabSegments = result.previewPaths[0].paths[0].tabSegments;
      const cuts = result.playbackSegments.filter((segment) => segment.motionType === "cut");
      for (const cut of cuts) {
        for (const tab of tabSegments) {
          if (cut.start.y !== 0 || cut.end.y !== 0 || tab.start[1] !== 0) continue;
          const overlap = Math.min(Math.max(cut.start.x, cut.end.x), Math.max(tab.start[0], tab.end[0]))
            - Math.max(Math.min(cut.start.x, cut.end.x), Math.min(tab.start[0], tab.end[0]));
          if (overlap > 1e-6) {
            assert.ok(cut.start.z >= -13 && cut.end.z >= -13);
          }
        }
      }
      assert.ok(cuts.some((cut) => cut.end.z === -16));
    }
  }
});

test("disabled ramps preserve vertical entry and unsupported angles use 5 degrees", () => {
  assert.equal(generate({ rampAngle: 20 }).gcode, generate().gcode);
  for (const rampAngle of [undefined, 0, -5, 90, NaN, Infinity, "invalid"]) {
    assert.equal(generate({ ramping: true, rampAngle }).gcode, generate({ ramping: true }).gcode);
  }
  const result = generate({ ramping: true, startDepth: 5, tabs: [] });
  const firstRamp = result.playbackSegments.find((segment) => segment.motionType === "cut");
  assert.equal(firstRamp.start.z, 0);
  assert.equal(firstRamp.end.z, -8);
});

test("20 degree ramps are shorter and the last pass length follows the remaining depth", () => {
  for (const rampAngle of [5, 20]) {
    const result = generate({ tabs: [], ramping: true, rampAngle });
    const ramps = result.playbackSegments.filter((segment) => segment.motionType === "cut" && segment.end.z < segment.start.z);
    const slope = Math.tan(rampAngle * Math.PI / 180);
    assert.ok(Math.abs(ramps[0].end.x - 3 / slope) < 1e-6);
    assert.ok(Math.abs(ramps.at(-1).end.x - 1 / slope) < 1e-6);
  }
});

test("all five settings open the editor and entry icons include vertical and ramp modes", () => {
  let buttons = [];
  const container = {
    innerHTML: "",
    querySelectorAll(selector) {
      if (selector !== "[data-toolpath-edit]") return [];
      buttons = [...this.innerHTML.matchAll(/<button\b[^>]*data-toolpath-edit="([^"]+)"[^>]*>/g)].map((match) => ({
        getAttribute: () => match[1],
        addEventListener(event, listener) {
          assert.equal(event, "click");
          this.click = listener;
        },
      }));
      return buttons;
    },
  };
  const opened = [];
  const ui = vm.createContext({
    document: { getElementById: () => container },
    window: { initSqlJs: () => new Promise(() => {}) },
    console,
    opened,
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/app.js`, "utf8"), ui);
  vm.runInContext("openToolpathModal = (uuid) => opened.push(uuid)", ui);
  for (const angle of [0, 5, 20]) {
    ui.renderToolpaths({ toolpaths: [{ uuid: `path-${angle}`, enable_ramping: angle !== 0, ramp_angle: angle }] });
    assert.equal(buttons.length, 5);
    assert.equal((container.innerHTML.match(/aria-haspopup="dialog"/g) || []).length, 5);
    assert.ok(!container.innerHTML.includes(">EDIT<"));
    assert.ok(container.innerHTML.includes('class="toolpath-entry-icon"'));
    assert.ok(container.innerHTML.includes(`aria-label="Edit entry into material: ${angle ? `Ramp ${angle}°` : "Vertical"}"`));
    buttons.forEach((button) => button.click());
    assert.deepEqual(opened.splice(0), Array(5).fill(`path-${angle}`));
  }
});

test("simulation hides all static paths and reveals only elapsed cuts through pause, seek and replay", () => {
  const node = () => ({
    attributes: {}, children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {},
  });
  const ui = vm.createContext({
    document: { getElementById: node, createElementNS: node, createDocumentFragment: node },
    window: { initSqlJs: () => new Promise(() => {}), requestAnimationFrame: () => 1, cancelAnimationFrame() {} },
    console,
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/app.js`, "utf8"), ui);
  vm.runInContext("updatePlayerUI = () => {}; updatePreviewMarkers = () => {}", ui);
  const path = { points: [[0, 0], [10, 0]], tabSegments: [{ start: [4, 0], end: [6, 0] }] };
  const generated = {
    previewPaths: [{ color: "#0057d9", paths: [path] }],
    playbackSegments: [
      { motionType: "rapid", startTimeSec: 0, endTimeSec: 2, start: { x: 0, y: 0, z: 8 }, end: { x: 0, y: 0, z: 0 } },
      { motionType: "cut", color: "#0057d9", startTimeSec: 2, endTimeSec: 12, start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: -1 } },
      { motionType: "cut", color: "#e64500", startTimeSec: 12, endTimeSec: 22, start: { x: 10, y: 0, z: -1 }, end: { x: 10, y: 10, z: -1 } },
    ],
  };
  ui.generated = generated;
  const parsed = { document: { width: 100, height: 100, zeroX: 0, zeroY: 0 }, elements: [], toolpaths: [] };
  vm.runInContext("state.generated = generated; resetPlayback(22)", ui);
  ui.renderPreview(parsed, generated);
  const preview = vm.runInContext("state.previewRender", ui);
  const visibleCuts = () => preview.progressLayer.children[0].children;
  assert.equal(preview.staticPathsLayer.attributes.display, "inline");
  assert.equal(preview.staticPathsLayer.children.length, 2); // Full contour and holding-tab overlay.
  ui.togglePlayback();
  assert.equal(preview.staticPathsLayer.attributes.display, "none");
  assert.equal(visibleCuts().length, 0);
  ui.setPlaybackTime(1);
  assert.equal(visibleCuts().length, 0); // Rapid motions do not draw cuts.
  ui.setPlaybackTime(7);
  assert.equal(visibleCuts().length, 1);
  assert.equal(visibleCuts()[0].attributes.d, "M 0 0 L 5 0");
  ui.togglePlayback(); // Pause keeps the progressive view.
  assert.equal(preview.staticPathsLayer.attributes.display, "none");
  ui.stepPlayback(-5);
  assert.equal(visibleCuts().length, 0);
  ui.setPlaybackTime(22);
  assert.equal(visibleCuts().length, 2);
  ui.togglePlayback(); // Replay clears previously completed paths immediately.
  assert.equal(visibleCuts().length, 0);
  assert.equal(preview.staticPathsLayer.attributes.display, "none");
  ui.resetPlayback(22);
  ui.renderPreview(parsed, generated);
  assert.equal(vm.runInContext("state.previewRender.staticPathsLayer.attributes.display", ui), "inline");
});

test("simulated motions point to their exact G-code commands and line offsets", () => {
  const result = generate({ ramping: true });
  let previousLine = -1;
  for (const segment of result.playbackSegments) {
    const index = segment.gcodeLineIndex;
    assert.ok(index > previousLine);
    previousLine = index;
    const line = result.gcodeLines[index];
    assert.match(line, segment.motionType === "rapid" ? /^G0 / : /^G1 /);
    assert.equal(result.gcode.slice(result.gcodeLineOffsets[index], result.gcodeLineOffsets[index] + line.length), line);
    for (const axis of ["x", "y", "z"]) {
      const match = line.match(new RegExp(`${axis.toUpperCase()}(-?[\\d.]+)`));
      if (match) assert.ok(Math.abs(Number(match[1]) - segment.end[axis]) <= 0.000501);
      else assert.equal(segment.start[axis], segment.end[axis]);
    }
  }
});

test("G-code follows playback without taking focus, including seek, replay and completion", () => {
  const output = {
    style: {}, dataset: {}, clientHeight: 200,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
  const ui = vm.createContext({
    document: { getElementById: (id) => id === "gcode-output" ? output : {} },
    window: { initSqlJs: () => new Promise(() => {}), getComputedStyle: () => ({ lineHeight: "20px", paddingTop: "10px" }) },
    console,
    generated: generate({ ramping: true }),
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/app.js`, "utf8"), ui);
  vm.runInContext("state.generated = generated; state.playback.hasStarted = true", ui);
  for (const index of [0, 15, 4, 0]) {
    const generated = ui.generated;
    const segment = generated.playbackSegments[index];
    ui.time = (segment.startTimeSec + segment.endTimeSec) / 2;
    vm.runInContext("state.playback.currentTimeSec = time; updateGcodePosition()", ui);
    const lineIndex = segment.gcodeLineIndex;
    assert.equal(output.selectionStart, generated.gcodeLineOffsets[lineIndex]);
    assert.equal(output.selectionEnd - output.selectionStart, generated.gcodeLines[lineIndex].length);
    assert.ok(output.scrollTop >= 0);
    assert.ok(output.style.backgroundImage.includes("linear-gradient"));
    assert.equal(output.style.backgroundSize, "100% 20px");
    const expectedTop = 10 + lineIndex * 20 - output.scrollTop;
    assert.equal(output.style.backgroundPosition, `0 ${expectedTop}px`);
    output.scrollTop += 40;
    ui.updateGcodeHighlight();
    assert.equal(output.style.backgroundPosition, `0 ${expectedTop - 40}px`);
  }
  vm.runInContext("state.playback.currentTimeSec = generated.totalDurationSec; updateGcodePosition()", ui);
  assert.equal(ui.generated.gcode.slice(output.selectionStart, output.selectionEnd), "M30");
  vm.runInContext("state.playback.hasStarted = false; updateGcodePosition()", ui);
  assert.equal(output.selectionStart, 0);
  assert.equal(output.selectionEnd, 0);
  assert.equal(output.style.backgroundImage, "none");
  assert.equal(output.dataset.activeLine, undefined);
});

test("player timeline stays synchronized and seeking preserves playback except at the end", () => {
  const elements = new Map();
  const element = () => ({
    attributes: {}, style: { setProperty(name, value) { this[name] = value; } },
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const ui = vm.createContext({
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    } },
    window: { initSqlJs: () => new Promise(() => {}), requestAnimationFrame: () => 1, cancelAnimationFrame() {} },
    console,
    generated: generate(),
  });
  vm.runInContext(fs.readFileSync(`${__dirname}/app.js`, "utf8"), ui);
  vm.runInContext("updateGcodePosition = () => {}; updatePlaybackVisualization = () => {}; state.generated = generated; resetPlayback(generated.totalDurationSec)", ui);
  const slider = elements.get("playback-progress");
  assert.equal(slider.value, "0");
  assert.equal(slider.disabled, false);
  assert.equal(Number(slider.max), ui.generated.totalDurationSec);
  ui.togglePlayback();
  assert.equal(elements.get("play-pause-btn").attributes["aria-label"], "Pause");
  const half = ui.generated.totalDurationSec / 2;
  ui.seekPlayback(String(half));
  assert.equal(Number(slider.value), half);
  assert.equal(slider.style["--progress"], "50%");
  assert.equal(vm.runInContext("state.playback.isPlaying", ui), true);
  assert.equal(vm.runInContext("state.playback.lastFrameTime", ui), 0);
  assert.equal(slider.attributes["aria-valuetext"], elements.get("time-indicator").textContent);
  ui.seekPlayback(0);
  assert.equal(vm.runInContext("state.playback.isPlaying", ui), true);
  ui.seekPlayback(Infinity); // Invalid slider input is safely reset.
  assert.equal(slider.value, "0");
  ui.seekPlayback(ui.generated.totalDurationSec + 10);
  assert.equal(slider.style["--progress"], "100%");
  assert.equal(vm.runInContext("state.playback.isPlaying", ui), false);
  assert.equal(elements.get("play-pause-btn").attributes["aria-label"], "Play");
  ui.seekPlayback(half);
  assert.equal(vm.runInContext("state.playback.isPlaying", ui), false);
  vm.runInContext("state.generated = null; resetPlayback()", ui);
  assert.equal(slider.disabled, true);
  assert.equal(slider.value, "0");
});
