import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import './scanner.css';
import { getCoverageMessage, discoverDatasets } from './discovery.js';
import { googleEarthUrl } from './google-earth.js';
import {
  makeDisplaySample,
  scanDatasets,
} from './scanner-engine.js';
import {
  getCandidateMatch,
  isReviewOwner,
  listenToCandidateReviews,
  listenToOwnerAuth,
  removePreviouslyRemovedCandidates,
  saveScannedCandidates,
  setCandidateRemoved,
  signInOwnerWithGoogle,
  signOutOwner,
} from './candidate-reviews.js';

const elements = {
  searchForm: document.querySelector('#search-form'),
  searchInput: document.querySelector('#location-search'),
  clear: document.querySelector('#clear-selection'),
  scan: document.querySelector('#scan-area'),
  cancel: document.querySelector('#cancel-scan'),
  statusTitle: document.querySelector('#status-title'),
  statusDetail: document.querySelector('#status-detail'),
  coverageBadge: document.querySelector('#coverage-badge'),
  progress: document.querySelector('#scan-progress'),
  viewerTitle: document.querySelector('#viewer-title'),
  viewerCount: document.querySelector('#viewer-count'),
  canvas: document.querySelector('#point-canvas'),
  candidateTitle: document.querySelector('#candidate-title'),
  candidateSummary: document.querySelector('#candidate-summary'),
  candidateList: document.querySelector('#candidate-list'),
  diagnostics: document.querySelector('#diagnostics-list'),
  ownerSignIn: document.querySelector('#owner-sign-in'),
  ownerSignOut: document.querySelector('#owner-sign-out'),
  ownerAccountStatus: document.querySelector('#owner-account-status'),
  ownerPanelStatus: document.querySelector('#owner-panel-status'),
  removedCandidateList: document.querySelector('#removed-candidate-list'),
};

const diagnostics = {
  requestCount: 0,
  requestLog: [],
  downloadedBytes: 0,
};
const MAX_SCAN_SIDE_METERS = 2000;
let candidateReviews = [];
let candidateSubmissions = [];
let reviewStoreReady = false;
let reviewStoreError = null;
let currentUser = null;
let currentCandidates = [];
let currentCandidateCount = 0;
let hasCandidateScan = false;
let candidateStoreUnavailable = false;
let reviewSync = null;
const selectionGroup = L.featureGroup();
const class6Group = L.featureGroup();
const roofGroup = L.featureGroup();
const baseStreet = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
});
const baseSatellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    maxZoom: 19,
    attribution:
      'Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
);
const map = L.map('map', {
  center: [20, 0],
  zoom: 2,
  layers: [baseSatellite, selectionGroup, class6Group, roofGroup],
  zoomControl: true,
});
L.control
  .layers(
    { Streets: baseStreet, Satellite: baseSatellite },
    {
      'Selection boundary': selectionGroup,
      'Existing Class 6 evidence': class6Group,
      'New roof-like candidates': roofGroup,
    },
    { collapsed: true },
  )
  .addTo(map);
L.control.scale({ metric: true, imperial: true, maxWidth: 140 }).addTo(map);

let selectionLayer = null;
let selectedBounds = null;
let scanController = null;
let renderer = null;
let tiles = [];
let searchMarker = null;
let searchPending = false;
let displayedPointCount = 0;
let scanHeartbeat = null;

function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function updateStatus(title, detail) {
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
}

function setCoverageStatus(label, state) {
  elements.coverageBadge.textContent = label;
  elements.coverageBadge.dataset.state = state;
}

function readBounds() {
  if (!selectedBounds) throw new Error('Draw a rectangle on the map first.');
  const rawBounds = {
    west: selectedBounds.getWest(),
    south: selectedBounds.getSouth(),
    east: selectedBounds.getEast(),
    north: selectedBounds.getNorth(),
  };
  if (
    !Object.values(rawBounds).every(Number.isFinite) ||
    rawBounds.west >= rawBounds.east ||
    rawBounds.south >= rawBounds.north
  ) {
    throw new Error('The drawn rectangle has invalid geographic coordinates. Clear it and draw it again.');
  }
  const maxLatitude = 85.0511287798066;
  if (rawBounds.south < -maxLatitude || rawBounds.north > maxLatitude) {
    throw new Error(
      `The rectangle must stay between ${(-maxLatitude).toFixed(3)}° and ${maxLatitude.toFixed(3)}° latitude.`,
    );
  }

  const longitudeCenter = (rawBounds.west + rawBounds.east) / 2;
  const worldOffset = 360 * Math.floor((longitudeCenter + 180) / 360);
  const bounds = {
    ...rawBounds,
    west: rawBounds.west - worldOffset,
    east: rawBounds.east - worldOffset,
  };
  if (bounds.west < -180 || bounds.east > 180) {
    throw new Error(
      'This rectangle crosses the 180° dateline. Draw a smaller rectangle entirely on one side of it.',
    );
  }
  const centerLatitude = (bounds.south + bounds.north) / 2;
  const widthMeters =
    (bounds.east - bounds.west) *
    111_319.49079327358 *
    Math.cos((centerLatitude * Math.PI) / 180);
  const heightMeters = (bounds.north - bounds.south) * 111_319.49079327358;
  if (widthMeters > MAX_SCAN_SIDE_METERS || heightMeters > MAX_SCAN_SIDE_METERS) {
    throw new Error(
      `For browser memory safety, each side of a scan rectangle must be no larger than ${MAX_SCAN_SIDE_METERS.toLocaleString()} m.`,
    );
  }
  return { ...bounds, widthMeters, heightMeters };
}

