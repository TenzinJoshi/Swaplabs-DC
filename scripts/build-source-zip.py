#!/usr/bin/env python3
"""Build the public-safe SwapLabs source archive for the local download page."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_PAYLOAD = PROJECT_ROOT / ".github-public-upload-payload"
SOURCE_ROOT = PUBLIC_PAYLOAD if PUBLIC_PAYLOAD.is_dir() else PROJECT_ROOT
ARCHIVE = PROJECT_ROOT / "downloads" / "SwapLabs-Complete-Source.zip"

EXCLUDED_DIRS = {
    ".git",
    ".github-public-staging",
    ".github-public-upload-payload",
    ".original-swaplabs",
    ".wrangler",
    "data",
    "dist",
    "node_modules",
    "uploads",
}
EXCLUDED_FILES = {
    ".dev.vars",
    ".env",
    ".env.local",
    ".env.production",
    ".env.development.local",
    ".env.production.local",
}
EXCLUDED_SUFFIXES = {".db", ".db-shm", ".db-wal", ".sqlite", ".sqlite3"}


def included_files() -> list[Path]:
    files: list[Path] = []
    for path in SOURCE_ROOT.rglob("*"):
        relative = path.relative_to(SOURCE_ROOT)
        if any(part in EXCLUDED_DIRS for part in relative.parts):
            continue
        if path.is_symlink() or not path.is_file():
            continue
        if path.name in EXCLUDED_FILES or path.name == ARCHIVE.name or path.name.startswith(".SwapLabs-Complete-Source-"):
            continue
        if path.suffix.lower() in EXCLUDED_SUFFIXES or path.name == ".DS_Store":
            continue
        files.append(path)
    return sorted(files, key=lambda item: item.relative_to(SOURCE_ROOT).as_posix().casefold())


def main() -> None:
    ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".SwapLabs-Complete-Source-", suffix=".zip", dir=ARCHIVE.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=3) as bundle:
            for source in included_files():
                relative = source.relative_to(SOURCE_ROOT).as_posix()
                bundle.write(source, f"SwapLabs/{relative}")
        os.replace(temporary, ARCHIVE)
        ARCHIVE.chmod(0o644)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Built public-safe source archive: {ARCHIVE} ({len(included_files())} files)")


if __name__ == "__main__":
    main()
