const LIB_SQL_WASM_BASE = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/";
const PREVIEW_COLORS = [
  "#4fd1c5",
  "#7aa2ff",
  "#ff9f6e",
  "#f7768e",
  "#9ece6a",
  "#bb9af7",
  "#e0af68",
  "#73daca",
];
const SVG_NS = "http://www.w3.org/2000/svg";
const CLIPPER_SCALE = 100000;
const RAPID_RATE_MM_PER_MIN = 3000;

const state = {
  sql: null,
  parsed: null,
  generated: null,
  fileName: "",
  nextToolpathColorIndex: 0,
  activeToolpathUUID: null,
  previewRender: null,
  playback: {
    currentTimeSec: 0,
    totalTimeSec: 0,
    speed: 1,
    isPlaying: false,
    rafId: null,
    lastFrameTime: 0,
  },
};

const refs = {
  uploadView: document.getElementById("upload-view"),
  resultView: document.getElementById("result-view"),
  fileInput: document.getElementById("file-input"),
  status: document.getElementById("status"),
  summary: document.getElementById("summary"),
  toolpaths: document.getElementById("toolpaths"),
  preview: document.getElementById("preview"),
  player: document.getElementById("player"),
  rewindBtn: document.getElementById("rewind-btn"),
  playPauseBtn: document.getElementById("play-pause-btn"),
  forwardBtn: document.getElementById("forward-btn"),
  speedSelect: document.getElementById("speed-select"),
  timeIndicator: document.getElementById("time-indicator"),
  output: document.getElementById("gcode-output"),
  downloadBtn: document.getElementById("download-btn"),
  toolpathModal: document.getElementById("toolpath-modal"),
  toolpathModalTitle: document.getElementById("toolpath-modal-title"),
  toolpathModalCancel: document.getElementById("toolpath-modal-cancel"),
  toolpathModalForm: document.getElementById("toolpath-modal-form"),
  toolpathFeedrate: document.getElementById("toolpath-feedrate"),
  toolpathPlungerate: document.getElementById("toolpath-plungerate"),
  toolpathStepdown: document.getElementById("toolpath-stepdown"),
  toolpathRpm: document.getElementById("toolpath-rpm"),
};

bootstrap().catch((error) => {
  console.error(error);
  setStatus(`Initialization error: ${error.message}`, true);
});

async function bootstrap() {
  state.sql = await window.initSqlJs({
    locateFile: (file) => `${LIB_SQL_WASM_BASE}${file}`,
  });

  refs.fileInput.addEventListener("change", handleFileSelection);
  refs.downloadBtn.addEventListener("click", downloadGcode);
  refs.rewindBtn.addEventListener("click", () => stepPlayback(-5));
  refs.playPauseBtn.addEventListener("click", togglePlayback);
  refs.forwardBtn.addEventListener("click", () => stepPlayback(5));
  refs.speedSelect.addEventListener("change", () => {
    state.playback.speed = toNumber(refs.speedSelect.value, 1);
  });
  refs.toolpathModalCancel.addEventListener("click", closeToolpathModal);
  refs.toolpathModal.addEventListener("click", (event) => {
    if (event.target.hasAttribute("data-modal-close")) {
      closeToolpathModal();
    }
  });
  refs.toolpathModalForm.addEventListener("submit", applyToolpathSettings);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !refs.toolpathModal.classList.contains("hidden")) {
      closeToolpathModal();
    }
  });
  updatePlayerUI();
}

async function handleFileSelection(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    state.fileName = file.name;
    state.nextToolpathColorIndex = 0;
    setStatus(`Reading ${file.name}...`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.parsed = await parseC2D(bytes, file.name);
    regenerate();
    setStatus(`Conversion completed for ${file.name}.`);
  } catch (error) {
    console.error(error);
    state.parsed = null;
    state.generated = null;
    refs.output.value = "";
    refs.downloadBtn.disabled = true;
    refs.uploadView.classList.remove("hidden");
    refs.resultView.classList.add("hidden");
    renderSummary(null);
    renderToolpaths(null);
    renderPreview(null, null);
    resetPlayback();
    setStatus(`Conversion failed: ${error.message}`, true);
  }
}

function regenerate() {
  const generated = generateGcode(state.parsed, state.fileName);
  state.generated = generated;
  resetPlayback(generated.totalDurationSec);
  refs.output.value = generated.gcode;
  refs.downloadBtn.disabled = false;
  renderSummary(state.parsed, generated);
  renderToolpaths(state.parsed);
  renderPreview(state.parsed, generated);
  refs.uploadView.classList.add("hidden");
  refs.resultView.classList.remove("hidden");
}

function toggleToolpathVisibility(toolpathUUID) {
  if (!state.parsed) {
    return;
  }
  const toolpath = state.parsed.toolpaths.find((entry) => entry.uuid === toolpathUUID);
  if (!toolpath) {
    return;
  }
  toolpath.visible = toolpath.visible === false ? true : false;
  regenerate();
}

function updateSafeZ(value) {
  if (!state.parsed) {
    return;
  }
  state.parsed.document.safeZ = sanitizePositiveNumber(value, 8);
  regenerate();
}

function openToolpathModal(toolpathUUID) {
  if (!state.parsed) {
    return;
  }
  const toolpath = state.parsed.toolpaths.find((entry) => entry.uuid === toolpathUUID);
  if (!toolpath) {
    return;
  }
  state.activeToolpathUUID = toolpathUUID;
  refs.toolpathModalTitle.textContent = toolpath.name || toolpath.uuid;
  refs.toolpathFeedrate.value = formatNumber(sanitizePositiveNumber(toolpath.speeds?.feedrate, 1));
  refs.toolpathPlungerate.value = formatNumber(sanitizePositiveNumber(toolpath.speeds?.plungerate, sanitizePositiveNumber(toolpath.speeds?.feedrate, 1)));
  refs.toolpathStepdown.value = formatNumber(Math.max(0.001, sanitizePositiveNumber(toolpath.stepdown, 0.001)));
  refs.toolpathRpm.value = String(Math.max(0, Math.round(toNumber(toolpath.speeds?.rpm, 0))));
  refs.toolpathModal.classList.remove("hidden");
}

function closeToolpathModal() {
  refs.toolpathModal.classList.add("hidden");
  state.activeToolpathUUID = null;
}

function applyToolpathSettings(event) {
  event.preventDefault();
  if (!state.parsed || !state.activeToolpathUUID) {
    return;
  }
  const toolpath = state.parsed.toolpaths.find((entry) => entry.uuid === state.activeToolpathUUID);
  if (!toolpath) {
    closeToolpathModal();
    return;
  }
  toolpath.speeds = toolpath.speeds || {};
  toolpath.speeds.feedrate = sanitizePositiveNumber(refs.toolpathFeedrate.value, sanitizePositiveNumber(toolpath.speeds.feedrate, 1));
  toolpath.speeds.plungerate = sanitizePositiveNumber(refs.toolpathPlungerate.value, toolpath.speeds.feedrate);
  toolpath.stepdown = Math.max(0.001, sanitizePositiveNumber(refs.toolpathStepdown.value, Math.max(toNumber(toolpath.stepdown, 0.001), 0.001)));
  toolpath.speeds.rpm = Math.max(0, Math.round(toNumber(refs.toolpathRpm.value, toNumber(toolpath.speeds.rpm, 0))));
  closeToolpathModal();
  regenerate();
}

