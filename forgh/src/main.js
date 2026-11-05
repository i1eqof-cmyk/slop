import './style.css';

const AREA_SIZES = [100, 250, 500];
const RENDER_BUDGETS = [100_000, 500_000, 2_000_000];
const RESPONSIVE_STALL_MS = 2_000;

const elements = {
  datasetPoints: document.querySelector('#dataset-points'),
  eptUrl: document.querySelector('#ept-url'),
  centerX: document.querySelector('#center-x'),
  centerY: document.querySelector('#center-y'),
  mode: document.querySelector('#quality-mode'),
  qualityExplanation: document.querySelector('#quality-explanation'),
  runAll: document.querySelector('#run-all'),
  cancel: document.querySelector('#cancel'),
  statusTitle: document.querySelector('#status-title'),
  statusDetail: document.querySelector('#status-detail'),
  progress: document.querySelector('#progress'),
  liveMetrics: document.querySelector('#live-metrics'),
  log: document.querySelector('#event-log'),
  renderTitle: document.querySelector('#render-title'),
  renderCount: document.querySelector('#render-count'),
  canvas: document.querySelector('#point-canvas'),
  resultsPlaceholder: document.querySelector('#results-placeholder'),
  resultsTableWrap: document.querySelector('#results-table-wrap'),
  rawResults: document.querySelector('#raw-results'),
  download: document.querySelector('#download'),
};

let cancelled = false;
let activeWorkers = [];
let currentRun = null;
let retainedTiles = [];
let renderLoop = null;
let heartbeat = null;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function bytesFrom(response, body) {
  return body.byteLength;
}

function logEvent(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
  elements.log.prepend(item);
  while (elements.log.children.length > 30) {
    elements.log.lastElementChild.remove();
  }
}

function setStatus(title, detail) {
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
}

function getAdaptiveProfile() {
  const cores = navigator.hardwareConcurrency || null;
  const memory = navigator.deviceMemory || null;
  if (
    (!memory && !cores) ||
    (memory && memory <= 4) ||
    (cores && cores <= 4)
  ) {
    return { pointBudget: 100_000, workerCount: 1, tier: 'economy' };
  }
  if ((memory && memory <= 8) || (cores && cores <= 6)) {
    return { pointBudget: 500_000, workerCount: 2, tier: 'balanced' };
  }
  return { pointBudget: 2_000_000, workerCount: 3, tier: 'high' };
}

function selectedProfile() {
  const adaptive = getAdaptiveProfile();
  const selected = elements.mode.value;
  const choices = {
    adaptive,
    economy: { pointBudget: 100_000, workerCount: 1, tier: 'economy' },
    balanced: { pointBudget: 500_000, workerCount: 2, tier: 'balanced' },
    high: { pointBudget: 2_000_000, workerCount: 3, tier: 'high' },
  };
  return { ...choices[selected], adaptive };
}

function updateQualityNote() {
  const profile = getAdaptiveProfile();
  const memory = navigator.deviceMemory
    ? `${navigator.deviceMemory} GiB device-memory hint`
    : 'device-memory hint unavailable';
  const cores = navigator.hardwareConcurrency
    ? `${navigator.hardwareConcurrency} logical cores`
    : 'core-count hint unavailable';
  elements.qualityExplanation.textContent =
    `Adaptive choice for this browser: ${profile.tier}, ${formatCount(profile.pointBudget)} display points, ` +
    `${profile.workerCount} decoder worker(s) (${cores}; ${memory}). This only limits drawing and parallel decode; ` +
    'it does not truncate downloaded EPT data.';
}

function bboxFor(size, centerX, centerY) {
  return {
    minX: centerX - size / 2,
    maxX: centerX + size / 2,
    minY: centerY - size / 2,
    maxY: centerY + size / 2,
  };
}

function readConfig() {
  const rawUrl = elements.eptUrl.value.trim();
  const rawCenterX = elements.centerX.value.trim();
  const rawCenterY = elements.centerY.value.trim();
  if (!rawUrl || !rawCenterX || !rawCenterY) {
    throw new Error('Enter an EPT metadata URL and both projected center coordinates.');
  }
  let metadataUrl;
  try {
    metadataUrl = new URL(rawUrl);
  } catch {
    throw new Error('Enter a valid EPT metadata URL ending in /ept.json.');
  }
  const isLocalHttp =
    metadataUrl.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(metadataUrl.hostname);
  if (
    (metadataUrl.protocol !== 'https:' && !isLocalHttp) ||
    metadataUrl.username ||
    metadataUrl.password ||
    metadataUrl.search ||
    metadataUrl.hash ||
    !metadataUrl.pathname.endsWith('/ept.json')
  ) {
    throw new Error('Enter an HTTPS EPT metadata URL ending in /ept.json.');
  }
  const centerX = Number(rawCenterX);
  const centerY = Number(rawCenterY);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) {
    throw new Error('Enter finite projected X and Y coordinates.');
  }
  return {
    eptBase: new URL('.', metadataUrl).href,
    metadataUrl: metadataUrl.href,
    centerX,
    centerY,
  };
}

