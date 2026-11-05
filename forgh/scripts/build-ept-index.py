import concurrent.futures
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


CATALOG_URL = "https://s3-us-west-2.amazonaws.com/usgs-lidar-stac/ept/catalog.json"
OUTPUT = Path(__file__).resolve().parents[1] / "public" / "ept-spatial-index.json"
WORKERS = 24


def fetch_json(url):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "GlobalEPTScanner/1.0 (public STAC index builder)"},
    )
    with urllib.request.urlopen(request, timeout=40) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}: {url}")
        return json.load(response)


def item_url(link):
    url = urllib.parse.urljoin(CATALOG_URL, link["href"])
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "s3-us-west-2.amazonaws.com":
        raise ValueError(f"Unexpected STAC item URL: {url}")
    return url


def read_item(url):
    item = fetch_json(url)
    bbox = item.get("bbox")
    if (
        not isinstance(bbox, list)
        or len(bbox) < 4
        or not all(isinstance(value, (int, float)) for value in bbox[:4])
    ):
        raise ValueError(f"Missing valid WGS84 bbox in {url}")
    return {
        "id": item.get("id"),
        "url": url,
        "bbox": [float(value) for value in bbox[:4]],
    }


def main():
    catalog = fetch_json(CATALOG_URL)
    links = [
        item_url(link)
        for link in catalog.get("links", [])
        if link.get("rel") == "item" and link.get("href")
    ]
    if not links:
        raise RuntimeError("The USGS EPT STAC catalog contained no item links.")

    items = []
    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as executor:
        futures = {executor.submit(read_item, url): url for url in links}
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            try:
                items.append(future.result())
            except (OSError, ValueError, urllib.error.URLError) as error:
                failures.append({"url": futures[future], "error": str(error)})
            if done % 100 == 0:
                print(f"Read {done}/{len(links)} item documents", flush=True)

    if failures or len(items) != len(links):
        examples = "\n".join(f"  {failure['url']}: {failure['error']}" for failure in failures[:5])
        raise RuntimeError(
            f"Index incomplete: {len(items)}/{len(links)} item documents succeeded.\n{examples}"
        )

    items.sort(key=lambda item: item["id"] or "")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(
            {
                "source": CATALOG_URL,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "items": items,
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(items)} indexed USGS EPT items to {OUTPUT}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Failed to build EPT spatial index: {error}", file=sys.stderr)
        raise
