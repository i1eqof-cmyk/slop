import proj4 from 'proj4';

export const MAX_SCAN_NODE_POINTS = 40_000_000;
const DEFAULT_SCAN_NODE_POINT_LIMIT = 8_000_000;

const PROGRESSIVE_POINT_GRID_METERS = 2.5;
const MAX_HIERARCHY_FILES = 50_000;
const MAX_CANDIDATE_RESULTS = 500;

function getSourceProjection(dataset) {
  const { metadata, projectionWkt, horizontalCrs } = dataset;
  if (projectionWkt) {
    proj4.defs('EPT_SOURCE', projectionWkt);
    return 'EPT_SOURCE';
  }
  if (horizontalCrs === 'EPSG:4326' || horizontalCrs === 'EPSG:3857') {
    return horizontalCrs;
  }
  throw new Error(
    `Survey ${dataset.itemId} does not provide a transformable horizontal CRS definition.`,
  );
}

function transformBounds(bounds, projection) {
  const samples = [];
  const divisions = 8;
  for (let index = 0; index <= divisions; index += 1) {
    const fraction = index / divisions;
    const longitude = bounds.west + (bounds.east - bounds.west) * fraction;
    const latitude = bounds.south + (bounds.north - bounds.south) * fraction;
    samples.push(
      [longitude, bounds.south],
      [longitude, bounds.north],
      [bounds.west, latitude],
      [bounds.east, latitude],
    );
  }
  const coordinates = samples.map((coordinate) =>
    proj4('EPSG:4326', projection, coordinate),
  );
  const xs = coordinates.map((coordinate) => coordinate[0]);
  const ys = coordinates.map((coordinate) => coordinate[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function nodeBox(nodeId, metadata) {
  const [depthValue, xValue, yValue] = nodeId.split('-');
  const depth = Number(depthValue);
  const x = Number(xValue);
  const y = Number(yValue);
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

async function fetchJson(url, diagnostics, label, signal) {
  diagnostics.requestCount += 1;
  diagnostics.requestLog.push({ label, url: new URL(url).hostname });
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  const buffer = await response.arrayBuffer();
  diagnostics.downloadedBytes += buffer.byteLength;
  return JSON.parse(new TextDecoder().decode(buffer));
}

async function loadHierarchy(dataset, bounds, diagnostics, signal, onProgress) {
  const queue = ['0-0-0-0'];
  const seen = new Set();
  const nodes = [];
  const metadata = dataset.metadata;

  while (queue.length) {
    if (signal.aborted) throw new DOMException('Scan cancelled.', 'AbortError');
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > MAX_HIERARCHY_FILES) {
      throw new Error(`EPT hierarchy for ${dataset.itemId} exceeded the safety limit.`);
    }

    onProgress(`Reading ${dataset.itemId} hierarchy (${seen.size} file(s))`);
    const hierarchy = await fetchJson(
      `${dataset.eptBase}ept-hierarchy/${id}.json`,
      diagnostics,
      'EPT hierarchy',
      signal,
    );

    for (const [nodeId, pointCount] of Object.entries(hierarchy)) {
      if (!intersects(nodeId, metadata, bounds)) continue;
      if (pointCount === -1) {
        queue.push(nodeId);
      } else if (Number.isSafeInteger(pointCount) && pointCount > 0) {
        nodes.push({
          id: nodeId,
          depth: Number(nodeId.split('-')[0]),
          expectedPoints: pointCount,
          itemId: dataset.itemId,
        });
      } else {
        throw new Error(`EPT hierarchy has an invalid point count for ${nodeId}.`);
      }
    }
  }
  return { nodes, hierarchyFiles: seen.size };
}

function createWorkerPool(size, signal) {
  const slots = [];
  const queued = [];
  let stopped = false;
  let pump = () => {};
  const readyPromises = [];

  for (let index = 0; index < size; index += 1) {
    const worker = new Worker(new URL('./decoder-worker.js', import.meta.url), {
      type: 'module',
    });
    const slot = { worker, current: null };
    slots.push(slot);
    readyPromises.push(
      new Promise((resolve, reject) => {
        const handleMessage = (event) => {
          const message = event.data;
          if (message.type === 'ready') {
            resolve();
            return;
          }
          if (message.type === 'worker-error' && !slot.current) {
            reject(new Error(message.message));
            return;
          }
          if (!slot.current || (message.id && message.id !== slot.current.job.id)) {
            return;
          }
          const task = slot.current;
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
        };
        worker.addEventListener('message', handleMessage);
        worker.addEventListener('error', (event) => {
          const error = new Error(event.message || 'Decoder worker failed.');
          if (slot.current) {
            slot.current.reject(error);
            slot.current = null;
          } else {
            reject(error);
          }
          pump();
        });
        worker.postMessage({ type: 'init' });
      }),
    );
  }

  pump = () => {
    for (const slot of slots) {
      if (stopped || slot.current || !queued.length || signal.aborted) continue;
      const task = queued.shift();
      slot.current = task;
      slot.worker.postMessage({ type: 'decode', job: task.job });
    }
  };

  const abort = () => {
    stopped = true;
    for (const task of queued.splice(0)) {
      task.reject(new DOMException('Scan cancelled.', 'AbortError'));
    }
    for (const slot of slots) {
      if (slot.current) {
        slot.current.reject(new DOMException('Scan cancelled.', 'AbortError'));
        slot.current = null;
      }
      slot.worker.terminate();
    }
  };
  signal.addEventListener('abort', abort, { once: true });

  return Promise.all(readyPromises).then(() => ({
    run(job, onTile) {
      if (stopped || signal.aborted) {
        return Promise.reject(new DOMException('Scan cancelled.', 'AbortError'));
      }
      return new Promise((resolve, reject) => {
        queued.push({ job, onTile, resolve, reject });
        pump();
      });
    },
    close() {
      stopped = true;
      signal.removeEventListener('abort', abort);
      for (const slot of slots) slot.worker.terminate();
    },
  }));
}

function getDeviceProfile() {
  const cores = navigator.hardwareConcurrency || 2;
  const memory = navigator.deviceMemory || 4;
  if (cores <= 4 || memory <= 4) {
    return {
      workers: 1,
      displayPoints: 100_000,
      maxSourcePoints: DEFAULT_SCAN_NODE_POINT_LIMIT,
    };
  }
  if (cores <= 8 || memory <= 8) {
    return {
      workers: 2,
      displayPoints: 500_000,
      maxSourcePoints: DEFAULT_SCAN_NODE_POINT_LIMIT,
    };
  }
  return {
    workers: 3,
    displayPoints: 2_000_000,
    maxSourcePoints: MAX_SCAN_NODE_POINTS,
  };
}

export async function scanDatasets(
  datasets,
  geographicBounds,
  diagnostics,
  signal,
  onProgress,
  onTile,
  scanStartedAt = performance.now(),
) {
  const started = scanStartedAt;
  const profile = getDeviceProfile();
  const displayCenter = {
    longitude: (geographicBounds.west + geographicBounds.east) / 2,
    latitude: (geographicBounds.south + geographicBounds.north) / 2,
  };
  const plans = [];
  let expectedPoints = 0;
  let hierarchyFiles = 0;

  for (const dataset of datasets) {
    if (signal.aborted) throw new DOMException('Scan cancelled.', 'AbortError');
    const projection = getSourceProjection(dataset);
    const sourceBounds = transformBounds(geographicBounds, projection);
    const nodesResult = await loadHierarchy(
      dataset,
      sourceBounds,
      diagnostics,
      signal,
      onProgress,
    );
    hierarchyFiles += nodesResult.hierarchyFiles;
    expectedPoints += nodesResult.nodes.reduce(
      (total, node) => total + node.expectedPoints,
      0,
    );
    plans.push({
      dataset,
      projection,
      sourceBounds,
      nodes: nodesResult.nodes.sort(
        (a, b) => a.depth - b.depth || a.id.localeCompare(b.id),
      ),
    });
  }

  if (!expectedPoints) {
    throw new Error('No EPT point nodes intersect the selected map rectangle.');
  }
  if (expectedPoints > profile.maxSourcePoints) {
    const error = new Error(
      `The intersecting EPT nodes contain ${expectedPoints.toLocaleString()} source points, above this device's ${profile.maxSourcePoints.toLocaleString()}-point browser safety limit. Draw a smaller rectangle; no LAZ nodes were downloaded.`,
    );
    error.name = 'ScanLimitError';
    throw error;
  }

  const pool = await createWorkerPool(profile.workers, signal);
  const result = {
    profile,
    expectedPoints,
    hierarchyFiles,
    nodes: [],
    downloadedPoints: 0,
    pointsInSelection: 0,
    compressedBytes: 0,
    firstPointsMs: null,
    decodeMs: 0,
    downloadMs: 0,
    datasets: plans.map(({ dataset, nodes }) => ({
      id: dataset.itemId,
      pointsAvailableInDataset: dataset.metadata.points,
      horizontalCrs: dataset.horizontalCrs,
      nodeCount: nodes.length,
    })),
    timing: {},
  };
  const totalNodes = plans.reduce((total, plan) => total + plan.nodes.length, 0);
  let nodesLoaded = 0;

  try {
    for (const plan of plans) {
      const dataset = plan.dataset;
      for (const node of plan.nodes) {
        if (signal.aborted) throw new DOMException('Scan cancelled.', 'AbortError');
        onProgress(
          `Decoding ${dataset.itemId}: ${nodesLoaded.toLocaleString()} / ${totalNodes.toLocaleString()} EPT nodes`,
          nodesLoaded,
          totalNodes,
        );
        diagnostics.requestCount += 1;
        diagnostics.requestLog.push({
          label: 'EPT LAZ node',
          url: new URL(dataset.eptBase).hostname,
        });
        await pool.run(
          {
            ...node,
            eptBase: dataset.eptBase,
            bounds: plan.sourceBounds,
            centerX: (plan.sourceBounds.minX + plan.sourceBounds.maxX) / 2,
            centerY: (plan.sourceBounds.minY + plan.sourceBounds.maxY) / 2,
            geographicBounds,
            displayCenter,
            sourceWkt: dataset.projectionWkt,
            sourceCrs: plan.projection,
          },
          (decodedTile) => {
            decodedTile.positions =
              decodedTile.positions instanceof Float32Array
                ? decodedTile.positions
                : new Float32Array(decodedTile.positions);
            decodedTile.classifications =
              decodedTile.classifications instanceof Uint8Array
                ? decodedTile.classifications
                : new Uint8Array(decodedTile.classifications);
            result.nodes.push({
              id: decodedTile.id,
              dataset: dataset.itemId,
              depth: decodedTile.depth,
              expectedPoints: decodedTile.expectedPoints,
              downloadedPoints: decodedTile.downloadedPoints,
              pointsInSelection: decodedTile.areaPoints,
              compressedBytes: decodedTile.compressedBytes,
              downloadMs: decodedTile.downloadMs,
              decodeMs: decodedTile.decodeMs,
              pointFormat: decodedTile.pointFormat,
              pointRecordLength: decodedTile.recordLength,
            });
            result.downloadedPoints += decodedTile.downloadedPoints;
            result.pointsInSelection += decodedTile.areaPoints;
            result.compressedBytes += decodedTile.compressedBytes;
            result.downloadMs += decodedTile.downloadMs;
            result.decodeMs += decodedTile.decodeMs;
            diagnostics.downloadedBytes += decodedTile.compressedBytes;
            if (result.firstPointsMs === null && decodedTile.areaPoints > 0) {
              result.firstPointsMs = Number((performance.now() - started).toFixed(2));
            }
            onTile(decodedTile, dataset, result);
          },
        );
        nodesLoaded += 1;
        onProgress(
          `Decoded ${nodesLoaded.toLocaleString()} / ${totalNodes.toLocaleString()} EPT nodes`,
          nodesLoaded,
          totalNodes,
        );
      }
    }
  } finally {
    pool.close();
  }

  result.timing.fullDetailMs = Number((performance.now() - started).toFixed(2));
  result.timing.firstPointsMs = result.firstPointsMs;
  result.decodeMs = Number(result.decodeMs.toFixed(2));
  result.downloadMs = Number(result.downloadMs.toFixed(2));
  result.profile = { ...profile, totalNodes };
  result.verticalReference =
    'Unverified; all elevations and ground-relative values remain LAS Z units.';
  result.pointDataPolicy =
    'Raw LAZ node payloads are retained until this page is closed or the next scan starts; decoded point arrays are retained through rendering and candidate analysis, then released.';
  return result;
}

function median(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function pointGrid(tiles) {
  const cells = new Map();
  for (const tile of tiles) {
    for (let index = 0; index < tile.areaPoints; index += 1) {
      const offset = index * 3;
      const x = tile.positions[offset];
      const y = tile.positions[offset + 1];
      const z = tile.positions[offset + 2];
      const classification = tile.classifications[index];
      const gx = Math.floor(x / PROGRESSIVE_POINT_GRID_METERS);
      const gy = Math.floor(y / PROGRESSIVE_POINT_GRID_METERS);
      const key = `${gx},${gy}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = {
          gx,
          gy,
          count: 0,
          groundCount: 0,
          groundSum: 0,
          nonGroundCount: 0,
          nonGroundSum: 0,
          nonGroundMinZ: Infinity,
          nonGroundMaxZ: -Infinity,
          class6Count: 0,
          vegetationCount: 0,
          otherCount: 0,
        };
        cells.set(key, cell);
      }
      cell.count += 1;
      if (classification === 2) {
        cell.groundCount += 1;
        cell.groundSum += z;
      } else {
        cell.nonGroundCount += 1;
        cell.nonGroundSum += z;
        cell.nonGroundMinZ = Math.min(cell.nonGroundMinZ, z);
        cell.nonGroundMaxZ = Math.max(cell.nonGroundMaxZ, z);
      }
      if (classification === 6) cell.class6Count += 1;
      else if ([3, 4, 5].includes(classification)) cell.vegetationCount += 1;
      else cell.otherCount += 1;
    }
  }
  return cells;
}

function groupCandidateCells(cells) {
  for (const cell of cells.values()) {
    if (!cell.nonGroundCount) continue;
    const nearbyGround = [];
    for (let dx = -3; dx <= 3; dx += 1) {
      for (let dy = -3; dy <= 3; dy += 1) {
        const ground = cells.get(`${cell.gx + dx},${cell.gy + dy}`);
        if (ground?.groundCount) {
          nearbyGround.push(ground.groundSum / ground.groundCount);
        }
      }
    }
    cell.localGroundZ = median(nearbyGround);
    cell.nonGroundMeanZ = cell.nonGroundSum / cell.nonGroundCount;
    cell.relativeHeight =
      cell.localGroundZ === null ? null : cell.nonGroundMeanZ - cell.localGroundZ;
    cell.roughness =
      cell.nonGroundMaxZ - cell.nonGroundMinZ;
    cell.vegetationShare =
      cell.count > 0 ? cell.vegetationCount / cell.count : 0;
    cell.elevated = cell.relativeHeight !== null && cell.relativeHeight > 1.5;
    cell.planar = cell.roughness <= 0.75;
    cell.eligible =
      (cell.elevated && (cell.class6Count > 0 || (cell.planar && cell.vegetationShare < 0.7))) ||
      (!cell.elevated && cell.localGroundZ === null && cell.class6Count >= 3);
  }

  const groups = [];
  const visited = new Set();
  for (const cell of cells.values()) {
    const startKey = `${cell.gx},${cell.gy}`;
    if (!cell.eligible || visited.has(startKey)) continue;
    const group = [];
    const queue = [cell];
    visited.add(startKey);
    while (queue.length) {
      const current = queue.pop();
      group.push(current);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nextKey = `${current.gx + dx},${current.gy + dy}`;
        const next = cells.get(nextKey);
        if (next?.eligible && !visited.has(nextKey)) {
          visited.add(nextKey);
          queue.push(next);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function scoreCandidate(group) {
  const extents = group.reduce(
    (result, cell) => ({
      minX: Math.min(result.minX, cell.gx),
      maxX: Math.max(result.maxX, cell.gx),
      minY: Math.min(result.minY, cell.gy),
      maxY: Math.max(result.maxY, cell.gy),
    }),
    {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
    },
  );
  const { minX, maxX, minY, maxY } = extents;
  const widthMeters = (maxX - minX + 1) * PROGRESSIVE_POINT_GRID_METERS;
  const lengthMeters = (maxY - minY + 1) * PROGRESSIVE_POINT_GRID_METERS;
  const areaSquareMeters =
    group.length * PROGRESSIVE_POINT_GRID_METERS ** 2;
  const pointCount = group.reduce((sum, cell) => sum + cell.count, 0);
  const class6Count = group.reduce((sum, cell) => sum + cell.class6Count, 0);
  const vegetationCount = group.reduce((sum, cell) => sum + cell.vegetationCount, 0);
  const groundCells = group.filter((cell) => cell.localGroundZ !== null);
  const elevatedCells = group.filter((cell) => cell.elevated);
  const planarCells = elevatedCells.filter((cell) => cell.planar);
  const roughnessValues = elevatedCells.map((cell) => cell.roughness);
  const medianRoughness = median(roughnessValues);
  const groundCoverage = group.length ? groundCells.length / group.length : 0;
  const planarCoverage = elevatedCells.length
    ? planarCells.length / elevatedCells.length
    : 0;
  const vegetationShare = pointCount ? vegetationCount / pointCount : 0;
  const class6Share = pointCount ? class6Count / pointCount : 0;
  const density = areaSquareMeters ? pointCount / areaSquareMeters : 0;
  const aspectRatio =
    Math.max(widthMeters, lengthMeters) / Math.max(1, Math.min(widthMeters, lengthMeters));
  let score = 0;
  const evidence = [];

  if (groundCoverage >= 0.75) {
    score += 20;
    evidence.push(`+20 local Class 2 ground samples support ${Math.round(groundCoverage * 100)}% of cells`);
  } else if (groundCoverage >= 0.35) {
    score += 10;
    evidence.push(`+10 local Class 2 ground samples support ${Math.round(groundCoverage * 100)}% of cells`);
  } else {
    evidence.push(`+0 insufficient local Class 2 ground coverage (${Math.round(groundCoverage * 100)}%)`);
  }
  if (planarCoverage >= 0.7 && elevatedCells.length >= 4) {
    score += 25;
    evidence.push(`+25 ${Math.round(planarCoverage * 100)}% of elevated cells have roughness ≤ 0.75 LAS Z units`);
  } else if (planarCoverage >= 0.4 && elevatedCells.length >= 2) {
    score += 12;
    evidence.push(`+12 ${Math.round(planarCoverage * 100)}% of elevated cells have roughness ≤ 0.75 LAS Z units`);
  } else {
    evidence.push(`+0 weak planar coverage (${Math.round(planarCoverage * 100)}% of elevated cells)`);
  }
  if (aspectRatio <= 4) {
    score += 15;
    evidence.push(`+15 compact footprint (aspect ratio ${aspectRatio.toFixed(1)}:1)`);
  } else if (aspectRatio <= 8) {
    score += 7;
    evidence.push(`+7 elongated but bounded footprint (aspect ratio ${aspectRatio.toFixed(1)}:1)`);
  } else {
    evidence.push(`+0 elongated footprint (aspect ratio ${aspectRatio.toFixed(1)}:1)`);
  }
  if (areaSquareMeters >= 16 && areaSquareMeters <= 2500) {
    score += 10;
    evidence.push(`+10 connected footprint area ${areaSquareMeters.toFixed(1)} m²`);
  } else {
    evidence.push(`+0 footprint area ${areaSquareMeters.toFixed(1)} m² outside heuristic range`);
  }
  if (density >= 2) {
    score += 10;
    evidence.push(`+10 point density ${density.toFixed(1)} points/m²`);
  } else {
    evidence.push(`+0 sparse point density ${density.toFixed(1)} points/m²`);
  }
  if (class6Share >= 0.1) {
    score += 15;
    evidence.push(`+15 Class 6 evidence (${class6Count} points; ${Math.round(class6Share * 100)}%)`);
  } else if (class6Count) {
    score += 7;
    evidence.push(`+7 Class 6 evidence (${class6Count} points; ${Math.round(class6Share * 100)}%)`);
  } else {
    evidence.push('+0 no Class 6 returns; candidate is based on non-Class-6 geometry only');
  }
  if (vegetationShare > 0.65) {
    score -= 25;
    evidence.push(`−25 vegetation dominates (${Math.round(vegetationShare * 100)}% of points)`);
  } else if (vegetationShare > 0.4) {
    score -= 10;
    evidence.push(`−10 substantial vegetation share (${Math.round(vegetationShare * 100)}% of points)`);
  } else {
    evidence.push(`+0 vegetation share ${Math.round(vegetationShare * 100)}%`);
  }
  if (groundCoverage < 0.35) {
    score = Math.min(score, 44);
    evidence.push('Confidence capped at 44 because local ground evidence is weak.');
  }
  score = Math.max(0, Math.min(100, score));
  return {
    score,
    evidence,
    dimensions: { widthMeters, lengthMeters, areaSquareMeters, aspectRatio },
    pointCount,
    class6Count,
    vegetationShare,
    groundCoverage,
    planarCoverage,
    medianRoughness,
    relativeHeightUnits: median(
      elevatedCells.map((cell) => cell.relativeHeight).filter(Number.isFinite),
    ),
    minX,
    maxX,
    minY,
    maxY,
    category: class6Count ? 'Class 6 evidence' : 'Non-Class-6 roof-like geometry',
  };
}

export function detectCandidates(tiles, geographicBounds) {
  const groups = groupCandidateCells(pointGrid(tiles));
  const centerLongitude = (geographicBounds.west + geographicBounds.east) / 2;
  const centerLatitude = (geographicBounds.south + geographicBounds.north) / 2;
  const longitudeScale =
    111_319.49079327358 * Math.cos((centerLatitude * Math.PI) / 180);
  const candidates = [];

  for (const group of groups) {
    const metrics = scoreCandidate(group);
    const class6Candidate = metrics.class6Count >= 10 && group.length >= 2;
    const roofCandidate =
      metrics.dimensions.areaSquareMeters >= 25 &&
      metrics.pointCount >= 40 &&
      metrics.groundCoverage >= 0.35 &&
      metrics.planarCoverage >= 0.4 &&
      metrics.vegetationShare < 0.7;
    if (!class6Candidate && !roofCandidate) continue;
    metrics.evidence.unshift(
      class6Candidate
        ? `Candidate gate: ≥10 Class 6 returns across at least 2 connected cells.`
        : 'Candidate gate: ≥25 m², ≥40 points, ≥35% local ground coverage, ≥40% planar elevated cells, and vegetation share <70%.',
    );

    const localX =
      ((metrics.minX + metrics.maxX + 1) / 2) * PROGRESSIVE_POINT_GRID_METERS;
    const localY =
      ((metrics.minY + metrics.maxY + 1) / 2) * PROGRESSIVE_POINT_GRID_METERS;
    const latitude = centerLatitude + localY / 111_319.49079327358;
    const longitude = centerLongitude + localX / longitudeScale;
    const west =
      centerLongitude +
      (metrics.minX * PROGRESSIVE_POINT_GRID_METERS) / longitudeScale;
    const east =
      centerLongitude +
      ((metrics.maxX + 1) * PROGRESSIVE_POINT_GRID_METERS) / longitudeScale;
    const south =
      centerLatitude +
      (metrics.minY * PROGRESSIVE_POINT_GRID_METERS) / 111_319.49079327358;
    const north =
      centerLatitude +
      ((metrics.maxY + 1) * PROGRESSIVE_POINT_GRID_METERS) / 111_319.49079327358;
    candidates.push({
      ...metrics,
      id: `scan-${String(candidates.length + 1).padStart(3, '0')}`,
      latitude,
      longitude,
      bbox: { west, south, east, north },
      confidence:
        metrics.score >= 75 ? 'High' : metrics.score >= 50 ? 'Medium' : 'Low',
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return {
    candidates: candidates.slice(0, MAX_CANDIDATE_RESULTS),
    totalCandidateCount: candidates.length,
  };
}

export function makeDisplaySample(tiles, pointBudget) {
  const total = tiles.reduce((count, tile) => count + tile.areaPoints, 0);
  const target = Math.min(total, pointBudget);
  const positions = new Float32Array(target * 3);
  const classes = new Uint8Array(target);
  if (!target) return { positions, classes, count: 0 };

  let cursor = 0;
  const scale = total / target;
  let globalIndex = 0;
  for (const tile of tiles) {
    for (let index = 0; index < tile.areaPoints; index += 1, globalIndex += 1) {
      const targetIndex = Math.floor(globalIndex / scale);
      if (targetIndex !== cursor) continue;
      positions[cursor * 3] = tile.positions[index * 3];
      positions[cursor * 3 + 1] = tile.positions[index * 3 + 1];
      positions[cursor * 3 + 2] = tile.positions[index * 3 + 2];
      classes[cursor] = tile.classifications[index];
      cursor += 1;
    }
  }
  if (cursor === target) return { positions, classes, count: cursor };
  return {
    positions: positions.slice(0, cursor * 3),
    classes: classes.slice(0, cursor),
    count: cursor,
  };
}