function nodeBox(nodeId, metadata) {
  const [depth, x, y] = nodeId.split('-').map(Number);
  const bounds = metadata.bounds;
  const side = Math.max(
    bounds[3] - bounds[0],
    bounds[4] - bounds[1],
    bounds[5] - bounds[2],
  );
  const width = side / 2 ** depth;
  const minX = bounds[0] + x * width;
  const minY = bounds[1] + y * width;
  return { minX, maxX: minX + width, minY, maxY: minY + width };
}

function intersects(nodeId, metadata, bounds) {
  const box = nodeBox(nodeId, metadata);
  return (
    box.minX <= bounds.maxX &&
    box.maxX >= bounds.minX &&
    box.minY <= bounds.maxY &&
    box.maxY >= bounds.minY
  );
}

async function loadHierarchy(metadata, bounds, metrics, eptBase) {
  const queue = ['0-0-0-0'];
  const seen = new Set();
  const nodes = [];

  while (queue.length) {
    if (cancelled) throw new DOMException('Benchmark cancelled.', 'AbortError');
    const key = queue.pop();
    if (seen.has(key)) continue;
    seen.add(key);

    const url = `${eptBase}ept-hierarchy/${key}.json`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`EPT hierarchy ${key} returned HTTP ${response.status}.`);
    }
    const buffer = await response.arrayBuffer();
    metrics.hierarchyBytes += bytesFrom(response, buffer);
    const hierarchy = JSON.parse(new TextDecoder().decode(buffer));

    for (const [id, pointCount] of Object.entries(hierarchy)) {
      if (!intersects(id, metadata, bounds)) continue;
      if (pointCount === -1) {
        queue.push(id);
      } else if (pointCount > 0) {
        nodes.push({
          id,
          depth: Number(id.split('-', 1)[0]),
          expectedPoints: pointCount,
        });
      } else {
        throw new Error(`EPT hierarchy has an invalid count for ${id}.`);
      }
    }
  }
  return { nodes, hierarchyFiles: seen.size };
}

function createWorkerPool(size, config) {
  const workers = [];
  const queue = [];
  const slots = [];
  const readyPromises = [];
  for (let index = 0; index < size; index += 1) {
    const worker = new Worker(new URL('./decoder-worker.js', import.meta.url), {
      type: 'module',
    });
    workers.push(worker);
    const slot = { worker, current: null };
    slots.push(slot);
    readyPromises.push(
      new Promise((resolve, reject) => {
        worker.addEventListener('message', function readyListener(event) {
          if (event.data.type === 'ready') {
            worker.removeEventListener('message', readyListener);
            resolve();
          } else if (event.data.type === 'worker-error') {
            worker.removeEventListener('message', readyListener);
            reject(new Error(event.data.message));
          }
        });
        worker.addEventListener(
          'error',
          (event) => reject(new Error(event.message || 'Decoder worker failed to start.')),
          { once: true },
        );
        worker.postMessage({ type: 'init' });
      }),
    );
  }
  activeWorkers = workers;
  function pump() {
    for (const slot of slots) {
      if (slot.current || !queue.length || cancelled) continue;
      const task = queue.shift();
      slot.current = task;
      slot.worker.postMessage({
        type: 'decode',
        job: {
          ...task.job,
          centerX: config.centerX,
          centerY: config.centerY,
          bounds: currentRun.bounds,
          eptBase: config.eptBase,
        },
      });
    }
  }
  function onWorkerMessage(slot, event) {
    const message = event.data;
    if (message.type === 'ready') return;
    const task = slot.current;
    if (!task || (message.id && message.id !== task.job.id)) return;
    if (message.type === 'tile') {
      Promise.resolve()
        .then(() => task.onTile(message.tile))
        .then(() => task.resolve(message.tile))
        .catch(task.reject)
        .finally(() => {
          slot.current = null;
          pump();
        });
    } else if (message.type === 'worker-error' || message.type === 'cancelled') {
      slot.current = null;
      task.reject(
        message.type === 'cancelled'
          ? new DOMException(message.message, 'AbortError')
          : new Error(message.message),
      );
      pump();
    }
  }
  return Promise.all(readyPromises).then(() => {
    for (const slot of slots) {
      slot.worker.addEventListener('message', (event) =>
        onWorkerMessage(slot, event),
      );
      slot.worker.addEventListener('error', (event) => {
        if (slot.current) {
          slot.current.reject(new Error(event.message || 'Decoder worker failed.'));
          slot.current = null;
        }
        pump();
      });
    }
    return {
      workers,
      run(job, onTile) {
        return new Promise((resolve, reject) => {
          queue.push({ job, onTile, resolve, reject });
          pump();
        });
      },
    };
  });
}