function resetPlayback(totalTimeSec = 0) {
  stopPlayback();
  state.playback.currentTimeSec = 0;
  state.playback.totalTimeSec = Math.max(0, totalTimeSec);
  state.playback.lastFrameTime = 0;
  updatePlayerUI();
}

function togglePlayback() {
  if (!state.generated || state.playback.totalTimeSec <= 0) {
    return;
  }
  if (state.playback.isPlaying) {
    stopPlayback();
  } else {
    if (state.playback.currentTimeSec >= state.playback.totalTimeSec) {
      state.playback.currentTimeSec = 0;
    }
    state.playback.isPlaying = true;
    state.playback.lastFrameTime = 0;
    state.playback.rafId = window.requestAnimationFrame(playbackFrame);
    updatePlayerUI();
  }
}

function stopPlayback() {
  if (state.playback.rafId !== null) {
    window.cancelAnimationFrame(state.playback.rafId);
    state.playback.rafId = null;
  }
  state.playback.isPlaying = false;
  state.playback.lastFrameTime = 0;
  updatePlayerUI();
}

function stepPlayback(deltaSec) {
  if (!state.generated) {
    return;
  }
  stopPlayback();
  setPlaybackTime(state.playback.currentTimeSec + deltaSec);
}

function playbackFrame(timestamp) {
  if (!state.playback.isPlaying) {
    return;
  }
  if (!state.playback.lastFrameTime) {
    state.playback.lastFrameTime = timestamp;
  }
  const elapsedSec = ((timestamp - state.playback.lastFrameTime) / 1000) * state.playback.speed;
  state.playback.lastFrameTime = timestamp;
  setPlaybackTime(state.playback.currentTimeSec + elapsedSec);
  if (state.playback.currentTimeSec >= state.playback.totalTimeSec) {
    stopPlayback();
    return;
  }
  state.playback.rafId = window.requestAnimationFrame(playbackFrame);
}

function setPlaybackTime(nextTimeSec) {
  state.playback.currentTimeSec = clamp(nextTimeSec, 0, state.playback.totalTimeSec);
  updatePlayerUI();
  updatePlaybackVisualization();
}

function updatePlayerUI() {
  refs.player.classList.toggle("hidden", !state.generated);
  refs.playPauseBtn.textContent = state.playback.isPlaying ? "Pause" : "Play";
  refs.playPauseBtn.setAttribute("aria-label", state.playback.isPlaying ? "Pause" : "Play");
  refs.timeIndicator.textContent = `${formatDuration(state.playback.currentTimeSec)} / ${formatDuration(state.playback.totalTimeSec)}`;
}

async function parseC2D(bytes, fileName) {
  if (looksLikeSQLite(bytes)) {
    return parseSQLiteC2D(bytes, fileName);
  }
  return parseEmbeddedJsonC2D(bytes, fileName);
}

function looksLikeSQLite(bytes) {
  const header = new TextDecoder().decode(bytes.slice(0, 16));
  return header === "SQLite format 3\u0000";
}

function parseSQLiteC2D(bytes, fileName) {
  const db = new state.sql.Database(bytes);
  const params = rowsToMap(execRows(db, "SELECT key, value FROM params"));
  const itemRows = execRows(db, "SELECT id, uuid, name, type, version, data FROM items ORDER BY id");
  const elements = [];
  const elementsByUuid = new Map();
  const toolpaths = [];
  const warnings = [];

  for (const row of itemRows) {
    const [id, uuid, name, type, version, data] = row;
    if (!(data instanceof Uint8Array)) {
      continue;
    }

    const payload = decodeItemPayload(data);
    if (payload == null) {
      if (type !== "model") {
        warnings.push(`Item ${id} (${type}/${name || "unnamed"}) ignored: payload is not JSON.`);
      }
      continue;
    }

    if (type === "element") {
      const element = {
        ...payload,
        __containerType: "sqlite",
        __itemType: type,
        __itemName: name,
        __version: version,
        uuid: payload.id || uuid || `item-${id}`,
      };
      elements.push(element);
      elementsByUuid.set(element.uuid, element);
      continue;
    }

    if (type === "toolpath") {
      toolpaths.push({
        ...payload,
        uuid: payload.uuid || uuid || `toolpath-${id}`,
        __itemName: name,
        visible: payload.enabled !== false,
        color: PREVIEW_COLORS[state.nextToolpathColorIndex++ % PREVIEW_COLORS.length],
      });
    }
  }

  db.close();

  return {
    fileName,
    sourceType: "sqlite-c2d",
    document: {
      width: toNumber(params.width, 0),
      height: toNumber(params.height, 0),
      thickness: toNumber(params.thickness, 0),
      zeroX: toNumber(params.zero_x, 0),
      zeroY: toNumber(params.zero_y, 0),
      zeroZ: toNumber(params.zero_z, 0),
      safeZ: toNumber(params.retract, 8),
      displayMm: params.display_mm !== "0",
      material: params.material || "",
      machine: params.machine || "",
      buildNum: params.build_num || "",
    },
    params,
    elements,
    elementsByUuid,
    toolpaths,
    parseWarnings: warnings,
  };
}

function parseEmbeddedJsonC2D(bytes, fileName) {
  const json = extractJsonObjectFromBytes(bytes);
  const doc = json.DOCUMENT_VALUES || {};
  const elements = [];
  const elementsByUuid = new Map();
  let syntheticCounter = 0;

  const push = (element) => {
    const uuid = element.id || element.uuid || `legacy-${syntheticCounter++}`;
    const normalized = {
      ...element,
      uuid,
      __containerType: "legacy-json",
    };
    elements.push(normalized);
    elementsByUuid.set(uuid, normalized);
  };

  for (const circle of json.CIRCLE_OBJECTS || []) {
    push({ ...circle, geometryType: "circle" });
  }
  for (const curve of json.CURVE_OBJECTS || []) {
    push({ ...curve, geometryType: "curve" });
  }
  for (const rect of json.RECT_OBJECTS || []) {
    push({ ...rect, geometryType: "rectangle" });
  }
  for (const poly of json.REGULAR_POLYGON_OBJECTS || []) {
    push({ ...poly, geometryType: "regularPolygon" });
  }
  for (const textObject of json.TEXT_OBJECTS || []) {
    push({ ...textObject, geometryType: "text" });
  }

  const toolpaths = elements.map((element, index) => ({
    type: "contour",
    name: `Contour ${index + 1}`,
    uuid: `legacy-toolpath-${index + 1}`,
    enabled: true,
    visible: true,
    color: PREVIEW_COLORS[state.nextToolpathColorIndex++ % PREVIEW_COLORS.length],
    ofset_dir: 0,
    elements: [{ uuid: element.uuid }],
  }));

  return {
    fileName,
    sourceType: "legacy-json-c2d",
    document: {
      width: toNumber(doc.WIDTH, 0),
      height: toNumber(doc.HEIGHT, 0),
      thickness: toNumber(doc.THICKNESS, 0),
      zeroX: toNumber(doc.ZERO_X, 0),
      zeroY: toNumber(doc.ZERO_Y, 0),
      zeroZ: toNumber(doc.ZERO_Z, 0),
      safeZ: 8,
      displayMm: true,
      material: "",
      machine: "",
      buildNum: "legacy-json",
    },
    params: doc,
    elements,
    elementsByUuid,
    toolpaths,
    parseWarnings: [
      "Legacy JSON file detected: toolpaths were not present, so one centerline contour per geometry was generated.",
    ],
  };
}

