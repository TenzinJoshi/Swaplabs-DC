from __future__ import annotations

import re
import os
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urljoin, urlsplit
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("SWAPLABS_TEST_ORIGIN", "http://127.0.0.1:8000/").rstrip("/") + "/"
BASE_HOST = urlsplit(BASE).netloc
EXPECTED_PROTECTED_HASHES = {
    "logo.jpg": "6796c5ec39adbc8bd57fdae29d9f1ea1f3cf405a2f021998d934e28e8bacfa03",
    "credits.html": "0fa3681f700f52d8cced22d8bb149c54b7ce2f2100a3748f833d025ec0666ab7",
    "site-credits.html": "ce57c8688e4734b875b8e515a4e73ae3f5ba074ad038d0e1727b9cf6a8159f88",
    "styles/pages/site-credits.css": "87a11e0754c55bd3615d6282132d768523b27ab5068dbf2de301f3427a4f7331",
}


class References(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.refs: list[str] = []
        self.links: list[str] = []
        self.ids: set[str] = set()
        self.title = False
        self.title_text = ""

    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        if data.get("id"):
            self.ids.add(data["id"])
        if tag == "a" and data.get("href"):
            self.links.append(data["href"].strip())
        for key in ("href", "src", "poster"):
            value = data.get(key, "").strip()
            if value:
                if tag in {"script", "img", "source", "video", "audio", "iframe"} or key != "href":
                    self.refs.append(value)
                elif tag == "link" and any(part in data.get("rel", "").lower() for part in ("stylesheet", "icon", "manifest", "preload")):
                    self.refs.append(value)
        if tag == "title":
            self.title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self.title = False

    def handle_data(self, data):
        if self.title:
            self.title_text += data


def fail(message: str):
    raise AssertionError(message)


def get(url: str):
    try:
        with urlopen(url, timeout=8) as response:
            return response.status, response.headers, response.read()
    except HTTPError as error:
        return error.code, error.headers, error.read()
    except URLError as error:
        fail(f"Local server is not reachable at {BASE}: {error.reason}")


def local_file_for(url: str) -> Path | None:
    resolved = urljoin(BASE, url)
    parsed = urlsplit(resolved)
    if parsed.scheme not in {"http", "https"} or parsed.netloc != BASE_HOST:
        return None
    name = urldefrag(parsed.path).url.lstrip("/") or "index.html"
    path = (ROOT / name).resolve()
    if ROOT.resolve() not in path.parents and path != ROOT.resolve():
        fail(f"Asset escapes the project: {url}")
    return path


def main():
    status, headers, body = get(urljoin(BASE, "/api/local/status"))
    if status != 200:
        fail(f"Local status returned HTTP {status}.")
    import json
    state = json.loads(body)
    assert state.get("app") == "swaplabs-local" and state.get("mode") == "local", state
    assert state.get("database") == "sqlite" and state.get("media") == "local" and state.get("live_rooms") == "local", state
    assert headers.get("x-swappublic-api") == "local", headers.get("x-swappublic-api")
    assert isinstance(state.get("accounts"), int) and state["accounts"] >= 0, "The local account count is invalid."

    failures: list[str] = []
    link_cache: dict[str, tuple[int, str, set[str]]] = {}
    html_files = sorted(ROOT.glob("*.html"))
    assert len(html_files) >= 70, f"Expected the complete multipage site; found {len(html_files)} HTML pages."
    for page in html_files:
        rel = page.relative_to(ROOT).as_posix()
        code, response_headers, content = get(urljoin(BASE, rel))
        if code != 200:
            failures.append(f"Page {rel} returned HTTP {code}.")
            continue
        if "text/html" not in response_headers.get("content-type", ""):
            failures.append(f"Page {rel} did not return HTML.")
        parser = References()
        parser.feed(content.decode("utf-8", errors="replace"))
        if not parser.title_text.strip():
            failures.append(f"Page {rel} has no document title.")
        for ref in parser.refs:
            candidate = local_file_for(urljoin(BASE, urljoin(rel, ref)))
            if candidate is None:
                if ref.startswith(("http://", "https://", "//")):
                    failures.append(f"Page {rel} automatically loads a remote asset: {ref}")
                continue
            asset_url = urljoin(BASE, urljoin(rel, ref))
            asset_status, _, _ = get(asset_url)
            if asset_status != 200:
                failures.append(f"Page {rel} references local asset returning HTTP {asset_status}: {ref}")
        for href in parser.links:
            if not href or href.startswith(("mailto:", "tel:", "javascript:", "data:")):
                continue
            target = urljoin(urljoin(BASE, rel), href)
            parsed_target = urlsplit(target)
            if parsed_target.scheme not in {"http", "https"} or parsed_target.netloc != BASE_HOST:
                continue
            cache_key = f"{parsed_target.scheme}://{parsed_target.netloc}{parsed_target.path}?{parsed_target.query}"
            if cache_key not in link_cache:
                link_status, link_headers, link_body = get(target)
                target_ids: set[str] = set()
                if link_status == 200 and "text/html" in link_headers.get("content-type", ""):
                    target_parser = References()
                    target_parser.feed(link_body.decode("utf-8", errors="replace"))
                    target_ids = target_parser.ids
                link_cache[cache_key] = (link_status, link_headers.get("content-type", ""), target_ids)
            link_status, link_type, target_ids = link_cache[cache_key]
            if link_status != 200 and not (parsed_target.path.startswith("/api/") and link_status in {401, 403}):
                failures.append(f"Page {rel} links to local URL returning HTTP {link_status}: {href}")
            elif parsed_target.fragment and "text/html" in link_type and parsed_target.fragment not in target_ids:
                failures.append(f"Page {rel} links to missing section #{parsed_target.fragment}: {href}")

    # Verify all internal font, image, and import URLs referenced by stylesheets.
    for css in sorted((ROOT / "styles").rglob("*.css")) + sorted((ROOT / "assets").rglob("*.css")):
        css_text = css.read_text(errors="replace")
        for match in re.finditer(r"(?:@import\s+(?:url\()?|url\()\s*['\"]?([^\s)';\"]+)", css_text, re.I):
            ref = match.group(1).strip("\"'")
            if ref.startswith(("data:", "#")):
                continue
            candidate = local_file_for(urljoin(urljoin(BASE, css.relative_to(ROOT).as_posix()), ref))
            if candidate is None:
                failures.append(f"Stylesheet {css.relative_to(ROOT)} references a remote asset: {ref}")
            elif not candidate.is_file():
                failures.append(f"Stylesheet {css.relative_to(ROOT)} references a missing asset: {ref}")

    for rel, expected in EXPECTED_PROTECTED_HASHES.items():
        import hashlib
        actual = hashlib.sha256((ROOT / rel).read_bytes()).hexdigest()
        if actual != expected:
            failures.append(f"Protected SwapLabs file changed: {rel}")

    for path in failures[:80]:
        print("FAIL", path)
    if failures:
        fail(f"{len(failures)} page or offline asset checks failed.")

    print(f"PASS: localhost status, {len(html_files)} HTML pages, local page assets, CSS resources, and in-site links.")
    print(f"PASS: SQLite/R2/study-room local bindings; {state['accounts']} local accounts.")
    print("PASS: original SwapLabs logo, credits/acknowledgements page, and acknowledgement stylesheet are unchanged.")
    print("PASS: no page automatically loads a remote script, stylesheet, font, image, or icon.")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