function stopWorkers() {
  for (const worker of activeWorkers) {
    worker.postMessage({ type: 'cancel' });
    worker.terminate();
  }
  activeWorkers = [];
}

function retainedBytes(tiles) {
  return tiles.reduce(
    (total, tile) =>
      total +
      tile.rawLaz.byteLength +
      tile.positions.byteLength +
      tile.classifications.byteLength,
    0,
  );
}

function areaPointCount(tiles) {
  return tiles.reduce((total, tile) => total + tile.areaPoints, 0);
}

function updateLiveMetrics(run, tiles, loadedNodeCount, totalNodes) {
  elements.liveMetrics.innerHTML = '';
  const items = [
    ['EPT nodes', `${loadedNodeCount} / ${totalNodes}`],
    ['Source records', formatCount(run.downloadedPoints)],
    ['In-area points', formatCount(areaPointCount(tiles))],
    ['Compressed data', formatBytes(run.compressedBytes)],
  ];
  for (const [label, value] of items) {
    const item = document.createElement('div');
    item.className = 'metric';
    const strong = document.createElement('strong');
    strong.textContent = value;
    const small = document.createElement('span');
    small.textContent = label;
    item.append(strong, small);
    elements.liveMetrics.append(item);
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compilation failed: ${message}`);
  }
  return shader;
}

function createPointRenderer(canvas) {
  const gl =
    canvas.getContext('webgl2', { antialias: false, alpha: false }) ||
    canvas.getContext('webgl', { antialias: false, alpha: false });
  if (!gl) {
    throw new Error('WebGL is unavailable in this browser.');
  }

  const vertexSource = `
    attribute vec3 a_position;
    attribute float a_class;
    uniform vec2 u_halfSize;
    uniform float u_heightRange;
    uniform float u_pointSize;
    varying vec3 v_color;
    void main() {
      gl_Position = vec4(
        a_position.x / u_halfSize.x,
        a_position.y / u_halfSize.y,
        clamp(a_position.z / u_heightRange * 0.05, -0.8, 0.8),
        1.0
      );
      gl_PointSize = u_pointSize;
      float c = a_class;
      if (c == 2.0) v_color = vec3(0.89, 0.73, 0.43);
      else if (c >= 3.0 && c <= 5.0) v_color = vec3(0.55, 0.74, 0.51);
      else if (c == 6.0) v_color = vec3(0.98, 0.46, 0.36);
      else v_color = vec3(0.52, 0.72, 0.88);
    }
  `;
  const fragmentSource = `
    precision mediump float;
    varying vec3 v_color;
    void main() {
      gl_FragColor = vec4(v_color, 0.92);
    }
  `;
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(
    program,
    compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource),
  );
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(program)}`);
  }

  const positionAttribute = gl.getAttribLocation(program, 'a_position');
  const classAttribute = gl.getAttribLocation(program, 'a_class');
  const halfSizeUniform = gl.getUniformLocation(program, 'u_halfSize');
  const heightUniform = gl.getUniformLocation(program, 'u_heightRange');
  const pointSizeUniform = gl.getUniformLocation(program, 'u_pointSize');
  const positionBuffer = gl.createBuffer();
  const classBuffer = gl.createBuffer();
  let drawCount = 0;
  let halfHeight = 1;

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  }

  function draw() {
    resize();
    gl.clearColor(0.035, 0.047, 0.04, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniform2f(
      halfSizeUniform,
      currentRun?.size / 2 || 1,
      currentRun?.size / 2 || 1,
    );
    gl.uniform1f(heightUniform, halfHeight);
    gl.uniform1f(
      pointSizeUniform,
      Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionAttribute);
    gl.vertexAttribPointer(positionAttribute, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, classBuffer);
    gl.enableVertexAttribArray(classAttribute);
    gl.vertexAttribPointer(classAttribute, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, drawCount);
  }

  function installSample(positions, classes, count, minZ, maxZ) {
    const started = performance.now();
    halfHeight = Math.max(1, Math.abs(maxZ - minZ));
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, classBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, classes, gl.DYNAMIC_DRAW);
    drawCount = count;
    draw();
    return performance.now() - started;
  }

  function dispose() {
    if (renderLoop) cancelAnimationFrame(renderLoop);
    gl.deleteBuffer(positionBuffer);
    gl.deleteBuffer(classBuffer);
    gl.deleteProgram(program);
  }

  return { draw, installSample, dispose };
}