function decodeItemPayload(blob) {
  const decoder = new TextDecoder();
  const attempts = [
    () => decoder.decode(window.pako.inflate(blob)),
    () => decoder.decode(blob),
  ];

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt());
    } catch {
      // Continue.
    }
  }
  return null;
}

function extractJsonObjectFromBytes(bytes) {
  const start = bytes.indexOf(0x7b);
  if (start === -1) {
    throw new Error("No usable JSON was found in the file.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < bytes.length; index += 1) {
    const char = bytes[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === 0x5c) {
        escaped = true;
        continue;
      }
      if (char === 0x22) {
        inString = false;
      }
      continue;
    }

    if (char === 0x22) {
      inString = true;
      continue;
    }
    if (char === 0x7b) {
      depth += 1;
      continue;
    }
    if (char === 0x7d) {
      depth -= 1;
      if (depth === 0) {
        const text = new TextDecoder().decode(bytes.slice(start, index + 1));
        return JSON.parse(text);
      }
    }
  }

  throw new Error("JSON appears truncated or the end of the document could not be found.");
}

function execRows(db, sql) {
  const result = db.exec(sql);
  return result.length ? result[0].values : [];
}

function rowsToMap(rows) {
  const output = {};
  for (const [key, value] of rows) {
    output[key] = value;
  }
  return output;
}

function generateGcode(parsed, fileName) {
  const warnings = [...parsed.parseWarnings];
  const previewPaths = [];
  const playbackSegments = [];
  const lines = [];
  const safeZ = sanitizePositiveNumber(parsed.document.safeZ, 8);
  const zeroX = toNumber(parsed.document.zeroX, 0);
  const zeroY = toNumber(parsed.document.zeroY, 0);
  const activeToolpaths = (parsed.toolpaths || []).filter((toolpath) => toolpath.enabled !== false && toolpath.visible !== false);
  let motionState = { x: 0, y: 0, z: safeZ, timeSec: 0 };

  lines.push(`(Generated from ${fileName || parsed.fileName || "input.c2d"})`);
  lines.push(`(Source type: ${parsed.sourceType})`);
  lines.push("G21");
  lines.push("G90");
  lines.push("G17");
  lines.push("G94");
  lines.push("G54");
  lines.push(`G0 Z${formatNumber(safeZ)}`);

  let currentSpindle = null;
  let currentFeedRate = null;
  let cutCount = 0;
  let skippedToolpaths = 0;

  function emitRapid(target, color) {
    const next = {
      x: target.x ?? motionState.x,
      y: target.y ?? motionState.y,
      z: target.z ?? motionState.z,
    };
    const parts = [];
    if (!numbersEqual(next.x, motionState.x)) parts.push(`X${formatNumber(next.x)}`);
    if (!numbersEqual(next.y, motionState.y)) parts.push(`Y${formatNumber(next.y)}`);
    if (!numbersEqual(next.z, motionState.z)) parts.push(`Z${formatNumber(next.z)}`);
    if (!parts.length) {
      return;
    }
    lines.push(`G0 ${parts.join(" ")}`);
    motionState = appendPlaybackMotion(playbackSegments, motionState, next, RAPID_RATE_MM_PER_MIN, "rapid", color);
  }

  function emitFeedChange(rate) {
    if (numbersEqual(currentFeedRate, rate)) {
      return;
    }
    lines.push(`G1 F${formatNumber(rate)}`);
    currentFeedRate = rate;
  }

  function emitPlunge(z, rate, color) {
    if (numbersEqual(z, motionState.z)) {
      return;
    }
    const command = currentFeedRate === null || !numbersEqual(currentFeedRate, rate)
      ? `G1 Z${formatNumber(z)} F${formatNumber(rate)}`
      : `G1 Z${formatNumber(z)}`;
    lines.push(command);
    currentFeedRate = rate;
    motionState = appendPlaybackMotion(playbackSegments, motionState, {
      x: motionState.x,
      y: motionState.y,
      z,
    }, rate, "plunge", color);
  }

  function emitCut(point, rate, color) {
    const [x, y] = point;
    const parts = [];
    if (!numbersEqual(x, motionState.x)) parts.push(`X${formatNumber(x)}`);
    if (!numbersEqual(y, motionState.y)) parts.push(`Y${formatNumber(y)}`);
    if (!parts.length) {
      return;
    }
    emitFeedChange(rate);
    lines.push(`G1 ${parts.join(" ")}`);
    motionState = appendPlaybackMotion(playbackSegments, motionState, {
      x,
      y,
      z: motionState.z,
    }, rate, "cut", color);
  }

  for (const toolpath of activeToolpaths) {
    if ((toolpath.type || "contour") !== "contour") {
      skippedToolpaths += 1;
      warnings.push(`Toolpath "${toolpath.name || toolpath.uuid}" ignored: type ${toolpath.type} is not supported yet.`);
      continue;
    }

    const toolRadius = Math.max(toNumber(toolpath.tool?.diameter, 0) / 2, 0);
    const stockToLeave = Math.max(toNumber(toolpath.stock_to_leave, 0), 0);
    const offsetDirection = normalizeOffsetDirection(toolpath.ofset_dir);
    const offsetAmount = offsetDirection === 0 ? 0 : toolRadius + stockToLeave;
    const feed = sanitizePositiveNumber(toolpath.speeds?.feedrate, 1);
    const plunge = sanitizePositiveNumber(toolpath.speeds?.plungerate, feed);
    const spindle = Math.max(0, Math.round(sanitizePositiveNumber(toolpath.speeds?.rpm, 0)));
    const startDepth = Math.max(0, toNumber(toolpath.start_depth, 0));
    const endDepth = Math.max(startDepth, toNumber(toolpath.end_depth, startDepth));
    const stepdown = Math.max(0.001, sanitizePositiveNumber(toolpath.stepdown, Math.max(endDepth - startDepth, 0.001)));
    const depthPasses = buildDepthPasses(startDepth, endDepth, stepdown);
    const tabWidth = Math.max(0, toNumber(toolpath.tab_width, 0));
    const tabHeight = Math.max(0, toNumber(toolpath.tab_height, 0));
    const useTabs = !toolpath.ignore_tabs && tabWidth > 0 && tabHeight > 0;
    const elementRefs = toolpath.elements || [];
    const resolvedPaths = [];

    if (!elementRefs.length) {
      warnings.push(`Toolpath "${toolpath.name || toolpath.uuid}" ignored: no referenced geometry.`);
      continue;
    }

    for (const elementRef of elementRefs) {
      const element = parsed.elementsByUuid.get(elementRef.uuid);
      if (!element) {
        warnings.push(`Element ${elementRef.uuid} was not found for toolpath "${toolpath.name || toolpath.uuid}".`);
        continue;
      }
      const elementPaths = elementToPolylines(element, 0.2, warnings);
      for (const path of elementPaths) {
        const transformed = translateForWorkZero(path, zeroX, zeroY);
        const offsetPaths = offsetAmount > 0 ? offsetClosedPath(transformed, offsetAmount, offsetDirection, warnings, toolpath.name || toolpath.uuid) : [transformed];
        for (const offsetPath of offsetPaths) {
          resolvedPaths.push({
            ...offsetPath,
            tabs: useTabs ? (element.tabs || []).map((tab) => tab.pos)
              .filter((pos) => Array.isArray(pos) && pos.length === 2 && pos.every(Number.isFinite))
              .map(([x, y]) => [x - zeroX, y - zeroY]) : [],
          });
        }
      }
    }

    if (!resolvedPaths.length) {
      warnings.push(`Toolpath "${toolpath.name || toolpath.uuid}" ignored: no machinable path could be generated.`);
      continue;
    }

    const optimizedPaths = optimizePathSequence(resolvedPaths, [motionState.x, motionState.y]);

    if (spindle !== currentSpindle) {
      currentSpindle = spindle;
      if (spindle > 0) {
        lines.push(`M3 S${spindle}`);
      }
    }

    lines.push(`(Toolpath: ${toolpath.name || toolpath.uuid})`);
    lines.push(`(Offset: ${offsetDirectionLabel(offsetDirection)}, start ${formatNumber(startDepth)}mm, end ${formatNumber(endDepth)}mm, stepdown ${formatNumber(stepdown)}mm)`);

    if (toolpath.enable_ramping) {
      warnings.push(`Toolpath "${toolpath.name || toolpath.uuid}": ramping was requested but is not implemented yet, so a vertical plunge was used.`);
    }

    previewPaths.push({
      name: toolpath.name || toolpath.uuid,
      color: toolpath.color || PREVIEW_COLORS[0],
      paths: optimizedPaths,
    });

    for (const path of optimizedPaths) {
      if (path.points.length < 2) {
        continue;
      }
      const startPoint = path.points[0];
      // Include the cutter diameter so the remaining material has the requested tab width.
      const tabSegments = path.tabs.length ? buildTabSegments(path, tabWidth + toolRadius * 2) : [];
      const tabDepth = Math.max(0, endDepth - tabHeight);
      path.tabSegments = tabSegments.filter((segment) => segment.isTab);
      emitRapid({ z: safeZ }, toolpath.color);
      emitRapid({ x: startPoint[0], y: startPoint[1] }, toolpath.color);

      for (const [passIndex, passDepth] of depthPasses.entries()) {
        if (passIndex > 0 && !path.closed) {
          emitRapid({ z: safeZ }, toolpath.color);
          emitRapid({ x: startPoint[0], y: startPoint[1] }, toolpath.color);
        }
        cutCount += 1;
        if (tabSegments.length && passDepth > tabDepth) {
          for (const segment of tabSegments) {
            const depth = segment.isTab ? tabDepth : passDepth;
            emitPlunge(-depth, plunge, toolpath.color);
            emitCut(segment.end, feed, toolpath.color);
          }
        } else {
          emitPlunge(-passDepth, plunge, toolpath.color);
          for (let index = 1; index < path.points.length; index += 1) {
            emitCut(path.points[index], feed, toolpath.color);
          }
          if (path.closed) {
            emitCut(startPoint, feed, toolpath.color);
          }
        }
      }

      emitRapid({ z: safeZ }, toolpath.color);
    }
  }

  emitRapid({ x: 0, y: 0 }, null);
  emitRapid({ z: safeZ }, null);
  if (currentSpindle !== null && currentSpindle > 0) {
    lines.push("M5");
  }
  lines.push("M30");

  if (!cutCount) {
    warnings.push("No cuts were generated. Check the toolpath types present in the file.");
  }
  if (skippedToolpaths > 0) {
    warnings.push(`${skippedToolpaths} non-contour toolpath(s) were ignored.`);
  }

  return {
    gcode: lines.join("\n"),
    warnings: uniqueStrings(warnings),
    previewPaths,
    playbackSegments,
    totalDurationSec: motionState.timeSec,
    stats: {
      activeToolpaths: activeToolpaths.length,
      generatedPaths: previewPaths.reduce((count, item) => count + item.paths.length, 0),
      cutCount,
      safeZ,
    },
  };
}