function updateActions() {
  const scanning = scanController !== null;
  elements.scan.disabled = !selectedBounds || scanning || searchPending;
  elements.clear.disabled = !selectedBounds || scanning;
  elements.cancel.hidden = !scanning;
  elements.searchInput.disabled = scanning || searchPending;
  elements.searchForm.querySelector('button').disabled = scanning || searchPending;
}

function setSelection(layer) {
  if (scanController) return;
  if (selectionLayer) selectionGroup.removeLayer(selectionLayer);
  selectionLayer = layer;
  selectionGroup.addLayer(layer);
  selectedBounds = layer.getBounds();
  clearResults();
  updateActions();
  updateStatus('Area selected', `Select Scan Area to check USGS coverage and retrieve intersecting EPT nodes. Each rectangle side is limited to ${MAX_SCAN_SIDE_METERS.toLocaleString()} m; source-point limits still apply.`);
  setCoverageStatus('Not scanned', 'idle');
}

const drawControl = new L.Control.Draw({
  position: 'topright',
  draw: {
    rectangle: {
      shapeOptions: { color: '#47c7a6', weight: 2, fillOpacity: 0.08 },
      showArea: false,
    },
    polygon: false,
    polyline: false,
    circle: false,
    circlemarker: false,
    marker: false,
  },
  edit: false,
});
map.addControl(drawControl);
map.on(L.Draw.Event.CREATED, (event) => {
  setSelection(event.layer);
});

function clearResults() {
  tiles = [];
  displayedPointCount = 0;
  currentCandidates = [];
  currentCandidateCount = 0;
  hasCandidateScan = false;
  candidateStoreUnavailable = false;
  renderCandidateLayers();
  elements.viewerTitle.textContent = 'Waiting for real EPT points';
  elements.viewerCount.textContent = '0 points';
  elements.candidateTitle.textContent = 'No candidates yet';
  elements.candidateSummary.replaceChildren();
  elements.candidateList.replaceChildren();
  const message = document.createElement('p');
  message.className = 'muted';
  message.textContent = 'Run a scan to see candidate structure evidence.';
  elements.candidateList.append(message);
  elements.diagnostics.replaceChildren();
  appendDiagnostic('Status', 'No scan run');
  if (renderer) renderer.clear();
}

function clearSelection() {
  if (scanController) return;
  if (selectionLayer) selectionGroup.removeLayer(selectionLayer);
  selectionLayer = null;
  selectedBounds = null;
  selectionGroup.clearLayers();
  clearResults();
  elements.progress.removeAttribute('value');
  updateActions();
  updateStatus('Choose an area on the map', 'Use the rectangle tool, then select Scan Area.');
  setCoverageStatus('Not scanned', 'idle');
}

function appendDiagnostic(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = String(value);
  elements.diagnostics.append(dt, dd);
}

function setDiagnostics(rows) {
  elements.diagnostics.replaceChildren();
  for (const [label, value] of rows) appendDiagnostic(label, value);
}

