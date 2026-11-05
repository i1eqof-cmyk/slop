# USGS 3DEP LiDAR Explorer

The main page is a map-first browser scanner. Search for a location, draw a
rectangle, and choose **Scan Area**. The browser discovers public USGS 3DEP
coverage, validates EPT resources, progressively downloads intersecting LAZ
nodes, decodes them in Web Workers, and renders actual returned points with
WebGL. Scan measurements are available in the optional **Scan Diagnostics**
panel. The manual benchmark remains at `advanced-benchmark.html`.

## Run locally on Windows

```powershell
Set-Location C:\Users\C\Pictures\BuildingLocator\browser-ept-benchmark
npm.cmd install
npm.cmd run dev
```

Open the local URL printed by Vite. The map opens in satellite imagery at a
neutral world view and does not prefill or persist a search or selection.
Click a candidate marker and choose **View in Google Earth 3D** to open Earth
centered and zoomed to its coordinates in a new tab. Candidate marker
coordinates are stored separately in the shared review database as described
below.

Build the static site for deployment:

```powershell
npm.cmd run build
```

The deployable site is in `dist`. For GitHub Pages or another static host,
publish the contents of `dist` (or configure the host to build from the
repository). No application server or Cloudflare Worker is required.

## Automatic dataset discovery

Each scan:

1. Queries the official USGS The National Map Access API for `Lidar Point
   Cloud (LPC)` coverage intersecting the drawn WGS84 rectangle.