function buildTabSegments(path, width) {
  const edges = [];
  let length = 0;
  const edgeCount = path.closed ? path.points.length : path.points.length - 1;
  for (let index = 0; index < edgeCount; index += 1) {
    const start = path.points[index];
    const end = path.points[(index + 1) % path.points.length];
    const edgeLength = pointDistance(start, end);
    if (edgeLength > 1e-6) {
      edges.push({ start, end, offset: length, length: edgeLength });
      length += edgeLength;
    }
  }

  const intervals = [];
  for (const center of path.tabs || []) {
    let nearestDistance = Infinity;
    let position = 0;
    for (const edge of edges) {
      const dx = edge.end[0] - edge.start[0];
      const dy = edge.end[1] - edge.start[1];
      const t = clamp(((center[0] - edge.start[0]) * dx + (center[1] - edge.start[1]) * dy) / edge.length ** 2, 0, 1);
      const distance = pointDistance(center, [edge.start[0] + t * dx, edge.start[1] + t * dy]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        position = edge.offset + t * edge.length;
      }
    }
    if (path.closed && width >= length) {
      intervals.push([0, length]);
    } else {
      const start = position - width / 2;
      const end = position + width / 2;
      intervals.push([Math.max(0, start), Math.min(length, end)]);
      if (path.closed && start < 0) intervals.push([length + start, length]);
      if (path.closed && end > length) intervals.push([0, end - length]);
    }
  }

  const segments = [];
  for (const edge of edges) {
    const boundaries = [edge.offset, edge.offset + edge.length];
    for (const interval of intervals) {
      for (const boundary of interval) {
        if (boundary > edge.offset && boundary < edge.offset + edge.length) {
          boundaries.push(boundary);
        }
      }
    }
    boundaries.sort((a, b) => a - b);
    const pointAt = (distance) => {
      const t = (distance - edge.offset) / edge.length;
      return [edge.start[0] + t * (edge.end[0] - edge.start[0]), edge.start[1] + t * (edge.end[1] - edge.start[1])];
    };
    for (let index = 1; index < boundaries.length; index += 1) {
      const start = boundaries[index - 1];
      const end = boundaries[index];
      if (end - start <= 1e-6) continue;
      const middle = (start + end) / 2;
      segments.push({
        start: pointAt(start),
        end: pointAt(end),
        isTab: intervals.some(([from, to]) => middle >= from && middle <= to),
      });
    }
  }
  return segments;
}

function translateForWorkZero(path, zeroX, zeroY) {
  return {
    ...path,
    points: path.points.map(([x, y]) => [x - zeroX, y - zeroY]),
  };
}

function elementToPolylines(element, tolerance, warnings) {
  if (Array.isArray(element.rendered) && element.rendered.length) {
    return normalizePaths(renderedTextToPaths(element));
  }

  if (Array.isArray(element.points) && Array.isArray(element.point_type) && Array.isArray(element.cp1) && Array.isArray(element.cp2)) {
    return normalizePaths([genericCurveElementToPath(element, tolerance)].filter(Boolean));
  }

  if (Array.isArray(element.points) && Array.isArray(element.point_type) && Array.isArray(element.control_point_1) && Array.isArray(element.control_point_2)) {
    return normalizePaths([legacyCurveElementToPath(element, tolerance)].filter(Boolean));
  }

  switch (element.geometryType) {
    case "circle":
      return normalizePaths([circleToPath(element)]);
    case "regularPolygon":
      return normalizePaths([regularPolygonToPath(element)]);
    case "rectangle":
      return normalizePaths([legacyRectangleToPath(element, tolerance, warnings)]);
    default:
      warnings.push(`Geometry ${element.geometryType || "unknown"} (${element.uuid}) is not supported.`);
      return [];
  }
}