function startRenderLoop(renderer) {
  if (renderLoop) cancelAnimationFrame(renderLoop);
  let last = performance.now();
  const frame = (now) => {
    last = now;
    renderer.draw();
    renderLoop = requestAnimationFrame(frame);
  };
  renderLoop = requestAnimationFrame(frame);
}

function sampleCounts(tiles, budget) {
  const total = areaPointCount(tiles);
  const target = Math.min(budget, total);
  const quotas = tiles.map((tile) =>
    total ? Math.floor((target * tile.areaPoints) / total) : 0,
  );
  let assigned = quotas.reduce((sum, quota) => sum + quota, 0);
  for (let i = 0; assigned < target && i < tiles.length; i += 1) {
    if (quotas[i] < tiles[i].areaPoints) {
      quotas[i] += 1;
      assigned += 1;
    }
    if (i === tiles.length - 1 && assigned < target) i = -1;
  }
  return { quotas, target };
}

async function createDisplaySample(tiles, budget) {
  const { quotas, target } = sampleCounts(tiles, budget);
  const positions = new Float32Array(target * 3);
  const classes = new Uint8Array(target);
  let cursor = 0;
  for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
    const tile = tiles[tileIndex];
    const quota = quotas[tileIndex];
    if (!quota) continue;
    for (let sampleIndex = 0; sampleIndex < quota; sampleIndex += 1) {
      const pointIndex = Math.min(
        tile.areaPoints - 1,
        Math.floor(((sampleIndex + 0.5) * tile.areaPoints) / quota),
      );
      const sourceIndex = pointIndex * 3;
      const targetIndex = cursor * 3;
      positions[targetIndex] = tile.positions[sourceIndex];
      positions[targetIndex + 1] = tile.positions[sourceIndex + 1];
      positions[targetIndex + 2] = tile.positions[sourceIndex + 2];
      classes[cursor] = tile.classifications[pointIndex];
      cursor += 1;
      if (cursor % 50_000 === 0) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
  }
  if (cursor !== target) {
    throw new Error(`Display sampling produced ${cursor} points; expected ${target}.`);
  }
  return { positions, classes, count: cursor };
}

function getHeapBytes() {
  if (performance.memory && Number.isFinite(performance.memory.usedJSHeapSize)) {
    return {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
      jsHeapLimit: performance.memory.jsHeapSizeLimit,
      api: 'performance.memory (Chromium; does not include all worker/WASM/GPU memory)',
    };
  }
  return {
    usedJSHeapSize: null,
    totalJSHeapSize: null,
    jsHeapLimit: null,
    api: 'performance.memory unavailable',
  };
}

function startHeartbeat() {
  const state = {
    maxGapMs: 0,
    stalled: false,
    lastTime: performance.now(),
  };
  heartbeat = window.setInterval(() => {
    const now = performance.now();
    const gap = now - state.lastTime;
    state.maxGapMs = Math.max(state.maxGapMs, gap);
    if (gap >= RESPONSIVE_STALL_MS) state.stalled = true;
    state.lastTime = now;
  }, 100);
  return state;
}

async function measureRenderBudget(renderer, tiles, budget, minZ, maxZ) {
  const sample = await createDisplaySample(tiles, budget);
  const uploadMs = renderer.installSample(
    sample.positions,
    sample.classes,
    sample.count,
    minZ,
    maxZ,
  );

  const frameIntervals = [];
  let last = performance.now();
  const start = last;
  const end = start + 1_500;
  while (performance.now() < end) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = performance.now();
    frameIntervals.push(now - last);
    last = now;
  }
  const sorted = [...frameIntervals].sort((a, b) => a - b);
  const p95Index = Math.min(
    sorted.length - 1,
    Math.floor(sorted.length * 0.95),
  );
  return {
    requestedPointBudget: budget,
    renderedPoints: sample.count,
    fps: Number((frameIntervals.length / 1.5).toFixed(2)),
    p95FrameMs: sorted.length ? Number(sorted[p95Index].toFixed(2)) : null,
    gpuBufferUploadMs: Number(uploadMs.toFixed(2)),
    measuredFrames: frameIntervals.length,
  };
}

