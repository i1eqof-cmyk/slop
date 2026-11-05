import { createLazPerf } from 'laz-perf';
import wasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';
import proj4 from 'proj4';

let lazPerfPromise;
let cancelled = false;
let activeController = null;

function getLazPerf() {
  if (!lazPerfPromise) {
    lazPerfPromise = createLazPerf({
      locateFile: (path) => (path.endsWith('.wasm') ? wasmUrl : path),
    });
  }
  return lazPerfPromise;
}

function readLasHeader(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x4653414c) {
    throw new Error('EPT data node does not have a LASF header.');
  }

  const versionMinor = view.getUint8(25);
  const headerSize = view.getUint16(94, true);
  const pointDataOffset = view.getUint32(96, true);
  const pointFormat = view.getUint8(104) & 0x3f;
  const recordLength = view.getUint16(105, true);
  const legacyCount = view.getUint32(107, true);
  const pointCount =
    versionMinor >= 4 && buffer.byteLength >= 255
      ? Number(view.getBigUint64(247, true))
      : legacyCount;

  if (headerSize < 227 || pointDataOffset > buffer.byteLength) {
    throw new Error('LAS header has an invalid point-data offset.');
  }

  return {
    pointCount,
    pointFormat,
    recordLength,
    pointDataOffset,
    scale: [
      view.getFloat64(131, true),
      view.getFloat64(139, true),
      view.getFloat64(147, true),
    ],
    offset: [
      view.getFloat64(155, true),
      view.getFloat64(163, true),
      view.getFloat64(171, true),
    ],
  };
}

function configureProjection(job) {
  if (job.sourceWkt) {
    proj4.defs('EPT_SOURCE', job.sourceWkt);
    return 'EPT_SOURCE';
  }
  if (job.sourceCrs) return job.sourceCrs;
  throw new Error('EPT metadata has no usable horizontal CRS definition.');
}

async function decodeNode(job) {
  const downloadStarted = performance.now();
  activeController = new AbortController();
  const response = await fetch(`${job.eptBase}ept-data/${job.id}.laz`, {
    cache: 'no-store',
    signal: activeController.signal,
  });
  if (!response.ok) {
    throw new Error(`EPT node ${job.id} returned HTTP ${response.status}.`);
  }
  const compressed = await response.arrayBuffer();
  const downloadMs = performance.now() - downloadStarted;
  const header = readLasHeader(compressed);
  const module = await getLazPerf();
  const decoder = new module.LASZip();
  const inputPointer = module._malloc(compressed.byteLength);
  let pointPointer = 0;
  const decodeStarted = performance.now();

  try {
    module.HEAPU8.set(new Uint8Array(compressed), inputPointer);
    decoder.open(inputPointer, compressed.byteLength);

    const pointCount = decoder.getCount();
    const recordLength = decoder.getPointLength();
    const pointFormat = decoder.getPointFormat() & 0x3f;
    if (pointCount !== job.expectedPoints) {
      throw new Error(
        `EPT hierarchy said ${job.expectedPoints} points for ${job.id}; LAZ header says ${pointCount}.`,
      );
    }
    if (pointCount !== header.pointCount || recordLength !== header.recordLength) {
      throw new Error(`EPT node ${job.id} header and LAZ decoder disagree.`);
    }

    const positions = new Float32Array(pointCount * 3);
    const classifications = new Uint8Array(pointCount);
    const pointClassOffset = pointFormat >= 6 ? 16 : 15;
    const sourceProjection = job.geographicBounds
      ? configureProjection(job)
      : null;
    pointPointer = module._malloc(recordLength);
    let insideCount = 0;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let index = 0; index < pointCount; index += 1) {
      if (cancelled && (index & 0x3fff) === 0) {
        throw new DOMException('Benchmark cancelled.', 'AbortError');
      }

      decoder.getPoint(pointPointer);
      const point = new DataView(module.HEAPU8.buffer, pointPointer, recordLength);
      const x =
        point.getInt32(0, true) * header.scale[0] + header.offset[0];
      const y =
        point.getInt32(4, true) * header.scale[1] + header.offset[1];
      const z =
        point.getInt32(8, true) * header.scale[2] + header.offset[2];
      const classification = point.getUint8(pointClassOffset);

      if (
        x >= job.bounds.minX &&
        x <= job.bounds.maxX &&
        y >= job.bounds.minY &&
        y <= job.bounds.maxY
      ) {
        let outputX = x - job.centerX;
        let outputY = y - job.centerY;
        if (job.geographicBounds) {
          const [longitude, latitude] = proj4(sourceProjection, 'EPSG:4326', [x, y]);
          const bounds = job.geographicBounds;
          if (
            longitude < bounds.west ||
            longitude > bounds.east ||
            latitude < bounds.south ||
            latitude > bounds.north
          ) {
            continue;
          }
          const longitudeScale =
            111_319.49079327358 * Math.cos((job.displayCenter.latitude * Math.PI) / 180);
          outputX = (longitude - job.displayCenter.longitude) * longitudeScale;
          outputY = (latitude - job.displayCenter.latitude) * 111_319.49079327358;
        }
        const outputIndex = insideCount * 3;
        positions[outputIndex] = outputX;
        positions[outputIndex + 1] = outputY;
        positions[outputIndex + 2] = z;
        classifications[insideCount] = classification;
        insideCount += 1;
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }

    const finalPositions = positions.slice(0, insideCount * 3);
    const finalClasses = classifications.slice(0, insideCount);
    return {
      id: job.id,
      depth: job.depth,
      expectedPoints: job.expectedPoints,
      downloadedPoints: pointCount,
      areaPoints: insideCount,
      pointFormat,
      recordLength,
      compressedBytes: compressed.byteLength,
      requestCount: 1,
      downloadMs: Number(downloadMs.toFixed(2)),
      decodeMs: Number((performance.now() - decodeStarted).toFixed(2)),
      minZ: insideCount ? minZ : null,
      maxZ: insideCount ? maxZ : null,
      positions: finalPositions.buffer,
      classifications: finalClasses.buffer,
      rawLaz: compressed,
    };
  } finally {
    if (pointPointer) module._free(pointPointer);
    module._free(inputPointer);
    decoder.delete();
  }
}

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type === 'cancel') {
    cancelled = true;
    activeController?.abort();
    return;
  }
  if (message.type === 'init') {
    try {
      await getLazPerf();
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'worker-error', message: error.message });
    }
    return;
  }
  if (message.type === 'decode') {
    cancelled = false;
    try {
      const tile = await decodeNode(message.job);
      self.postMessage({ type: 'tile', tile }, [
        tile.positions,
        tile.classifications,
        tile.rawLaz,
      ]);
    } catch (error) {
      self.postMessage({
        type: error.name === 'AbortError' ? 'cancelled' : 'worker-error',
        id: message.job.id,
        message: error.message,
      });
    } finally {
      activeController = null;
    }
  }
};