function genericCurveElementToPath(element, tolerance) {
  const points = element.points || [];
  const pointTypes = element.point_type || [];
  const cp1 = element.cp1 || [];
  const cp2 = element.cp2 || [];
  const position = element.position || [0, 0];
  const isClosed = pointTypes[pointTypes.length - 1] === 4;
  const effectiveCount = isClosed ? pointTypes.length - 1 : pointTypes.length;
  if (effectiveCount < 2 || points.length < 2) {
    return null;
  }

  const output = [addPoints(points[0], position)];
  for (let index = 1; index < effectiveCount; index += 1) {
    const segmentType = pointTypes[index];
    const target = addPoints(points[index], position);
    if (segmentType === 3) {
      const start = output[output.length - 1];
      const handle1 = addPoints(cp1[index] || points[index - 1], position);
      const handle2 = addPoints(cp2[index] || points[index], position);
      appendFlattenedCubic(output, start, handle1, handle2, target, tolerance);
    } else {
      output.push(target);
    }
  }

  return {
    closed: isClosed,
    points: dedupeSequentialPoints(output, 1e-6),
    source: element.uuid,
  };
}

function legacyCurveElementToPath(element, tolerance) {
  const points = element.points || [];
  const pointTypes = element.point_type || [];
  const handles1 = element.control_point_1 || [];
  const handles2 = element.control_point_2 || [];
  const position = element.position || [0, 0];
  const isClosed = pointTypes[pointTypes.length - 1] === 4;
  const effectiveCount = isClosed ? pointTypes.length - 1 : pointTypes.length;
  if (effectiveCount < 2 || points.length < 2) {
    return null;
  }

  const output = [addPoints(points[0], position)];
  for (let index = 1; index < effectiveCount; index += 1) {
    const previousType = pointTypes[index - 1];
    const target = addPoints(points[index], position);
    if (previousType === 3) {
      const start = output[output.length - 1];
      const handle1 = addPoints(handles2[index - 1] || points[index - 1], position);
      const handle2 = addPoints(handles1[index] || points[index], position);
      appendFlattenedCubic(output, start, handle1, handle2, target, tolerance);
    } else if (previousType === 1 || previousType === 0) {
      output.push(target);
    }
  }

  if (isClosed && pointTypes[0] === 3 && points.length > 1) {
    const start = output[output.length - 1];
    const target = addPoints(points[0], position);
    const handle1 = addPoints(handles2[effectiveCount - 1] || points[effectiveCount - 1], position);
    const handle2 = addPoints(handles1[0] || points[0], position);
    appendFlattenedCubic(output, start, handle1, handle2, target, tolerance);
  }

  return {
    closed: isClosed,
    points: dedupeSequentialPoints(output, 1e-6),
    source: element.uuid,
  };
}

function renderedTextToPaths(element) {
  const transform = element.transform;
  const position = element.position || [0, 0];
  return element.rendered
    .filter((subpath) => Array.isArray(subpath) && subpath.length > 1)
    .map((subpath) => {
      const points = subpath.map((point) => {
        const translated = addPoints(point, position);
        return applyTransform(translated, transform);
      });
      return {
        closed: true,
        points: dedupeSequentialPoints(points, 1e-6),
        source: element.uuid,
      };
    });
}

function applyTransform(point, transform) {
  if (!Array.isArray(transform) || transform.length !== 9) {
    return point;
  }
  const [m00, m01, , m10, m11, , tx, ty] = transform;
  return [
    point[0] * m00 + point[1] * m10 + tx,
    point[0] * m01 + point[1] * m11 + ty,
  ];
}