function setAreaStatus(size, state, message) {
  const status = document.querySelector(`[data-area="${size}"]`);
  status.textContent = message;
  status.dataset.state = state;
}

function memoryEstimate(tiles) {
  const rawLazBytes = tiles.reduce((sum, tile) => sum + tile.rawLaz.byteLength, 0);
  const positionsBytes = tiles.reduce(
    (sum, tile) => sum + tile.positions.byteLength,
    0,
  );
  const classesBytes = tiles.reduce(
    (sum, tile) => sum + tile.classifications.byteLength,
    0,
  );
  return {
    retainedCompressedLazBytes: rawLazBytes,
    retainedPositionTypedArrayBytes: positionsBytes,
    retainedClassificationTypedArrayBytes: classesBytes,
    retainedBytesMeasured: rawLazBytes + positionsBytes + classesBytes,
    note:
      'Measured retained ArrayBuffer/typed-array payload only; excludes JS objects, browser cache, worker WASM heaps, WebGL/GPU buffers and browser overhead.',
  };
}

async function runArea(size, metadata, profile, renderer, responsiveness, config) {
  const started = performance.now();
  responsiveness.maxGapMs = 0;
  responsiveness.stalled = false;
  responsiveness.lastTime = performance.now();
  const bounds = bboxFor(size, config.centerX, config.centerY);
  currentRun = { size, bounds, centerX: config.centerX, centerY: config.centerY };
  retainedTiles = [];
  elements.renderTitle.textContent = `Loading ${size} × ${size} m`;
  elements.renderCount.textContent = '0 points';
  elements.progress.value = 0;
  elements.progress.max = 1;
  setAreaStatus(size, 'running', 'Preparing EPT query…');
  setStatus(`Loading ${size} × ${size} m`, 'Reading matching EPT hierarchy entries.');

  const run = {
    sizeMeters: size,
    dataType: metadata.dataType,
    hierarchyBytes: 0,
    compressedBytes: 0,
    downloadedPoints: 0,
    hierarchyFiles: 0,
    nodes: [],
    levelDetail: [],
    renderBenchmarks: [],
    timing: {
      startedAt: new Date().toISOString(),
      timeToFirstPointsMs: null,
      timeToFullDetailMs: null,
      totalBrowserElapsedMs: null,
    },
  };

  const hierarchyResult = await loadHierarchy(metadata, bounds, run, config.eptBase);
  const nodes = hierarchyResult.nodes.sort(
    (a, b) => a.depth - b.depth || a.id.localeCompare(b.id),
  );
  run.hierarchyFiles = hierarchyResult.hierarchyFiles;
  run.hierarchyNodeCount = nodes.length;
  run.hierarchyPointCountForIntersectingNodes = nodes.reduce(
    (sum, node) => sum + node.expectedPoints,
    0,
  );
  run.maxEptDepth = nodes.reduce((depth, node) => Math.max(depth, node.depth), 0);
  if (!nodes.length) {
    throw new Error(`No EPT nodes intersect the ${size} m test box.`);
  }

  const pool = await createWorkerPool(profile.workerCount, config);
  const groups = new Map();
  for (const node of nodes) {
    if (!groups.has(node.depth)) groups.set(node.depth, []);
    groups.get(node.depth).push(node);
  }
  const orderedDepths = [...groups.keys()].sort((a, b) => a - b);
  startRenderLoop(renderer);
  let minZ = Infinity;
  let maxZ = -Infinity;
  let loadedNodes = 0;
  let firstVisible = false;
  const lodStarted = performance.now();
  elements.progress.max = nodes.length;

  for (const depth of orderedDepths) {
    if (cancelled) throw new DOMException('Benchmark cancelled.', 'AbortError');
    const levelStarted = performance.now();
    const levelNodes = groups.get(depth);
    const levelTiles = await Promise.all(
      levelNodes.map((node) =>
        pool.run(node, async (tile) => {
          loadedNodes += 1;
          run.compressedBytes += tile.compressedBytes;
          run.downloadedPoints += tile.downloadedPoints;
          run.nodes.push({
            id: tile.id,
            depth: tile.depth,
            hierarchyPoints: tile.expectedPoints,
            decodedPoints: tile.downloadedPoints,
            areaPoints: tile.areaPoints,
            compressedBytes: tile.compressedBytes,
            downloadMs: tile.downloadMs,
            decodeMs: tile.decodeMs,
            pointFormat: tile.pointFormat,
            pointRecordLength: tile.recordLength,
          });
          minZ = tile.minZ === null ? minZ : Math.min(minZ, tile.minZ);
          maxZ = tile.maxZ === null ? maxZ : Math.max(maxZ, tile.maxZ);
          retainedTiles.push(tile);
          elements.progress.value = loadedNodes;
          updateLiveMetrics(run, retainedTiles, loadedNodes, nodes.length);
          elements.renderCount.textContent = `${formatCount(areaPointCount(retainedTiles))} in-area points`;

          if (!firstVisible && tile.areaPoints > 0) {
            const sample = await createDisplaySample(
              retainedTiles,
              Math.min(profile.pointBudget, areaPointCount(retainedTiles)),
            );
            renderer.installSample(sample.positions, sample.classes, sample.count, minZ, maxZ);
            await new Promise((resolve) => requestAnimationFrame(resolve));
            firstVisible = true;
            run.timing.timeToFirstPointsMs = Number(
              (performance.now() - started).toFixed(2),
            );
            run.firstVisiblePointCount = sample.count;
            logEvent(`${size} m: first ${formatCount(sample.count)} EPT points visible.`);
          }
        }),
      ),
    );
    const levelRecords = levelTiles.reduce(
      (sum, tile) => sum + tile.downloadedPoints,
      0,
    );
    const levelAreaPoints = levelTiles.reduce(
      (sum, tile) => sum + tile.areaPoints,
      0,
    );
    run.levelDetail.push({
      depth,
      nodeCount: levelTiles.length,
      downloadedPoints: levelRecords,
      inAreaPoints: levelAreaPoints,
      compressedBytes: levelTiles.reduce(
        (sum, tile) => sum + tile.compressedBytes,
        0,
      ),
      elapsedMs: Number((performance.now() - levelStarted).toFixed(2)),
      cumulativeElapsedMs: Number((performance.now() - lodStarted).toFixed(2)),
    });

    if (firstVisible) {
      const sample = await createDisplaySample(
        retainedTiles,
        Math.min(profile.pointBudget, areaPointCount(retainedTiles)),
      );
      renderer.installSample(sample.positions, sample.classes, sample.count, minZ, maxZ);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const levelProgress = run.levelDetail[run.levelDetail.length - 1];
    logEvent(
      `${size} m: EPT depth ${depth}, ${formatCount(levelAreaPoints)} in-area points from ${levelTiles.length} node(s).`,
    );
    setStatus(
      `Loading ${size} × ${size} m · EPT depth ${depth}`,
      `${loadedNodes}/${nodes.length} nodes decoded; ${formatCount(areaPointCount(retainedTiles))} points fall inside the exact box.`,
    );
    elements.progress.value = loadedNodes;
    run.lastCompletedDepth = levelProgress.depth;
  }

  if (!firstVisible) {
    throw new Error('Downloaded EPT nodes but found no points inside the requested box.');
  }
  run.timing.timeToFullDetailMs = Number((performance.now() - started).toFixed(2));
  elements.renderTitle.textContent = `Full EPT detail · ${size} × ${size} m`;
  setStatus(`Full detail loaded · ${size} × ${size} m`, 'Measuring WebGL display budgets.');
  setAreaStatus(
    size,
    'complete',
    `${formatCount(areaPointCount(retainedTiles))} points · ${nodes.length} nodes`,
  );
  logEvent(
    `${size} m: all intersecting nodes decoded; ${formatBytes(run.compressedBytes)} of LAZ node data fetched.`,
  );

  for (const budget of RENDER_BUDGETS) {
    if (cancelled) throw new DOMException('Benchmark cancelled.', 'AbortError');
    const result = await measureRenderBudget(
      renderer,
      retainedTiles,
      budget,
      minZ,
      maxZ,
    );
    run.renderBenchmarks.push(result);
    logEvent(
      `${size} m: ${formatCount(result.renderedPoints)} rendered, ${result.fps} FPS, p95 ${result.p95FrameMs} ms.`,
    );
  }

  run.timing.totalBrowserElapsedMs = Number((performance.now() - started).toFixed(2));
  run.rawPointAttributesPreserved = true;
  run.attributePreservation =
    'Original compressed LAZ bytes retained for every fetched EPT node; full LAS records are not replaced by the display sample.';
  run.exactInBoundsPointCount = areaPointCount(retainedTiles);
  run.renderedPointBudgets = run.renderBenchmarks.map((result) => ({
    requested: result.requestedPointBudget,
    rendered: result.renderedPoints,
  }));
  run.compressedDataBytes = run.compressedBytes;
  run.responsePayloadBytes = run.compressedBytes + run.hierarchyBytes;
  run.totalDecompressionMs = Number(
    run.nodes.reduce((sum, node) => sum + node.decodeMs, 0).toFixed(2),
  );
  run.sumOfNodeDownloadMs = Number(
    run.nodes.reduce((sum, node) => sum + node.downloadMs, 0).toFixed(2),
  );
  run.retainedDataMemory = memoryEstimate(retainedTiles);
  run.browserHeap = getHeapBytes();
  run.responsiveness = {
    maxHeartbeatGapMs: Number(responsiveness.maxGapMs.toFixed(2)),
    unresponsiveByBenchmarkThreshold: responsiveness.stalled,
    thresholdMs: RESPONSIVE_STALL_MS,
    note:
      'UI heartbeat ran every 100 ms; a gap of at least 2 seconds is reported as unresponsive. Browser-level OS hangs cannot be inferred from this page.',
  };
  run.sourceLevelRawPointRecords = run.downloadedPoints;
  run.eptHierarchyPointSum = run.hierarchyPointCountForIntersectingNodes;
  run.metadata = {
    horizontalCrs: metadata.srs?.horizontal
      ? `EPSG:${metadata.srs.horizontal}`
      : 'Not reported by EPT metadata.',
    verticalReference: 'Unverified; all Z values remain LAS Z units.',
    requestBounds: 'Centered square in the selected dataset coordinate system.',
    visualDownsampling:
      'WebGL samples only affect displayed buffers; the compressed LAZ payload for every fetched point node is retained separately.',
  };

  if (renderLoop) cancelAnimationFrame(renderLoop);
  renderer.draw();
  run.browserHeapAfterRender = getHeapBytes();
  run.tileCount = retainedTiles.length;
  return run;
}

function renderResults(report) {
  const rows = report.areas
    .map(
      (area) => `<tr>
        <td>${area.sizeMeters} × ${area.sizeMeters} m</td>
        <td>${formatCount(area.exactInBoundsPointCount)}</td>
        <td>${formatCount(area.sourceLevelRawPointRecords)}</td>
        <td>${formatBytes(area.compressedDataBytes)}</td>
        <td>${area.timing.timeToFirstPointsMs.toFixed(0)} ms</td>
        <td>${(area.timing.timeToFullDetailMs / 1000).toFixed(2)} s</td>
        <td>${area.renderBenchmarks.map((item) => `${formatCount(item.renderedPoints)}: ${item.fps} fps`).join('<br>')}</td>
        <td>${area.totalDecompressionMs.toFixed(0)} ms</td>
        <td>${formatBytes(area.retainedDataMemory.retainedBytesMeasured)}</td>
        <td>${area.browserHeap.usedJSHeapSize ? formatBytes(area.browserHeap.usedJSHeapSize) : 'not exposed'}</td>
        <td>${area.responsiveness.maxHeartbeatGapMs.toFixed(0)} ms${area.responsiveness.unresponsiveByBenchmarkThreshold ? ' · stall' : ''}</td>
      </tr>`,
    )
    .join('');
  elements.resultsTableWrap.innerHTML = `<table>
    <thead><tr>
      <th>Area</th><th>Exact points in box</th><th>Node points decoded</th>
      <th>Compressed LAZ</th><th>First points</th><th>Full detail</th>
      <th>Render budgets / FPS</th><th>Decode time (sum)</th>
      <th>Retained data arrays</th><th>Browser JS heap</th><th>Max UI heartbeat gap</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
  elements.resultsPlaceholder.hidden = true;
  elements.rawResults.textContent = JSON.stringify(report, null, 2);
  elements.download.disabled = false;
}

function downloadReport() {
  if (!window.__benchmarkReport) return;
  const blob = new Blob([JSON.stringify(window.__benchmarkReport, null, 2)], {
    type: 'application/json',
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'global-ept-browser-benchmark.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function runAll() {
  cancelled = false;
  elements.runAll.disabled = true;
  elements.cancel.disabled = false;
  elements.download.disabled = true;
  elements.log.replaceChildren();
  elements.resultsTableWrap.replaceChildren();
  elements.resultsPlaceholder.hidden = false;
  for (const size of AREA_SIZES) setAreaStatus(size, 'pending', 'Waiting');

  const profile = selectedProfile();
  const responsiveness = startHeartbeat();
  let renderer;
  try {
    const config = readConfig();
    renderer = createPointRenderer(elements.canvas);
    const metadataResponse = await fetch(config.metadataUrl, { cache: 'no-store' });
    if (!metadataResponse.ok) {
      throw new Error(`EPT metadata returned HTTP ${metadataResponse.status}.`);
    }
    const metadataBuffer = await metadataResponse.arrayBuffer();
    const metadata = JSON.parse(new TextDecoder().decode(metadataBuffer));
    elements.datasetPoints.textContent = formatCount(metadata.points);
    logEvent(
      `EPT metadata loaded (${formatBytes(metadataBuffer.byteLength)}; ${metadata.dataType}).`,
    );

    const areas = [];
    for (const size of AREA_SIZES) {
      if (cancelled) throw new DOMException('Benchmark cancelled.', 'AbortError');
      const result = await runArea(
        size,
        metadata,
        profile,
        renderer,
        responsiveness,
        config,
      );
      areas.push(result);
      stopWorkers();
      retainedTiles = [];
    }

    const report = {
      reportTitle: 'Global EPT browser benchmark',
      generatedAt: new Date().toISOString(),
      browser: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
        deviceMemoryGiBHint: navigator.deviceMemory || null,
        webgl: 'WebGL renderer; no point-per-DOM rendering.',
        qualityProfile: profile.tier,
        chosenDisplayBudget: profile.pointBudget,
        decoderWorkers: profile.workerCount,
        deviceAwareDisplayDownsampling: true,
      },
      dataset: {
        dataType: metadata.dataType,
        horizontalCrs: metadata.srs?.horizontal
          ? `EPSG:${metadata.srs.horizontal}`
          : null,
        verticalReference: 'Unverified; report Z only as LAS Z units.',
        dimensions: metadata.schema.map((dimension) => dimension.name),
      },
      benchmark: {
        progressiveEpt: true,
        levelsLoaded: 'All intersecting positive-count EPT nodes, in increasing depth order.',
        pointBudgetDescription:
          '100k / 500k / 2M are WebGL display budgets only; no EPT source point records are omitted from downloaded/retained LAZ tiles.',
        exactAreaCountDefinition:
          'Decoded source records whose projected X/Y are inside the requested square, counted from actual points.',
        nodePointCountDefinition:
          'All point records in fetched LAZ nodes, including records in intersecting node bounds but outside the exact test square.',
      },
      areas,
      caveats: [
        'This is one local browser/device and network run, not a representative sample of ordinary visitors.',
        'Browser heap APIs can omit worker WASM heaps, browser internals and GPU buffers; retained typed-array and compressed byte totals are measured separately.',
        'EPT hierarchy counts identify intersecting nodes; exact in-box counts are computed only after actual LAZ data is fetched and decoded.',
        'Full detail means every positive-count EPT node intersecting the square was downloaded and decoded.',
        'Z units and vertical datum are unverified.',
        'The selected EPT URL and projected coordinates are intentionally omitted from the report.',
      ],
    };
    try {
      const saveResponse = await fetch('/__benchmark-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
      if (!saveResponse.ok) {
        throw new Error(`Local report save returned HTTP ${saveResponse.status}.`);
      }
      report.localReport = await saveResponse.json();
    } catch (error) {
      report.localReport = {
        saved: false,
        message: error.message,
        fallback: 'Use Download JSON report.',
      };
    }
    window.__benchmarkReport = report;
    renderResults(report);
    setStatus('All browser tests complete', 'All three requested areas retrieved actual EPT point data.');
    logEvent('All three browser EPT tests completed successfully.');
  } catch (error) {
    stopWorkers();
    if (error.name === 'AbortError' || cancelled) {
      setStatus('Benchmark cancelled', 'Partial measurements are not reported as completed tests.');
      logEvent('Benchmark cancelled by user.');
    } else {
      setStatus('Benchmark failed', error.message);
      logEvent(`ERROR: ${error.message}`);
      console.error(error);
    }
  } finally {
    stopWorkers();
    if (heartbeat) window.clearInterval(heartbeat);
    if (renderer) renderer.dispose();
    elements.runAll.disabled = false;
    elements.cancel.disabled = true;
    updateQualityNote();
  }
}

async function initialize() {
  updateQualityNote();
  elements.mode.addEventListener('change', updateQualityNote);
  elements.runAll.addEventListener('click', runAll);
  elements.cancel.addEventListener('click', () => {
    cancelled = true;
    for (const worker of activeWorkers) worker.postMessage({ type: 'cancel' });
    setStatus('Cancelling', 'Stopping outstanding browser data requests.');
  });
  elements.download.addEventListener('click', downloadReport);
}

initialize();
