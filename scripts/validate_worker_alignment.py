#!/usr/bin/env python3
"""Validate Cloudflare Worker alignment across canonical config, root config, and TOML vars."""

from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "worker_files" / "worker.config.json"
ROOT_CONFIG = ROOT / "worker.config.json"
TOML = ROOT / "worker_files" / "gateway.worker.toml"


def read_json(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def read_toml_vars(path: pathlib.Path) -> tuple[str, list[str], list[str]]:
    text = path.read_text(encoding="utf-8")
    main_match = re.search(r'^main\s*=\s*"([^"]+)"', text, re.MULTILINE)
    origins_match = re.search(r'^ALLOWED_ORIGINS\s*=\s*"([^"]+)"', text, re.MULTILINE)
    headers_match = re.search(r'^REQUIRED_HEADERS\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not (main_match and origins_match and headers_match):
        raise ValueError("gateway.worker.toml missing main/ALLOWED_ORIGINS/REQUIRED_HEADERS")

    main = main_match.group(1).strip()
    origins = [v.strip() for v in origins_match.group(1).split(",") if v.strip()]
    headers = [v.strip() for v in headers_match.group(1).split(",") if v.strip()]
    return main, origins, headers


def fail(errors: list[str]) -> int:
    print("Worker alignment validation failed:")
    for err in errors:
        print(f"- {err}")
    return 1


def main() -> int:
    canonical = read_json(CANONICAL)
    root_cfg = read_json(ROOT_CONFIG)
    toml_main, toml_origins, toml_headers = read_toml_vars(TOML)

    errors: list[str] = []

    if "assistant_endpoint" in canonical:
        errors.append("Canonical config contains legacy key assistant_endpoint")

    required_non_empty = [
        "workerScript",
        "workerEndpoint",
        "assistantEndpoint",
        "voiceEndpoint",
        "ttsEndpoint",
        "gatewayEndpoint",
        "workerEndpointAssetId",
        "gatewayEndpointAssetId",
    ]
    for key in required_non_empty:
        value = str(canonical.get(key, "")).strip()
        if not value:
            errors.append(f"Canonical config key '{key}' is missing or empty")

    if canonical.get("workerScript") != f"worker_files/{toml_main}":
        errors.append(
            f"workerScript ({canonical.get('workerScript')}) does not match gateway.worker.toml main ({toml_main})"
        )

    canonical_origins = canonical.get("allowedOrigins", [])
    if canonical_origins != toml_origins:
        errors.append("allowedOrigins in canonical config do not match ALLOWED_ORIGINS in gateway.worker.toml")

    canonical_headers = canonical.get("requiredHeaders", [])
    if canonical_headers != toml_headers:
        errors.append("requiredHeaders in canonical config do not match REQUIRED_HEADERS in gateway.worker.toml")

    asset_map = (canonical.get("asset_identity") or {}).get("origin_to_asset_id") or {}
    if sorted(asset_map.keys()) != sorted(canonical_origins):
        errors.append("origin_to_asset_id keys do not match allowedOrigins")

    aligned_keys = [
        "assetRegistry",
        "workerScript",
        "workerEndpoint",
        "assistantEndpoint",
        "voiceEndpoint",
        "ttsEndpoint",
        "gatewayEndpoint",
        "workerEndpointAssetId",
        "gatewayEndpointAssetId",
        "allowedOrigins",
        "allowedOriginAssetIds",
        "requiredHeaders",
    ]
    for key in aligned_keys:
        if root_cfg.get(key) != canonical.get(key):
            errors.append(f"Root config key '{key}' drifts from canonical worker config")

    if errors:
        return fail(errors)

    print("Worker alignment validation passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
