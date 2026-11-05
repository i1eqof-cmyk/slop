import booleanIntersects from '@turf/boolean-intersects';
import { polygon } from '@turf/helpers';
import proj4 from 'proj4';

export const EPT_CATALOG_URL =
  'https://s3-us-west-2.amazonaws.com/usgs-lidar-stac/ept/catalog.json';
export const TNM_PRODUCTS_URL =
  'https://tnmaccess.nationalmap.gov/api/v1/products';

function isFiniteArray(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((number) => Number.isFinite(number))
  );
}

function getCatalogItemId(href) {
  const path = new URL(href, EPT_CATALOG_URL).pathname;
  const filename = path.slice(path.lastIndexOf('/') + 1);
  return filename.endsWith('.json') ? filename.slice(0, -5) : null;
}

function bboxIntersects(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

async function fetchMeasured(url, diagnostics, label, options = {}) {
  diagnostics.requestCount += 1;
  diagnostics.requestLog.push({ label, url: new URL(url).hostname });
  const response = await fetch(url, {
    cache: 'no-store',
    signal: options.signal,
    headers: options.headers,
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  const buffer = await response.arrayBuffer();
  diagnostics.downloadedBytes += buffer.byteLength;
  return JSON.parse(new TextDecoder().decode(buffer));
}

async function fetchCoverage(bounds, diagnostics, signal) {
  const params = new URLSearchParams({
    datasets: 'Lidar Point Cloud (LPC)',
    bbox: [bounds.west, bounds.south, bounds.east, bounds.north].join(','),
    max: '1000',
    offset: '0',
    outputFormat: 'JSON',
  });
  const url = `${TNM_PRODUCTS_URL}?${params}`;
  const response = await fetchMeasured(url, diagnostics, 'USGS coverage query', {
    signal,
  });
  if (!Array.isArray(response.items) || !Number.isFinite(response.total)) {
    throw new Error('USGS coverage API returned an unexpected response.');
  }
  let items = response.items;
  const pageSize = 1000;
  for (let offset = items.length; offset < response.total; offset += pageSize) {
    const pageParams = new URLSearchParams(params);
    pageParams.set('offset', String(offset));
    const page = await fetchMeasured(
      `${TNM_PRODUCTS_URL}?${pageParams}`,
      diagnostics,
      'USGS coverage query',
      { signal },
    );
    if (!Array.isArray(page.items) || page.items.length === 0) break;
    items = items.concat(page.items);
  }
  return {
    total: response.total,
    products: items.map((item) => ({
      title: item.title,
      boundingBox: item.boundingBox,
      format: item.format,
    })),
  };
}

function makeSelectionPolygon(bounds) {
  return polygon([
    [
      [bounds.west, bounds.south],
      [bounds.east, bounds.south],
      [bounds.east, bounds.north],
      [bounds.west, bounds.north],
      [bounds.west, bounds.south],
    ],
  ]);
}

function validateEptItem(item, expectedId) {
  if (item.type !== 'Feature' || item.id !== expectedId) {
    throw new Error(`STAC item ${expectedId} did not match its catalog entry.`);
  }
  if (!item.geometry || !item.geometry.type || !Array.isArray(item.geometry.coordinates)) {
    throw new Error(`STAC item ${expectedId} has no usable geographic footprint.`);
  }
  const assetUrl = item.assets?.['ept.json']?.href;
  if (typeof assetUrl !== 'string') {
    throw new Error(`STAC item ${expectedId} has no ept.json asset.`);
  }
  const parsedAsset = new URL(assetUrl);
  const isPublicUsgsBucket =
    (parsedAsset.hostname === 's3-us-west-2.amazonaws.com' &&
      parsedAsset.pathname.startsWith('/usgs-lidar-public/')) ||
    [
      'usgs-lidar-public.s3.amazonaws.com',
      'usgs-lidar-public.s3-us-west-2.amazonaws.com',
      'usgs-lidar-public.s3.us-west-2.amazonaws.com',
    ].includes(parsedAsset.hostname);
  if (
    parsedAsset.protocol !== 'https:' ||
    !isPublicUsgsBucket ||
    parsedAsset.username ||
    parsedAsset.password ||
    parsedAsset.search ||
    parsedAsset.hash
  ) {
    throw new Error(`STAC item ${expectedId} has an unexpected EPT asset host.`);
  }
  if (!isFiniteArray(item.bbox, 4)) {
    throw new Error(`STAC item ${expectedId} has an invalid WGS84 bbox.`);
  }
  return { assetUrl: parsedAsset.href, bbox: item.bbox };
}

function validateEptMetadata(metadata, item, id) {
  if (
    metadata.dataType !== 'laszip' ||
    !Number.isSafeInteger(metadata.points) ||
    metadata.points <= 0 ||
    !isFiniteArray(metadata.bounds, 6)
  ) {
    throw new Error(`EPT metadata for ${id} is incomplete or not a LAZ point cloud.`);
  }
  if (!Array.isArray(metadata.schema) || !metadata.schema.length) {
    throw new Error(`EPT metadata for ${id} does not describe its point dimensions.`);
  }
  const horizontal = metadata.srs?.horizontal;
  const wkt = metadata.srs?.wkt;
  const itemCode = item.properties?.['proj:code'];
  const metadataCode =
    horizontal && metadata.srs?.authority
      ? `${metadata.srs.authority}:${horizontal}`
      : null;
  if (!wkt && !['EPSG:4326', 'EPSG:3857'].includes(metadataCode)) {
    throw new Error(`EPT metadata for ${id} does not provide a usable CRS definition.`);
  }
  if (itemCode && metadataCode && itemCode.toUpperCase() !== metadataCode.toUpperCase()) {
    throw new Error(`STAC and EPT horizontal CRS values disagree for ${id}.`);
  }
  const projection = wkt ? `EPT_VALIDATION_${id}` : metadataCode;
  const [longitude, latitude] = [
    (item.bbox[0] + item.bbox[2]) / 2,
    (item.bbox[1] + item.bbox[3]) / 2,
  ];
  try {
    if (wkt) proj4.defs(projection, wkt);
    const [x, y] = proj4('EPSG:4326', projection, [longitude, latitude]);
    const [roundTripLongitude, roundTripLatitude] = proj4(projection, 'EPSG:4326', [x, y]);
    if (
      ![x, y, roundTripLongitude, roundTripLatitude].every(Number.isFinite) ||
      Math.abs(roundTripLongitude - longitude) > 1e-5 ||
      Math.abs(roundTripLatitude - latitude) > 1e-5
    ) {
      throw new Error('coordinate transform failed its WGS84 round-trip check');
    }
  } catch (error) {
    throw new Error(`EPT horizontal CRS for ${id} is not transformable: ${error.message}`);
  }
  const classification = metadata.schema.some((dimension) =>
    dimension.name.toLowerCase().includes('classification'),
  );
  if (!classification) {
    throw new Error(`EPT metadata for ${id} has no classification dimension.`);
  }
  return {
    metadata,
    itemId: id,
    itemUrl: item.links?.find((link) => link.rel === 'self')?.href ?? null,
    eptBase: new URL('.', item.assets['ept.json'].href).href,
    assetUrl: item.assets['ept.json'].href,
    horizontalCrs: metadataCode || itemCode || 'Unreported',
    projectionWkt: wkt || null,
  };
}

export async function discoverDatasets(bounds, signal, diagnostics, onProgress) {
  const catalogPromise = fetchMeasured(
    EPT_CATALOG_URL,
    diagnostics,
    'USGS EPT catalog',
    { signal },
  );
  const appBaseUrl = new URL(import.meta.env.BASE_URL, window.location.href);
  const indexUrl = new URL('ept-spatial-index.json', appBaseUrl).href;
  const indexPromise = fetchMeasured(indexUrl, diagnostics, 'EPT spatial index', {
    signal,
  });
  const coveragePromise = fetchCoverage(bounds, diagnostics, signal).catch((error) => {
    if (signal.aborted) throw error;
    return { total: null, products: [], error: error.message };
  });
  const [catalog, index, coverage] = await Promise.all([
    catalogPromise,
    indexPromise,
    coveragePromise,
  ]);

  if (
    !Array.isArray(catalog.links) ||
    !Array.isArray(index.items) ||
    index.source !== EPT_CATALOG_URL
  ) {
    throw new Error('USGS EPT catalog or its derived spatial index is invalid.');
  }

  const catalogItems = new Map();
  for (const link of catalog.links) {
    if (link.rel !== 'item' || typeof link.href !== 'string') continue;
    const id = getCatalogItemId(link.href);
    if (id) catalogItems.set(id, new URL(link.href, EPT_CATALOG_URL).href);
  }
  const indexEntries = index.items.filter(
    (entry) =>
      entry &&
      typeof entry.id === 'string' &&
      isFiniteArray(entry.bbox, 4) &&
      catalogItems.has(entry.id) &&
      bboxIntersects(entry.bbox, [
        bounds.west,
        bounds.south,
        bounds.east,
        bounds.north,
      ]),
  );
  const indexIdsMatch =
    index.items.length === catalogItems.size &&
    index.items.every((entry) => catalogItems.has(entry.id));
  const selection = makeSelectionPolygon(bounds);
  const datasets = [];
  const rejected = [];

  for (const entry of indexEntries) {
    if (signal.aborted) throw new DOMException('Scan cancelled.', 'AbortError');
    onProgress(`Checking USGS EPT footprint: ${entry.id}`);
    try {
      const itemUrl = catalogItems.get(entry.id);
      const item = await fetchMeasured(itemUrl, diagnostics, 'USGS STAC item', {
        signal,
      });
      const validItem = validateEptItem(item, entry.id);
      if (!booleanIntersects(selection, item)) continue;
      const metadata = await fetchMeasured(
        validItem.assetUrl,
        diagnostics,
        'EPT metadata',
        { signal },
      );
      datasets.push(validateEptMetadata(metadata, item, entry.id));
    } catch (error) {
      if (signal.aborted) throw error;
      rejected.push({ id: entry.id, reason: error.message });
    }
  }

  return {
    catalogItemCount: catalogItems.size,
    indexItemCount: index.items.length,
    indexIsCurrent: indexIdsMatch,
    indexGeneratedAt: index.generatedAt,
    coverage,
    datasets,
    rejected,
  };
}

export function getCoverageMessage(result) {
  if (result.datasets.length) {
    if (result.coverage.total === null) {
      return `Validated public EPT coverage found (${result.datasets.length} survey(s)); USGS coverage could not be verified: ${result.coverage.error}`;
    }
    if (result.coverage.total > 0) {
      return `USGS reports ${result.coverage.total.toLocaleString()} LiDAR product footprint(s); ${result.datasets.length} validated EPT survey(s) intersect the selection.`;
    }
    if (result.coverage.total === null) {
      return `No validated public EPT survey matched. USGS coverage verification failed: ${result.coverage.error}`;
    }
    return `Validated public EPT coverage found (${result.datasets.length} survey(s)); the USGS download catalog returned no point-cloud products for this box.`;
  }
  if (result.coverage.total > 0) {
    return `USGS reports ${result.coverage.total.toLocaleString()} LiDAR point-cloud product(s), but no matching public EPT resource was found.`;
  }
  return 'No USGS 3DEP LiDAR point-cloud product or matching public EPT footprint was found for this selection.';
}
