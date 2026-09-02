#!/usr/bin/env python3
"""src/fonts/ 를 Google Fonts 에서 다시 받아 채운다.

데스크탑 앱은 오프라인에서도 떠야 하고 Tauri 의 기본 CSP 가 원격 리소스를 막으므로
fonts.googleapis.com 을 link 로 걸 수 없다. Google 이 나눠 주는 unicode-range 서브셋을
그대로 가져오기 때문에 WebView 는 실제로 화면에 나온 글자의 조각만 읽어 들인다.

    python scripts/fetch-fonts.py
"""

import pathlib
import re
import urllib.request

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
CSS_URL = (
    "https://fonts.googleapis.com/css2"
    "?family=Noto+Sans+KR:wght@400..700"
    "&family=Roboto:wght@400..700"
    "&display=swap"
)
FONTS_DIR = pathlib.Path(__file__).resolve().parent.parent / "src" / "fonts"

HEADER = """/* Google Fonts 를 자체 호스팅한 결과. 이 파일과 옆의 woff2 는
 * scripts/fetch-fonts.py 로 다시 만들 수 있다.
 *
 * 데스크탑 앱은 오프라인에서도 떠야 하고 Tauri 의 기본 CSP 가 원격 리소스를 막으므로
 * fonts.googleapis.com 을 link 로 걸 수 없다. Google 이 나눠 주는 unicode-range 서브셋을
 * 그대로 가져왔기 때문에 WebView 는 실제로 화면에 나온 글자의 조각만 읽어 들인다.
 */
"""


def fetch(url: str, binary: bool = False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.read() if binary else response.read().decode("utf-8")


def main() -> None:
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    css = fetch(CSS_URL)
    urls = re.findall(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", css)
    print(f"CSS {len(css)} bytes, {len(urls)} font files referenced")

    mapping: dict[str, str] = {}
    total = 0
    for url in urls:
        if url in mapping:
            continue
        # .../s/notosanskr/v39/<hash>.42.woff2  ->  notosanskr-42.woff2
        match = re.search(r"/s/([a-z0-9]+)/[^/]+/[^/]*?(?:\.(\d+))?\.woff2$", url)
        family = match.group(1) if match else "font"
        index = match.group(2) if match and match.group(2) else "latin"
        name = f"{family}-{index}.woff2"
        suffix = 2
        while name in mapping.values():
            name = f"{family}-{index}-{suffix}.woff2"
            suffix += 1
        data = fetch(url, binary=True)
        (FONTS_DIR / name).write_bytes(data)
        mapping[url] = name
        total += len(data)

    for url, name in mapping.items():
        css = css.replace(url, f"./{name}")
    (FONTS_DIR / "fonts.css").write_text(HEADER + css, encoding="utf-8")

    print(f"downloaded {len(mapping)} files, {total / 1024 / 1024:.2f} MiB total")


if __name__ == "__main__":
    main()