2. Loads the public [USGS EPT STAC catalog](https://s3-us-west-2.amazonaws.com/usgs-lidar-stac/ept/catalog.json)
   and a compact spatial index derived from its item documents.
3. Fetches the actual intersecting STAC item documents, checks their geographic
   footprint against the drawn rectangle, reads the item’s actual `ept.json`
   asset URL, then validates the EPT metadata, point dimensions, and CRS.
4. Transforms the selection into each validated dataset CRS, traverses only
   intersecting EPT hierarchy nodes, downloads and decodes the corresponding
   LAZ data in browser workers, and filters decoded points back to the exact
   geographic rectangle.

The interface distinguishes **no listed LiDAR point-cloud coverage** from
**LiDAR coverage listed but no matching validated public EPT resource**. A USGS
coverage API outage is reported as unverified coverage, not as “no LiDAR.”
Static catalog item matching uses actual STAC item footprints and assets, not
project-name-derived EPT URLs.

`public/ept-spatial-index.json` contains WGS84 bounding boxes and item IDs/links
for the 2,283 items in the USGS EPT catalog when generated. It does not contain
point data or hardcode a scan location. Regenerate it when the catalog changes:

```powershell
python .\scripts\build-ept-index.py
npm.cmd run build
```

The index builder uses Python’s standard library and fetches the catalog’s item
documents. Ordinary scans only load this small index and then request
intersecting item documents; they do not fetch all survey point clouds.

## Point display and candidate evidence

- The scan retains the compressed LAZ node payloads and all decoded
  in-selection coordinates/classifications in browser memory during analysis.
  WebGL display sampling is separate and does not limit the downloaded point
  records.
- Adaptive quality chooses decoder worker count and a display-only point budget
  from browser-reported core/memory hints.
- Class 6 returns are kept as a separate evidence category. Other candidates
  require connected elevated cells and roof-like geometry; class 3–5 vegetation
  share reduces confidence. Ground-relative checks use nearby Class 2 samples
  in a local grid, not a fabricated ground surface.
- The candidate grid is 2.5 m. A cell is considered elevated only when its
  non-ground mean exceeds the median nearby Class 2 cell elevation by more than
  1.5 LAS Z units. A planar cell has a non-ground Z range no greater than 0.75
  LAS Z units. Class 2 search extends three grid cells. Non-Class-6 candidates
  also require at least 25 m², 40 returns, 35% local ground coverage, 40%
  planar elevated cells, and less than 70% vegetation returns. Class 6
  components require 10 such returns in at least two connected cells.
- Scores add evidence for local ground support (up to 20), planar elevated
  cells (up to 25), compact geometry (up to 15), footprint area (10), density
  (10), and Class 6 (up to 15); substantial vegetation subtracts 10 or 25.
  Scores are capped at 44 when local ground coverage is below 35%. High is
  75–100, medium is 50–74, and low is below 50. Only the top 500 scored
  candidates are added to the map, with an explicit note if more exist.
- Every candidate shows its score components, point count, approximate
  dimensions, and local Class 2 support. Scores are heuristic and unvalidated;
  they are not building confirmations. A missing candidate does not prove a
  building is absent; a structure with no useful roof or wall returns in the
  selected LiDAR data cannot be reliably recovered by this scanner.
- Height and relative-height values remain **LAS Z units**. The app does not
  assume the vertical unit or reference.
- For browser memory safety, each rectangle side is limited to 2,000 m. Before
  downloading any LAZ nodes, the scanner estimates intersecting source records
  and stops if they exceed the device profile's point limit: 8,000,000 on
  standard/lower-capability profiles and up to 40,000,000 when the browser
  reports more than 8 logical cores and more than 8 GiB device memory. These
  browser hints are approximate, not a guarantee of available RAM. The larger
  profile may require well over 1 GiB of browser memory and substantial
  download/time, depending on LAZ compression and point density. Draw a smaller
  box or use a desktop point-cloud workflow when a scan exceeds its limit. The
  scanner never silently truncates a completed scan to meet its display budget.

## Diagnostics and privacy

Diagnostics report coverage status, requests, bytes received, compressed LAZ
size, EPT node and point counts, time to first points, total loading and decode
time, WebGL frame rate, adaptive worker/display settings, and memory estimates
where exposed. Browser heap APIs omit some worker, WebAssembly, and GPU memory;
the app reports those limits.

Candidate marker metadata (coordinates, approximate footprint, score, and
evidence summary) is shared through Firebase Realtime Database after every
visitor's scan. Raw LiDAR points and full scan rectangles are not stored there.
All visitors can read markers. Scans are authenticated with Firebase Anonymous
Authentication by default; each signed-in identity can write only its own
`scanCandidates/{uid}` records. The configured owner UID alone can write
`candidateReviews`, which stores removal/restoration decisions. Removed
locations are matched to new detections within approximately 8 metres and
remain suppressed until restored in the Owner review panel. Candidate scoring
and spatial matching are heuristic; a nearby, distinct structure may also be
suppressed, so review restored markers carefully.

Before deploying, apply the rules in `database.rules.json` to the Realtime
Database. If the project already has other data/rules, merge both the
`candidateReviews` and `scanCandidates` branches instead of replacing existing
rules. Enable **Anonymous** and **Google** under Firebase Authentication →
Sign-in method, and add the website’s deployment domain to Authorized
domains. The owner must sign in with the Google account whose UID is configured
in `src/firebase.js` to remove or restore markers. The static site does not
require the Firebase Admin SDK or a service-account key.

Because scan records are shared and the database is client-accessible, an
authenticated user can submit many candidate records under their own UID.
Realtime Database rules validate ownership and basic record fields but cannot
reliably rate-limit writes. Monitor Firebase usage; a trusted server with
quotas/rate limiting is needed if the app becomes public at scale.

USGS catalog/coverage/EPT requests, map imagery, and place searches go
directly to their public providers, which may log them. The
OpenStreetMap Nominatim search provider receives the typed place query. The
map uses Esri World Imagery by default and OpenStreetMap streets as an
alternate. Opening a candidate in Google Earth sends its coordinates in the
URL.

## Dependencies

- **Leaflet** — interactive map and basemap display.
- **Leaflet Draw** — rectangle selection tool.
- **proj4** — conversion between WGS84 map coordinates and each EPT dataset’s
  advertised horizontal CRS.
- **Turf boolean-intersects/helpers** — exact STAC footprint/selection
  intersection checks.
- **laz-perf** — LAZ decompression in browser Web Workers using WebAssembly.
- **Firebase app/auth/database modules** — Google owner sign-in and shared
  candidate marker records; Firestore and the Admin SDK are not used, and the
  LiDAR point cloud is not uploaded.
- **Vite** — local development and static production builds.

The point cloud is drawn in WebGL buffers; points are never rendered as
individual HTML elements. All retrieval and decoding run in the visitor’s
browser, not a serverless worker.