function circleToPath(element) {
  const [cx, cy] = element.position || [0, 0];
  const radius = Math.max(0.001, toNumber(element.radius, 0));
  const steps = Math.max(24, Math.ceil((2 * Math.PI * radius) / 2));
  const points = [];
  for (let index = 0; index < steps; index += 1) {
    const angle = (Math.PI * 2 * index) / steps;
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  return {
    closed: true,
    points,
    source: element.uuid,
  };
}

function regularPolygonToPath(element) {
  const [cx, cy] = element.position || [0, 0];
  const sides = Math.max(3, Math.round(toNumber(element.num_sides, 3)));
  const radius = Math.max(0.001, toNumber(element.radius, 0));
  const rotation = degreesToRadians(toNumber(element.rotation, 0));
  const points = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = rotation + (Math.PI * 2 * index) / sides;
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  return {
    closed: true,
    points,
    source: element.uuid,
  };
}

function legacyRectangleToPath(element, tolerance, warnings) {
  const [cx, cy] = element.position || [0, 0];
  const width = Math.max(0.001, toNumber(element.width, 0));
  const height = Math.max(0.001, toNumber(element.height, 0));
  const radius = Math.max(0, toNumber(element.radius, 0));
  const cornerType = toNumber(element.corner_type, 0);
  if (cornerType > 0 && radius > 0) {
    warnings.push(`Legacy rectangle ${element.uuid}: special corners were simplified as rounded polylines.`);
  }

  const halfW = width / 2;
  const halfH = height / 2;
  const effectiveRadius = Math.min(radius, halfW, halfH);
  const points = [];
  if (effectiveRadius <= 0) {
    points.push(
      [cx + halfW, cy + halfH],
      [cx + halfW, cy - halfH],
      [cx - halfW, cy - halfH],
      [cx - halfW, cy + halfH],
    );
  } else {
    const arcSegments = Math.max(4, Math.ceil((Math.PI * effectiveRadius / 2) / Math.max(0.2, tolerance)));
    appendArcPoints(points, [cx + halfW - effectiveRadius, cy + halfH - effectiveRadius], effectiveRadius, 0, -Math.PI / 2, arcSegments);
    appendArcPoints(points, [cx + halfW - effectiveRadius, cy - halfH + effectiveRadius], effectiveRadius, -Math.PI / 2, -Math.PI, arcSegments, true);
    appendArcPoints(points, [cx - halfW + effectiveRadius, cy - halfH + effectiveRadius], effectiveRadius, -Math.PI, -Math.PI * 1.5, arcSegments, true);
    appendArcPoints(points, [cx - halfW + effectiveRadius, cy + halfH - effectiveRadius], effectiveRadius, -Math.PI * 1.5, -Math.PI * 2, arcSegments, true);
  }

  return {
    closed: true,
    points: rotatePoints(points, degreesToRadians(toNumber(element.rotation, 0)), [cx, cy]),
    source: element.uuid,
  };
}

function appendArcPoints(output, center, radius, startAngle, endAngle, segments, skipFirst = false) {
  for (let index = 0; index <= segments; index += 1) {
    if (skipFirst && index === 0) {
      continue;
    }
    const t = index / segments;
    const angle = startAngle + (endAngle - startAngle) * t;
    output.push([center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius]);
  }
}

function rotatePoints(points, angle, center) {
  if (!angle) {
    return points;
  }
  const [cx, cy] = center;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  return points.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
}

function appendFlattenedCubic(output, p0, p1, p2, p3, tolerance) {
  const points = flattenCubicBezier(p0, p1, p2, p3, tolerance);
  for (let index = 1; index < points.length; index += 1) {
    output.push(points[index]);
  }
}

function flattenCubicBezier(p0, p1, p2, p3, tolerance) {
  const output = [p0];
  flattenCubicRecursive(output, p0, p1, p2, p3, tolerance, 0);
  return output;
}

function flattenCubicRecursive(output, p0, p1, p2, p3, tolerance, depth) {
  if (depth > 12 || cubicFlatEnough(p0, p1, p2, p3, tolerance)) {
    output.push(p3);
    return;
  }

  const p01 = midpoint(p0, p1);
  const p12 = midpoint(p1, p2);
  const p23 = midpoint(p2, p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const p0123 = midpoint(p012, p123);

  flattenCubicRecursive(output, p0, p01, p012, p0123, tolerance, depth + 1);
  flattenCubicRecursive(output, p0123, p123, p23, p3, tolerance, depth + 1);
}

function cubicFlatEnough(p0, p1, p2, p3, tolerance) {
  const d1 = distancePointToLine(p1, p0, p3);
  const d2 = distancePointToLine(p2, p0, p3);
  return Math.max(d1, d2) <= tolerance;
}

function distancePointToLine(point, lineStart, lineEnd) {
  const [x, y] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const denominator = Math.hypot(dx, dy);
  if (denominator === 0) {
    return Math.hypot(x - x1, y - y1);
  }
  return Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / denominator;
}

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function offsetClosedPath(path, amount, direction, warnings, label) {
  if (direction === 0 || amount <= 0) {
    return [path];
  }
  if (!path.closed) {
    warnings.push(`Toolpath "${label}": an offset was requested on an open curve, so centerline cutting was kept.`);
    return [path];
  }

  const sourcePath = removeClosingDuplicate(path.points);
  if (sourcePath.length < 3) {
    return [path];
  }

  const baseArea = Math.abs(signedArea(sourcePath));
  const candidates = [];
  for (const delta of [amount, -amount]) {
    const solution = runClipperOffset(sourcePath, delta);
    if (!solution.length) {
      continue;
    }
    const totalArea = solution.reduce((sum, candidate) => sum + Math.abs(signedArea(candidate.points)), 0);
    candidates.push({
      delta,
      totalArea,
      paths: solution,
    });
  }

  if (!candidates.length) {
    warnings.push(`Toolpath "${label}": offset computation failed, so centerline cutting was kept.`);
    return [path];
  }

  const target = direction < 0
    ? candidates.filter((candidate) => candidate.totalArea < baseArea)
    : candidates.filter((candidate) => candidate.totalArea > baseArea);
  const chosen = (target.length ? target : candidates)
    .sort((a, b) => Math.abs(Math.abs(a.delta) - amount) - Math.abs(Math.abs(b.delta) - amount))[0];

  return chosen.paths;
}

function runClipperOffset(points, delta) {
  const clipperPath = points.map(([x, y]) => ({
    X: Math.round(x * CLIPPER_SCALE),
    Y: Math.round(y * CLIPPER_SCALE),
  }));
  const clipperOffset = new window.ClipperLib.ClipperOffset(2, 0.25 * CLIPPER_SCALE);
  const solution = new window.ClipperLib.Paths();
  clipperOffset.AddPath(clipperPath, window.ClipperLib.JoinType.jtRound, window.ClipperLib.EndType.etClosedPolygon);
  clipperOffset.Execute(solution, delta * CLIPPER_SCALE);

  return solution.map((path) => ({
    closed: true,
    points: path.map((point) => [point.X / CLIPPER_SCALE, point.Y / CLIPPER_SCALE]),
  }));
}

function optimizePathSequence(paths, startPoint) {
  const remaining = paths.slice();
  const optimized = [];
  let cursor = startPoint;

  while (remaining.length) {
    let bestIndex = 0;
    let bestPath = orientPathForNearestStart(remaining[0], cursor);
    let bestDistance = pointDistance(cursor, bestPath.points[0]);

    for (let index = 1; index < remaining.length; index += 1) {
      const candidate = orientPathForNearestStart(remaining[index], cursor);
      const distance = pointDistance(cursor, candidate.points[0]);
      if (distance < bestDistance) {
        bestIndex = index;
        bestPath = candidate;
        bestDistance = distance;
      }
    }

    optimized.push(bestPath);
    remaining.splice(bestIndex, 1);
    cursor = bestPath.closed ? bestPath.points[0] : bestPath.points[bestPath.points.length - 1];
  }

  return optimized;
}

function orientPathForNearestStart(path, referencePoint) {
  if (!path.points?.length) {
    return path;
  }

  if (path.closed) {
    return rotateClosedPath(path, findNearestPointIndex(path.points, referencePoint));
  }

  const firstPoint = path.points[0];
  const lastPoint = path.points[path.points.length - 1];
  return pointDistance(referencePoint, lastPoint) < pointDistance(referencePoint, firstPoint)
    ? reversePath(path)
    : path;
}

function rotateClosedPath(path, startIndex) {
  if (!path.points?.length || startIndex <= 0) {
    return path;
  }
  return {
    ...path,
    points: path.points.slice(startIndex).concat(path.points.slice(0, startIndex)),
  };
}

function reversePath(path) {
  return {
    ...path,
    points: path.points.slice().reverse(),
  };
}

function findNearestPointIndex(points, referencePoint) {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const distance = pointDistance(points[index], referencePoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function buildDepthPasses(startDepth, endDepth, stepdown) {
  if (endDepth <= 0) {
    return [];
  }
  if (endDepth <= startDepth) {
    return [endDepth];
  }
  const passes = [];
  let current = startDepth;
  while (current + stepdown < endDepth) {
    current += stepdown;
    passes.push(current);
  }
  if (!passes.length || passes[passes.length - 1] !== endDepth) {
    passes.push(endDepth);
  }
  return passes;
}

function renderSummary(parsed, generated) {
  if (!parsed || !generated) {
    refs.summary.className = "summary empty";
    refs.summary.textContent = "Load a file to inspect its document settings.";
    return;
  }

  refs.summary.className = "summary";
  refs.summary.innerHTML = `
    <dl>
      <dt>Zone</dt><dd>${formatNumber(parsed.document.width)} x ${formatNumber(parsed.document.height)} mm</dd>
      <dt>Origin</dt><dd>X ${formatNumber(parsed.document.zeroX)}, Y ${formatNumber(parsed.document.zeroY)}, Z ${formatNumber(parsed.document.zeroZ)}</dd>
      <dt>Machine</dt><dd>${escapeHtml(parsed.document.machine || "n/a")}</dd>
      <dt>Material</dt><dd>${escapeHtml(parsed.document.material || "n/a")}</dd>
      <dt>Safe Z</dt>
      <dd>
        <input
          class="summary-number-input"
          type="number"
          min="0"
          step="0.1"
          value="${escapeHtml(formatNumber(generated.stats.safeZ))}"
          data-safe-z-input
          aria-label="Safe Z in millimeters"
        >
      </dd>
      <dt>Duration</dt><dd>${formatDuration(generated.totalDurationSec)}</dd>
    </dl>
  `;

  const safeZInput = refs.summary.querySelector("[data-safe-z-input]");
  if (safeZInput) {
    safeZInput.addEventListener("change", () => {
      updateSafeZ(safeZInput.value);
    });
  }
}

function renderToolpaths(parsed) {
  if (!parsed) {
    refs.toolpaths.className = "toolpaths empty";
    refs.toolpaths.textContent = "Load a file to manage toolpath visibility.";
    return;
  }

  const toolpathItems = (parsed.toolpaths || [])
    .filter((toolpath) => toolpath.enabled !== false)
    .map((toolpath) => {
      const color = toolpath.color || PREVIEW_COLORS[0];
      const visible = toolpath.visible !== false;
      const feed = formatNumber(sanitizePositiveNumber(toolpath.speeds?.feedrate, 1));
      const plunge = formatNumber(sanitizePositiveNumber(toolpath.speeds?.plungerate, sanitizePositiveNumber(toolpath.speeds?.feedrate, 1)));
      const stepdown = formatNumber(Math.max(0.001, sanitizePositiveNumber(toolpath.stepdown, 0.001)));
      const rpm = formatCompactRpm(toolpath.speeds?.rpm);
      return `
        <li class="toolpath-item">
          <div class="toolpath-main">
            <div class="toolpath-meta">
              <input
                class="toolpath-checkbox"
                type="checkbox"
                ${visible ? "checked" : ""}
                data-toolpath-toggle="${escapeHtml(toolpath.uuid)}"
                aria-label="${visible ? "Hide toolpath" : "Show toolpath"} ${escapeHtml(toolpath.name || toolpath.uuid)}"
              >
              <span class="toolpath-swatch" style="background:${color}"></span>
              <span class="toolpath-name">${escapeHtml(toolpath.name || toolpath.uuid)}</span>
            </div>
            <div class="toolpath-stats" aria-label="Toolpath settings">
              <span class="toolpath-stat"><span class="toolpath-stat-label">FEED</span><span class="toolpath-stat-value">${feed}</span></span>
              <span class="toolpath-stat"><span class="toolpath-stat-label">PLNG</span><span class="toolpath-stat-value">${plunge}</span></span>
              <span class="toolpath-stat"><span class="toolpath-stat-label">PASS</span><span class="toolpath-stat-value">${stepdown}</span></span>
              <span class="toolpath-stat"><span class="toolpath-stat-label">RPM</span><span class="toolpath-stat-value">${rpm}</span></span>
              <button
                class="toolpath-stat toolpath-edit toolpath-edit-inline"
                type="button"
                data-toolpath-edit="${escapeHtml(toolpath.uuid)}"
                title="Edit toolpath settings"
              >EDIT</button>
            </div>
          </div>
        </li>
      `;
    })
    .join("");

  refs.toolpaths.className = "toolpaths";
  refs.toolpaths.innerHTML = toolpathItems ? `<ul class="toolpath-list">${toolpathItems}</ul>` : "No active toolpaths.";

  refs.toolpaths.querySelectorAll("[data-toolpath-toggle]").forEach((button) => {
    button.addEventListener("change", () => {
      toggleToolpathVisibility(button.getAttribute("data-toolpath-toggle"));
    });
  });
  refs.toolpaths.querySelectorAll("[data-toolpath-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      openToolpathModal(button.getAttribute("data-toolpath-edit"));
    });
  });
}

function renderPreview(parsed, generated) {
  if (!parsed || !generated) {
    refs.preview.className = "preview empty";
    refs.preview.textContent = "The preview will appear here.";
    state.previewRender = null;
    return;
  }
  const previewPaths = generated.previewPaths || [];
  const visibleElementUUIDs = collectVisibleElementUUIDs(parsed);

  const sourcePaths = [];
  for (const element of parsed.elements) {
    if (visibleElementUUIDs.size && !visibleElementUUIDs.has(element.uuid)) {
      continue;
    }
    for (const path of elementToPolylines(element, 0.2, [])) {
      sourcePaths.push(translateForWorkZero(path, parsed.document.zeroX, parsed.document.zeroY));
    }
  }

  const allPoints = [];
  for (const path of sourcePaths) {
    allPoints.push(...path.points);
  }
  for (const item of previewPaths) {
    for (const path of item.paths) {
      allPoints.push(...path.points);
    }
  }

  if (!allPoints.length) {
    refs.preview.className = "preview empty";
    refs.preview.textContent = "No usable geometry is available to display.";
    return;
  }

  const bounds = computePreviewBounds(parsed, allPoints, 10);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `${bounds.minX} ${-bounds.maxY} ${bounds.width} ${bounds.height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const stock = document.createElementNS(SVG_NS, "rect");
  stock.setAttribute("class", "frame");
  stock.setAttribute("x", String(-parsed.document.zeroX));
  stock.setAttribute("y", String(-(parsed.document.height - parsed.document.zeroY)));
  stock.setAttribute("width", String(parsed.document.width));
  stock.setAttribute("height", String(parsed.document.height));
  svg.appendChild(stock);

  const axes = document.createElementNS(SVG_NS, "g");
  axes.innerHTML = [
    `<line class="origin" x1="${bounds.minX}" y1="0" x2="${bounds.maxX}" y2="0" />`,
    `<line class="origin" x1="0" y1="${-bounds.maxY}" x2="0" y2="${-bounds.minY}" />`,
  ].join("");
  svg.appendChild(axes);

  for (const path of sourcePaths) {
    const element = document.createElementNS(SVG_NS, "path");
    element.setAttribute("class", "source");
    element.setAttribute("d", polylineToSvgPath(path));
    svg.appendChild(element);
  }

  previewPaths.forEach((item) => {
    const color = item.color || PREVIEW_COLORS[0];
    for (const path of item.paths) {
      const element = document.createElementNS(SVG_NS, "path");
      element.setAttribute("class", "toolpath toolpath-base");
      element.setAttribute("stroke", color);
      element.setAttribute("d", polylineToSvgPath(path));
      svg.appendChild(element);
      for (const segment of path.tabSegments || []) {
        const tab = document.createElementNS(SVG_NS, "path");
        tab.setAttribute("class", "toolpath-tab");
        tab.setAttribute("d", polylineToSvgPath({ points: [segment.start, segment.end] }));
        const title = document.createElementNS(SVG_NS, "title");
        title.textContent = "Holding tab";
        tab.appendChild(title);
        svg.appendChild(tab);
      }
    }
  });

  const progressLayer = document.createElementNS(SVG_NS, "g");
  svg.appendChild(progressLayer);

  const toolHead = document.createElementNS(SVG_NS, "circle");
  toolHead.setAttribute("class", "tool-head");
  toolHead.setAttribute("r", "2.4");
  svg.appendChild(toolHead);

  refs.preview.className = "preview";
  refs.preview.replaceChildren(svg);
  state.previewRender = {
    progressLayer,
    toolHead,
    generated,
  };
  updatePlaybackVisualization();
}

function computePreviewBounds(parsed, points, padding = 0) {
  const documentWidth = toNumber(parsed.document.width, 0);
  const documentHeight = toNumber(parsed.document.height, 0);
  const zeroX = toNumber(parsed.document.zeroX, 0);
  const zeroY = toNumber(parsed.document.zeroY, 0);

  if (documentWidth > 0 && documentHeight > 0) {
    return {
      minX: -zeroX - padding,
      minY: -zeroY - padding,
      maxX: documentWidth - zeroX + padding,
      maxY: documentHeight - zeroY + padding,
      width: documentWidth + padding * 2,
      height: documentHeight + padding * 2,
    };
  }

  return computeCenteredBounds(points, padding);
}

function collectVisibleElementUUIDs(parsed) {
  const visibleUUIDs = new Set();
  for (const toolpath of parsed.toolpaths || []) {
    if (toolpath.enabled === false || toolpath.visible === false) {
      continue;
    }
    for (const elementRef of toolpath.elements || []) {
      if (elementRef?.uuid) {
        visibleUUIDs.add(elementRef.uuid);
      }
    }
  }
  return visibleUUIDs;
}

function updatePlaybackVisualization() {
  if (!state.previewRender || !state.generated) {
    return;
  }

  const { progressLayer, toolHead, generated } = state.previewRender;
  const segmentsByColor = new Map();
  const currentPosition = getPlaybackPosition(generated.playbackSegments, state.playback.currentTimeSec);

  for (const segment of generated.playbackSegments) {
    if (segment.motionType !== "cut") {
      continue;
    }
    if (state.playback.currentTimeSec <= segment.startTimeSec) {
      continue;
    }

    const progress = segment.endTimeSec <= segment.startTimeSec
      ? 1
      : clamp((state.playback.currentTimeSec - segment.startTimeSec) / (segment.endTimeSec - segment.startTimeSec), 0, 1);
    const endPoint = progress >= 1
      ? segment.end
      : interpolateMotionPoint(segment.start, segment.end, progress);
    if (![segment.start.x, segment.start.y, endPoint.x, endPoint.y].every(Number.isFinite)) {
      continue;
    }
    if (pointDistance([segment.start.x, segment.start.y], [endPoint.x, endPoint.y]) < 1e-6) {
      continue;
    }
    const color = segment.color || PREVIEW_COLORS[0];
    const pathData = `${segmentsByColor.get(color) || ""} M ${formatNumber(segment.start.x)} ${formatNumber(-segment.start.y)} L ${formatNumber(endPoint.x)} ${formatNumber(-endPoint.y)}`;
    segmentsByColor.set(color, pathData);
  }

  const fragment = document.createDocumentFragment();
  segmentsByColor.forEach((pathData, color) => {
    const element = document.createElementNS(SVG_NS, "path");
    element.setAttribute("class", "toolpath-progress");
    element.setAttribute("stroke", color);
    element.setAttribute("d", pathData.trim());
    fragment.appendChild(element);
  });
  progressLayer.replaceChildren(fragment);

  if (currentPosition) {
    toolHead.setAttribute("cx", formatNumber(currentPosition.x));
    toolHead.setAttribute("cy", formatNumber(-currentPosition.y));
    toolHead.style.display = "";
  } else {
    toolHead.style.display = "none";
  }
}

function polylineToSvgPath(path) {
  const parts = [];
  path.points.forEach(([x, y], index) => {
    parts.push(`${index === 0 ? "M" : "L"} ${formatNumber(x)} ${formatNumber(-y)}`);
  });
  if (path.closed) {
    parts.push("Z");
  }
  return parts.join(" ");
}

function computeBounds(points, padding = 0) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

function computeCenteredBounds(points, padding = 0) {
  const bounds = computeBounds(points, 0);
  const spanX = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX)) + padding;
  const spanY = Math.max(Math.abs(bounds.minY), Math.abs(bounds.maxY)) + padding;
  return {
    minX: -spanX,
    minY: -spanY,
    maxX: spanX,
    maxY: spanY,
    width: spanX * 2,
    height: spanY * 2,
  };
}

function appendPlaybackMotion(segments, current, target, rateMmPerMin, motionType, color) {
  const safeRate = Math.max(0.001, rateMmPerMin);
  const distance = distance3D(current, target);
  const durationSec = distance === 0 ? 0 : (distance / safeRate) * 60;
  const next = {
    x: target.x,
    y: target.y,
    z: target.z,
    timeSec: current.timeSec + durationSec,
  };
  if (distance > 0) {
    segments.push({
      start: { x: current.x, y: current.y, z: current.z },
      end: { x: target.x, y: target.y, z: target.z },
      color,
      motionType,
      startTimeSec: current.timeSec,
      endTimeSec: next.timeSec,
    });
  }
  return next;
}

function getPlaybackPosition(segments, timeSec) {
  if (!segments.length) {
    return { x: 0, y: 0, z: 0 };
  }
  for (const segment of segments) {
    if (timeSec < segment.startTimeSec) {
      return segment.start;
    }
    if (timeSec <= segment.endTimeSec) {
      const progress = segment.endTimeSec <= segment.startTimeSec
        ? 1
        : clamp((timeSec - segment.startTimeSec) / (segment.endTimeSec - segment.startTimeSec), 0, 1);
      return interpolateMotionPoint(segment.start, segment.end, progress);
    }
  }
  return segments[segments.length - 1].end;
}

function interpolateMotionPoint(start, end, progress) {
  return {
    x: start.x + (end.x - start.x) * progress,
    y: start.y + (end.y - start.y) * progress,
    z: start.z + (end.z - start.z) * progress,
  };
}

function distance3D(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.hypot(dx, dy, dz);
}

function formatDuration(totalSeconds) {
  const rounded = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function downloadGcode() {
  if (!state.generated?.gcode) {
    return;
  }
  const blob = new Blob([state.generated.gcode], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const baseName = (state.fileName || "output.c2d").replace(/\.[^.]+$/, "");
  link.href = url;
  link.download = `${baseName}.gcode`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function setStatus(message, isError = false) {
  refs.status.textContent = message;
  refs.status.style.background = isError ? "rgba(255, 123, 114, 0.12)" : "rgba(79, 209, 197, 0.08)";
  refs.status.style.color = isError ? "#ffb4ad" : "";
}

function sanitizePositiveNumber(value, fallback) {
  const numeric = toNumber(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatNumber(value) {
  return Number(value).toFixed(3).replace(/\.000$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function formatCompactRpm(value) {
  const rpm = Math.max(0, Math.round(toNumber(value, 0)));
  if (rpm >= 1000) {
    const compact = rpm / 1000;
    return `${formatNumber(compact)}k`;
  }
  return String(rpm);
}

function signedArea(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return sum / 2;
}

function dedupeSequentialPoints(points, epsilon) {
  const output = [];
  for (const point of points) {
    const previous = output[output.length - 1];
    if (!previous || pointDistance(previous, point) > epsilon) {
      output.push(point);
    }
  }
  return output;
}

function normalizePaths(paths) {
  return paths
    .map((path) => {
      const points = dedupeSequentialPoints(path.points || [], 1e-6);
      if (path.closed && points.length > 2 && pointDistance(points[0], points[points.length - 1]) < 1e-6) {
        return {
          ...path,
          points: points.slice(0, -1),
        };
      }
      return {
        ...path,
        points,
      };
    })
    .filter((path) => path.points.length > 1);
}

function pointDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function numbersEqual(a, b, epsilon = 1e-6) {
  return Math.abs(a - b) <= epsilon;
}

function removeClosingDuplicate(points) {
  if (points.length < 2) {
    return points.slice();
  }
  if (pointDistance(points[0], points[points.length - 1]) < 1e-6) {
    return points.slice(0, -1);
  }
  return points.slice();
}

function addPoints(a, b) {
  return [toNumber(a?.[0], 0) + toNumber(b?.[0], 0), toNumber(a?.[1], 0) + toNumber(b?.[1], 0)];
}

function normalizeOffsetDirection(value) {
  const numeric = Math.round(toNumber(value, 0));
  if (numeric < 0) return -1;
  if (numeric > 0) return 1;
  return 0;
}

function offsetDirectionLabel(direction) {
  if (direction < 0) return "inside";
  if (direction > 0) return "outside";
  return "centerline";
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