function createPointRenderer(canvas) {
  const gl =
    canvas.getContext('webgl2', { antialias: false, alpha: false }) ||
    canvas.getContext('webgl', { antialias: false, alpha: false });
  if (!gl) throw new Error('WebGL is unavailable in this browser.');

  const vertexSource = `
    attribute vec3 a_position;
    attribute float a_class;
    uniform vec2 u_halfSize;
    uniform float u_heightRange;
    uniform float u_heightCenter;
    uniform float u_pointSize;
    varying vec3 v_color;
    void main() {
      gl_Position = vec4(
        a_position.x / u_halfSize.x,
        a_position.y / u_halfSize.y,
        clamp((a_position.z - u_heightCenter) / u_heightRange * 0.08, -0.85, 0.85),
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
    void main() { gl_FragColor = vec4(v_color, 0.94); }
  `;
  function compile(type, source) {
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
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`WebGL program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const positionAttribute = gl.getAttribLocation(program, 'a_position');
  const classAttribute = gl.getAttribLocation(program, 'a_class');
  const halfSizeUniform = gl.getUniformLocation(program, 'u_halfSize');
  const heightRangeUniform = gl.getUniformLocation(program, 'u_heightRange');
  const heightCenterUniform = gl.getUniformLocation(program, 'u_heightCenter');
  const pointSizeUniform = gl.getUniformLocation(program, 'u_pointSize');
  const positionBuffer = gl.createBuffer();
  const classBuffer = gl.createBuffer();
  let drawCount = 0;
  let halfWidth = 1;
  let halfHeight = 1;
  let zRange = 1;
  let zCenter = 0;

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
    gl.uniform2f(halfSizeUniform, halfWidth, halfHeight);
    gl.uniform1f(heightRangeUniform, zRange);
    gl.uniform1f(heightCenterUniform, zCenter);
    gl.uniform1f(pointSizeUniform, Math.max(1, Math.min(3, window.devicePixelRatio || 1)));
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionAttribute);
    gl.vertexAttribPointer(positionAttribute, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, classBuffer);
    gl.enableVertexAttribArray(classAttribute);
    gl.vertexAttribPointer(classAttribute, 1, gl.UNSIGNED_BYTE, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, drawCount);
  }

  function install(sample, bounds) {
    halfWidth = Math.max(1, bounds.widthMeters / 2);
    halfHeight = Math.max(1, bounds.heightMeters / 2);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < sample.count; index += 1) {
      const z = sample.positions[index * 3 + 2];
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    zCenter = Number.isFinite(minZ) ? (minZ + maxZ) / 2 : 0;
    zRange = Math.max(1, maxZ - minZ);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, sample.positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, classBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, sample.classes, gl.DYNAMIC_DRAW);
    drawCount = sample.count;
    draw();
  }

  function clear() {
    drawCount = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, classBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(0), gl.DYNAMIC_DRAW);
    draw();
  }

  return { draw, install, clear };
}

function sampleFps(durationMs = 1000) {
  return new Promise((resolve) => {
    const intervals = [];
    let last = performance.now();
    const started = last;
    const frame = (now) => {
      renderer?.draw();
      intervals.push(now - last);
      last = now;
      if (now - started >= durationMs) {
        resolve(Number((intervals.length / ((now - started) / 1000)).toFixed(2)));
      } else {
        requestAnimationFrame(frame);
      }
    };
    requestAnimationFrame(frame);
  });
}

function refreshPointView(bounds, pointBudget) {
  if (!renderer) return;
  const sample = makeDisplaySample(tiles, pointBudget);
  renderer.install(sample, bounds);
  displayedPointCount = sample.count;
  elements.viewerCount.textContent =
    `${formatCount(tiles.reduce((sum, tile) => sum + tile.areaPoints, 0))} in-box points · ` +
    `${formatCount(sample.count)} displayed`;
}

function confidenceColor(candidate) {
  if (candidate.score >= 75) return '#e05252';
  if (candidate.score >= 50) return '#e5a331';
  return '#78838c';
}

function makePopup(candidate) {
  const content = document.createElement('div');
  content.className = 'candidate-popup';
  const title = document.createElement('strong');
  title.textContent = `${candidate.id} · ${candidate.category}`;
  const coords = document.createElement('span');
  coords.textContent =
    `${candidate.latitude.toFixed(6)}, ${candidate.longitude.toFixed(6)}`;
  const score = document.createElement('span');
  score.textContent = `${candidate.confidence} heuristic confidence · ${candidate.score}/100`;
  const actions = document.createElement('div');
  actions.className = 'candidate-popup-actions';
  const earthLink = document.createElement('a');
  earthLink.href = googleEarthUrl(candidate);
  earthLink.target = '_blank';
  earthLink.rel = 'noopener noreferrer';
  earthLink.textContent = 'View in Google Earth 3D';
  actions.append(earthLink);
  content.append(title, coords, score, actions);
  return content;
}

function addCandidateToMap(candidate) {
  const color = confidenceColor(candidate);
  const targetGroup = candidate.class6Count ? class6Group : roofGroup;
  const rectangle = L.rectangle(
    [
      [candidate.bbox.south, candidate.bbox.west],
      [candidate.bbox.north, candidate.bbox.east],
    ],
    { color, weight: 1.5, fillColor: color, fillOpacity: 0.1 },
  );
  const marker = L.circleMarker([candidate.latitude, candidate.longitude], {
    radius: 5,
    color: '#f5f2e9',
    weight: 1,
    fillColor: color,
    fillOpacity: 0.95,
  });
  rectangle.bindPopup(makePopup(candidate));
  marker.bindPopup(makePopup(candidate));
  rectangle.addTo(targetGroup);
  marker.addTo(targetGroup);
}

function renderCandidateLayers() {
  class6Group.clearLayers();
  roofGroup.clearLayers();
  const visible = new Map();
  for (const review of candidateReviews) {
    if (!review.removed) visible.set(review.id, review);
  }
  for (const submission of candidateSubmissions) {
    if (!getCandidateMatch(submission, candidateReviews)) {
      visible.set(submission.id, submission);
    }
  }
  for (const candidate of currentCandidates) {
    if (getCandidateMatch(candidate, candidateReviews)) continue;
    visible.set(candidate.id, candidate);
  }
  for (const candidate of visible.values()) addCandidateToMap(candidate);
}

function addCandidateRow(candidate) {
  const article = document.createElement('article');
  article.className = 'candidate-card';
  const heading = document.createElement('div');
  heading.className = 'candidate-card-heading';
  const title = document.createElement('h3');
  title.textContent = `${candidate.id} · ${candidate.category}`;
  const badge = document.createElement('span');
  badge.className = 'confidence-chip';
  badge.dataset.confidence = candidate.confidence.toLowerCase();
  badge.textContent = `${candidate.confidence} · ${candidate.score}/100`;
  heading.append(title, badge);
  const summary = document.createElement('p');
  summary.textContent =
    `${candidate.latitude.toFixed(6)}, ${candidate.longitude.toFixed(6)} · ` +
    `${candidate.dimensions.widthMeters.toFixed(1)} × ${candidate.dimensions.lengthMeters.toFixed(1)} m · ` +
    `${formatCount(candidate.pointCount)} points`;
  const evidence = document.createElement('ul');
  evidence.className = 'evidence-list';
  for (const detail of candidate.evidence) {
    const item = document.createElement('li');
    item.textContent = detail;
    evidence.append(item);
  }
  const height = document.createElement('p');
  height.className = 'candidate-height';
  height.textContent =
    candidate.relativeHeightUnits === null
      ? 'Ground-relative height: not estimated (no nearby Class 2 ground samples).'
      : `Median height over nearby Class 2 ground: ${candidate.relativeHeightUnits.toFixed(2)} LAS Z units (vertical units/reference unverified).`;
  article.append(heading, summary, height, evidence);
  if (isReviewOwner(currentUser)) {
    const removeButton = document.createElement('button');
    removeButton.className = 'candidate-remove-button';
    removeButton.type = 'button';
    removeButton.textContent = 'Remove shared marker';
    removeButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      removeButton.disabled = true;
      try {
        await setCandidateRemoved(candidate, true);
        elements.ownerPanelStatus.textContent = 'Marker removed for all visitors and will stay removed after rescans.';
      } catch (error) {
        elements.ownerPanelStatus.textContent = `Could not remove marker: ${error.message}`;
        removeButton.disabled = false;
      }
    });
    article.append(removeButton);
  }
  article.addEventListener('click', () => {
    map.fitBounds(
      [
        [candidate.bbox.south, candidate.bbox.west],
        [candidate.bbox.north, candidate.bbox.east],
      ],
      { maxZoom: 19, padding: [40, 40] },
    );
  });
  elements.candidateList.append(article);
}

function showCandidates(candidates, totalCandidateCount = candidates.length) {
  currentCandidates = candidates;
  currentCandidateCount = totalCandidateCount;
  hasCandidateScan = true;
  candidateStoreUnavailable = false;
  renderCandidateLayers();
  elements.candidateList.replaceChildren();
  const high = candidates.filter((candidate) => candidate.confidence === 'High').length;
  const medium = candidates.filter((candidate) => candidate.confidence === 'Medium').length;
  const low = candidates.length - high - medium;
  elements.candidateTitle.textContent = totalCandidateCount
    ? `${formatCount(totalCandidateCount)} potential structure candidate(s)`
    : 'No candidates passed the evidence filters';
  elements.candidateSummary.replaceChildren();
  for (const [label, value] of [
    ['High', high],
    ['Medium', medium],
    ['Low', low],
  ]) {
    const chip = document.createElement('span');
    chip.className = 'summary-chip';
    chip.dataset.confidence = label.toLowerCase();
    chip.textContent = `${label}: ${value}`;
    elements.candidateSummary.append(chip);
  }
  if (!candidates.length) {
    const message = document.createElement('p');
    message.className = 'muted';
    message.textContent =
      'No connected footprint met the heuristic filters. This does not prove that the selected area contains no buildings.';
    elements.candidateList.append(message);
    return;
  }
  for (const candidate of candidates) {
    addCandidateRow(candidate);
  }
  if (totalCandidateCount > candidates.length) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent =
      `Showing the ${formatCount(candidates.length)} highest-scoring candidates of ${formatCount(totalCandidateCount)}; the remainder are not added to the map to keep it responsive.`;
    elements.candidateList.append(note);
  }
}

function showCandidateStoreUnavailable(message) {
  currentCandidates = [];
  currentCandidateCount = 0;
  hasCandidateScan = true;
  candidateStoreUnavailable = true;
  renderCandidateLayers();
  elements.candidateTitle.textContent = 'Shared candidate markers unavailable';
  elements.candidateSummary.replaceChildren();
  elements.candidateList.replaceChildren();
  const notice = document.createElement('p');
  notice.className = 'muted';
  notice.textContent =
    `Candidate detections are hidden so removed markers cannot reappear. ${message}`;
  elements.candidateList.append(notice);
}

function reviewIntersectsBounds(review, bounds) {
  return (
    review.bbox.west <= bounds.east &&
    review.bbox.east >= bounds.west &&
    review.bbox.south <= bounds.north &&
    review.bbox.north >= bounds.south
  );
}

function renderRemovedReviews() {
  elements.removedCandidateList.replaceChildren();
  if (!isReviewOwner(currentUser)) return;
  const removed = candidateReviews.filter((review) => review.removed);
  if (!removed.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No removed markers. Remove a candidate from the results list to add it here.';
    elements.removedCandidateList.append(empty);
    return;
  }
  const heading = document.createElement('h3');
  heading.textContent = `Removed markers (${formatCount(removed.length)})`;
  elements.removedCandidateList.append(heading);
  for (const review of removed) {
    const row = document.createElement('div');
    row.className = 'removed-candidate-row';
    const details = document.createElement('span');
    details.textContent =
      `${review.id} · ${review.latitude.toFixed(6)}, ${review.longitude.toFixed(6)} · ` +
      `${review.confidence} ${review.score}/100`;
    const restore = document.createElement('button');
    restore.className = 'secondary-button';
    restore.type = 'button';
    restore.textContent = 'Restore';
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      try {
        await setCandidateRemoved(review, false);
        elements.ownerPanelStatus.textContent = 'Marker restored for all visitors.';
      } catch (error) {
        elements.ownerPanelStatus.textContent = `Could not restore marker: ${error.message}`;
        restore.disabled = false;
      }
    });
    row.append(details, restore);
    elements.removedCandidateList.append(row);
  }
}

function renderOwnerPanel() {
  const owner = isReviewOwner(currentUser);
  elements.ownerSignIn.hidden = owner;
  elements.ownerSignOut.hidden = !owner;
  if (owner) {
    elements.ownerAccountStatus.textContent =
      `Owner signed in${currentUser.displayName ? ` as ${currentUser.displayName}` : ''}.`;
  } else if (currentUser?.isAnonymous) {
    elements.ownerAccountStatus.textContent =
      'Anonymous scan identity ready; your scans are saved to shared markers.';
  } else if (currentUser) {
    elements.ownerAccountStatus.textContent =
      'Signed in; scans are saved to shared markers. Use the owner account to remove or restore markers.';
  } else {
    elements.ownerAccountStatus.textContent =
      'Scans save automatically. Sign in with the owner Google account to remove or restore markers.';
  }
  elements.ownerPanelStatus.textContent = reviewStoreError
    ? `Shared marker storage unavailable: ${reviewStoreError}. Check the Realtime Database rules and enable Anonymous Authentication.`
    : reviewStoreReady
      ? `${formatCount(candidateSubmissions.length)} shared scan marker(s) and ${formatCount(candidateReviews.filter((review) => review.removed).length)} removed marker(s) loaded.`
      : 'Connecting to shared marker storage…';
  renderRemovedReviews();
  if (hasCandidateScan && !candidateStoreUnavailable) {
    showCandidates(
      removePreviouslyRemovedCandidates(currentCandidates, candidateReviews),
      currentCandidateCount,
    );
  }
}

async function waitForReviewStore(timeoutMs) {
  let timeout;
  const result = await Promise.race([
    reviewSync.ready,
    new Promise((resolve) => {
      timeout = window.setTimeout(
        () =>
          resolve({
            ok: false,
            error: new Error('Timed out waiting for shared marker storage.'),
          }),
        timeoutMs,
      );
    }),
  ]);
  if (timeout) window.clearTimeout(timeout);
  return result;
}

function getHeapBytes() {
  if (performance.memory && Number.isFinite(performance.memory.usedJSHeapSize)) {
    return {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      api: 'Chromium performance.memory; excludes some worker/WASM/GPU memory.',
    };
  }
  return { usedJSHeapSize: null, api: 'Browser heap measurement unavailable.' };
}

function startHeartbeat() {
  const state = { lastTime: performance.now(), maxGapMs: 0, stalled: false };
  const resetForVisibility = () => {
    state.lastTime = performance.now();
  };
  document.addEventListener('visibilitychange', resetForVisibility);
  const timer = window.setInterval(() => {
    const now = performance.now();
    const gap = now - state.lastTime;
    state.maxGapMs = Math.max(state.maxGapMs, gap);
    if (!document.hidden && gap >= 2000) state.stalled = true;
    state.lastTime = now;
  }, 100);
  return {
    state,
    stop() {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resetForVisibility);
    },
  };
}

function makeDiagnostics(discovery, scan, candidates, bounds, scanElapsedMs, fps) {
  const compressedBytesRetained = tiles.reduce(
    (sum, tile) => sum + tile.rawLaz.byteLength,
    0,
  );
  const payloadBytes =
    compressedBytesRetained + (scan.typedArrayBytesBeforeAnalysis || 0);
  const heap = getHeapBytes();
  const rejected = discovery.rejected.length
    ? discovery.rejected.map((item) => `${item.id}: ${item.reason}`).join(' | ')
    : 'None';
  setDiagnostics([
    ['Coverage', getCoverageMessage(discovery)],
    ['USGS coverage products', discovery.coverage.total ?? 'unavailable'],
    ['EPT surveys selected', discovery.datasets.length],
    ['EPT items / spatial index', `${discovery.catalogItemCount} / ${discovery.indexItemCount}`],
    ['Spatial index generated', discovery.indexGeneratedAt],
    ['Spatial index current', discovery.indexIsCurrent ? 'Yes' : 'No; regenerate before deployment'],
    ['Rejected EPT items', rejected],
    ['Horizontal CRS', discovery.datasets.map((dataset) => dataset.horizontalCrs).join(', ') || 'None'],
    ['Selection dimensions', `${bounds.widthMeters.toFixed(1)} × ${bounds.heightMeters.toFixed(1)} approximate metres`],
    ['Requests (USGS data; excludes map tiles/search)', diagnostics.requestCount],
    ['Total data received', formatBytes(diagnostics.downloadedBytes)],
    ['Compressed LAZ data', formatBytes(scan.compressedBytes)],
    ['Hierarchy files', scan.hierarchyFiles],
    ['Intersecting EPT nodes', scan.nodes.length],
    ['Source records decoded', formatCount(scan.downloadedPoints)],
    ['Points inside geographic box', formatCount(scan.pointsInSelection)],
    ['Points displayed (downsampled sample)', formatCount(displayedPointCount)],
    ['Class 6 in-box points', formatCount(scan.class6PointCount || 0)],
    ['LAZ decompression (worker sum)', `${scan.decodeMs.toFixed(0)} ms`],
    ['Node download (worker sum)', `${scan.downloadMs.toFixed(0)} ms`],
    ['Time to first points', scan.firstPointsMs === null ? 'no points returned' : `${scan.firstPointsMs.toFixed(0)} ms`],
    ['Time to full detail', `${scan.timing.fullDetailMs.toFixed(0)} ms`],
    ['Total scan time', `${scanElapsedMs.toFixed(0)} ms`],
    ['Render frame rate', renderer ? `${fps} fps` : 'WebGL unavailable'],
    ['Adaptive decoder workers', scan.profile.workers],
    ['Adaptive display budget', formatCount(scan.profile.displayPoints)],
    ['LAZ / point-array payload', `${formatBytes(payloadBytes)} measured; LAZ retained, analysis arrays released after worker transfer`],
    ['Browser JavaScript heap', heap.usedJSHeapSize === null ? heap.api : formatBytes(heap.usedJSHeapSize)],
    ['Maximum UI heartbeat gap', `${scanHeartbeat.state.maxGapMs.toFixed(1)} ms`],
    ['UI stall threshold reached', scanHeartbeat.state.stalled ? 'Yes (≥ 2,000 ms gap)' : 'No'],
    ['Candidate confidence', 'Explainable heuristic only; not independently validated or a building confirmation.'],
    ['Height values', 'LAS Z units only; vertical units and reference remain unverified.'],
    ['Download/storage policy', 'Shared candidate marker metadata and removal flags are stored in Firebase; raw LiDAR points and full scan rectangles are not.'],
    ['Point evidence', `${formatCount(scan.pointsInSelection)} actual decoded LiDAR points; no points are synthesized.`],
    ['Potential candidates found', scan.totalCandidateCount],
    ['Candidates displayed', candidates.length],
    ['Scan source point estimate', `${formatCount(scan.expectedPoints)} intersecting-node records; full records were downloaded.`],
    ['Browser guardrail', `Maximum ${formatCount(scan.profile.maxSourcePoints)} intersecting node records for this device profile.`],
  ]);
}

async function analyzeCandidates(bounds) {
  if (!tiles.length) return [];
  const typedArrayBytes = tiles.reduce(
    (sum, tile) => sum + tile.positions.byteLength + tile.classifications.byteLength,
    0,
  );
  const class6Points = tiles.reduce(
    (sum, tile) =>
      sum +
      tile.classifications.reduce(
        (count, classification) => count + (classification === 6 ? 1 : 0),
        0,
      ),
    0,
  );
  const analysisTiles = tiles.map((tile) => ({
    areaPoints: tile.areaPoints,
    positions: tile.positions,
    classifications: tile.classifications,
  }));
  const transfer = [];
  for (const tile of analysisTiles) {
    transfer.push(tile.positions.buffer, tile.classifications.buffer);
  }
  const worker = new Worker(new URL('./detection-worker.js', import.meta.url), {
    type: 'module',
  });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.addEventListener(
        'message',
        (event) => {
          if (event.data.type === 'complete') resolve(event.data.result);
          else reject(new Error(event.data.message || 'Candidate analysis failed.'));
        },
        { once: true },
      );
      worker.addEventListener(
        'error',
        (event) => reject(new Error(event.message || 'Candidate analysis worker failed.')),
        { once: true },
      );
      worker.postMessage({ tiles: analysisTiles, bounds }, transfer);
    });
    for (const tile of tiles) {
      tile.positions = new Float32Array(0);
      tile.classifications = new Uint8Array(0);
    }
    return { ...result, typedArrayBytes, class6Points };
  } finally {
    worker.terminate();
  }
}

async function scanArea() {
  if (scanController) return;
  let bounds;
  try {
    bounds = readBounds();
  } catch (error) {
    updateStatus('Cannot start scan', error.message);
    return;
  }

  clearResults();
  Object.assign(diagnostics, {
    requestCount: 0,
    requestLog: [],
    downloadedBytes: 0,
  });
  elements.progress.removeAttribute('value');
  elements.scan.disabled = true;
  elements.clear.disabled = true;
  scanController = new AbortController();
  updateActions();
  setCoverageStatus('Checking coverage', 'loading');
  updateStatus('Discovering USGS data', 'Querying official LiDAR coverage and spatially matching real EPT survey footprints.');
  const scanStarted = performance.now();
  scanHeartbeat = startHeartbeat();
  let discovery = null;
  let scan = null;
  let candidates = [];
  let rendererError = null;

  try {
    try {
      renderer = createPointRenderer(elements.canvas);
    } catch (error) {
      renderer = null;
      rendererError = error.message;
      elements.viewerTitle.textContent = 'WebGL unavailable';
    }

    discovery = await discoverDatasets(
      bounds,
      scanController.signal,
      diagnostics,
      (message) => updateStatus('Discovering USGS data', message),
    );
    const coverageMessage = getCoverageMessage(discovery);
    const hasCoverage = discovery.coverage.total > 0 || discovery.datasets.length > 0;
    setCoverageStatus(
      discovery.datasets.length
        ? 'EPT available'
        : discovery.coverage.total > 0
          ? 'LiDAR found · no EPT'
          : discovery.coverage.total === 0
            ? 'No LiDAR found'
            : 'Coverage unverified',
      discovery.datasets.length ? 'available' : hasCoverage ? 'partial' : 'none',
    );
    if (!discovery.datasets.length) {
      updateStatus('Discovery complete', coverageMessage);
      elements.viewerTitle.textContent = 'No validated EPT points for this area';
      setDiagnostics([
        ['Coverage', coverageMessage],
        ['USGS coverage products', discovery.coverage.total ?? 'unavailable'],
        ['EPT items checked', discovery.catalogItemCount],
        ['Spatial index current', discovery.indexIsCurrent ? 'Yes' : 'No'],
        ['EPT items rejected', discovery.rejected.map((item) => `${item.id}: ${item.reason}`).join(' | ') || 'None'],
        ['Requests (USGS data; excludes map tiles/search)', diagnostics.requestCount],
        ['Data received', formatBytes(diagnostics.downloadedBytes)],
        ['Interpretation', 'Coverage found without validated EPT is different from no listed LiDAR coverage.'],
      ]);
      return;
    }
    if (!discovery.indexIsCurrent) {
      updateStatus('Warning: spatial index is stale', 'The EPT catalog has a different number of items than the bundled index; results may omit recently added surveys.');
    } else {
      updateStatus('EPT coverage found', coverageMessage);
    }
    if (discovery.rejected.length) {
      const rejectedSummary = discovery.rejected
        .map((item) => `${item.id}: ${item.reason}`)
        .join('; ');
      elements.statusDetail.textContent += ` Rejected resources: ${rejectedSummary}`;
    }
    elements.viewerTitle.textContent = `Preparing ${discovery.datasets.length} validated EPT survey(s)`;
    scan = await scanDatasets(
      discovery.datasets,
      bounds,
      diagnostics,
      scanController.signal,
      (message, completed, total) => {
        if (Number.isFinite(completed) && Number.isFinite(total)) {
          elements.progress.max = total;
          elements.progress.value = completed;
        } else {
          elements.progress.removeAttribute('value');
        }
        updateStatus('Scanning LiDAR', message);
      },
      (tile, dataset, progress) => {
        tiles.push(tile);
        elements.viewerTitle.textContent = `LiDAR points · ${dataset.itemId}`;
        if (renderer && (progress.nodes.length === 1 || progress.nodes.length % 20 === 0)) {
          refreshPointView(bounds, scan?.profile.displayPoints || 100_000);
        }
        const downloaded = progress.downloadedPoints.toLocaleString();
        const inBox = progress.pointsInSelection.toLocaleString();
        updateStatus(
          'Scanning LiDAR',
          `${downloaded} source records decoded; ${inBox} points fall inside the selected geographic rectangle.`,
        );
      },
      scanStarted,
    );
    if (elements.progress.max !== 0) {
      elements.progress.value = elements.progress.max;
    }
    if (renderer) refreshPointView(bounds, scan.profile.displayPoints);
    updateStatus('Analyzing point evidence', 'Grouping actual in-box returns and comparing elevated cells with nearby Class 2 ground samples.');
    const analysis = await analyzeCandidates(bounds);
    const reviewState = await waitForReviewStore(10_000);
    if (!reviewState.ok || reviewStoreError || !reviewStoreReady) {
      const storageMessage =
        reviewStoreError || reviewState.error?.message || 'Shared marker storage is not ready.';
      showCandidateStoreUnavailable(storageMessage);
      scan.detectedCandidateCount = analysis.totalCandidateCount;
      scan.totalCandidateCount = 0;
      const fps = renderer ? await sampleFps() : null;
      const scanElapsedMs = performance.now() - scanStarted;
      elements.viewerTitle.textContent = rendererError
        ? `Points decoded; rendering unavailable: ${rendererError}`
        : 'Actual USGS EPT points rendered';
      updateStatus(
        'Scan complete · candidate markers hidden',
        `${formatCount(scan.pointsInSelection)} actual points decoded. ${formatCount(analysis.totalCandidateCount)} potential candidate(s) were detected, but are hidden until shared marker storage is available.`,
      );
      makeDiagnostics(discovery, scan, [], bounds, scanElapsedMs, fps);
      return;
    }

    const saved = await saveScannedCandidates(analysis.candidates, candidateReviews);
    const newlyDetectedCandidates = saved.visible;
    const submissionsById = new Map(
      candidateSubmissions.map((candidate) => [candidate.id, candidate]),
    );
    for (const candidate of newlyDetectedCandidates) {
      submissionsById.set(candidate.id, candidate);
    }
    candidateSubmissions = [...submissionsById.values()];
    renderCandidateLayers();
    renderRemovedReviews();
    const savedInSelection = [...candidateReviews, ...candidateSubmissions].filter(
      (review) => !review.removed && reviewIntersectsBounds(review, bounds),
    );
    const displayById = new Map(
      savedInSelection.map((candidate) => [candidate.id, candidate]),
    );
    for (const candidate of newlyDetectedCandidates) {
      if (!getCandidateMatch(candidate, candidateReviews)) {
        displayById.set(candidate.id, candidate);
      }
    }
    candidates = [...displayById.values()].sort((first, second) => second.score - first.score);
    scan.typedArrayBytesBeforeAnalysis = analysis.typedArrayBytes;
    scan.class6PointCount = analysis.class6Points;
    scan.detectedCandidateCount = analysis.totalCandidateCount;
    scan.totalCandidateCount = candidates.length;
    showCandidates(candidates, candidates.length);
    const fps = renderer ? await sampleFps() : null;
    const scanElapsedMs = performance.now() - scanStarted;
    elements.viewerTitle.textContent = rendererError
      ? `Points decoded; rendering unavailable: ${rendererError}`
      : 'Actual USGS EPT points rendered';
    const markerPersistence = newlyDetectedCandidates.length
      ? `${newlyDetectedCandidates.length} marker(s) saved to shared storage.`
      : candidates.length
        ? 'No new markers needed saving; the displayed markers were already shared or had been removed.'
        : 'No markers were saved because this scan found no candidates.';
    updateStatus(
      'Scan complete',
      `${formatCount(scan.pointsInSelection)} actual points decoded inside the selection; ${candidates.length} heuristic candidate(s). ${markerPersistence} No structure is confirmed by this scan.`,
    );
    makeDiagnostics(discovery, scan, candidates, bounds, scanElapsedMs, fps);
  } catch (error) {
    if (error.name === 'AbortError') {
      updateStatus('Scan cancelled', 'Any partial point data was discarded. You can draw a smaller area and scan again.');
      setCoverageStatus('Cancelled', 'idle');
      clearResults();
    } else {
      updateStatus('Scan failed', error.message);
      setCoverageStatus('Scan error', 'error');
      setDiagnostics([
        ['Error', error.message],
        ['Requests before failure', diagnostics.requestCount],
        ['Data received before failure', formatBytes(diagnostics.downloadedBytes)],
        ['Vertical reference', 'Unverified; all Z values remain LAS Z units.'],
      ]);
    }
  } finally {
    scanHeartbeat.stop();
    scanController = null;
    updateActions();
    if (!elements.progress.hasAttribute('value')) {
      elements.progress.value = 1;
      elements.progress.max = 1;
    }
  }
}

async function searchLocation(event) {
  event.preventDefault();
  const query = elements.searchInput.value.trim();
  if (!query || searchPending) return;
  searchPending = true;
  updateActions();
  updateStatus('Searching location', 'Requesting one place result from the public OpenStreetMap Nominatim service.');
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.search = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: '1',
    }).toString();
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Place search returned HTTP ${response.status}.`);
    }
    const results = await response.json();
    if (!Array.isArray(results) || !results.length) {
      throw new Error('No matching place was found.');
    }
    const result = results[0];
    const latitude = Number(result.lat);
    const longitude = Number(result.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('Place search returned invalid coordinates.');
    }
    map.setView([latitude, longitude], 16);
    if (searchMarker) map.removeLayer(searchMarker);
    const label = document.createElement('span');
    label.textContent = result.display_name;
    searchMarker = L.marker([latitude, longitude]).addTo(map).bindPopup(label);
    searchMarker.openPopup();
    updateStatus('Location found', 'Draw a rectangle around the area you want to scan.');
  } catch (error) {
    updateStatus('Location search failed', error.message);
  } finally {
    searchPending = false;
    updateActions();
  }
}

elements.searchForm.addEventListener('submit', searchLocation);
elements.clear.addEventListener('click', clearSelection);
elements.scan.addEventListener('click', scanArea);
elements.cancel.addEventListener('click', () => scanController?.abort());
elements.ownerSignIn.addEventListener('click', async () => {
  elements.ownerSignIn.disabled = true;
  elements.ownerPanelStatus.textContent = 'Opening Google sign-in…';
  try {
    await signInOwnerWithGoogle();
  } catch (error) {
    elements.ownerPanelStatus.textContent = `Google sign-in failed: ${error.message}`;
  } finally {
    elements.ownerSignIn.disabled = false;
  }
});
elements.ownerSignOut.addEventListener('click', async () => {
  elements.ownerSignOut.disabled = true;
  try {
    await signOutOwner();
    elements.ownerPanelStatus.textContent = 'Signed out.';
  } catch (error) {
    elements.ownerPanelStatus.textContent = `Sign-out failed: ${error.message}`;
  } finally {
    elements.ownerSignOut.disabled = false;
  }
});

try {
  renderer = createPointRenderer(elements.canvas);
} catch (error) {
  elements.viewerTitle.textContent = `WebGL unavailable: ${error.message}`;
}

window.addEventListener('resize', () => {
  map.invalidateSize();
  renderer?.draw();
});
map.whenReady(() => window.setTimeout(() => map.invalidateSize(), 0));
setCoverageStatus('Not scanned', 'idle');
updateActions();
reviewSync = listenToCandidateReviews(
  ({ reviews, submissions }) => {
    candidateReviews = reviews;
    candidateSubmissions = submissions;
    reviewStoreReady = true;
    reviewStoreError = null;
    candidateStoreUnavailable = false;
    renderCandidateLayers();
    renderOwnerPanel();
  },
  (error) => {
    reviewStoreReady = false;
    reviewStoreError = error.message;
    candidateReviews = [];
    currentCandidates = [];
    candidateStoreUnavailable = true;
    renderCandidateLayers();
    if (hasCandidateScan) {
      showCandidateStoreUnavailable(
        'Live shared marker data was lost. Reconnect before showing candidates.',
      );
    }
    renderOwnerPanel();
  },
);
listenToOwnerAuth((user, error) => {
  currentUser = user;
  if (error) {
    elements.ownerPanelStatus.textContent = `Firebase sign-in state unavailable: ${error.message}`;
  }
  renderOwnerPanel();
});
