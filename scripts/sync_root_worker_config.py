#!/usr/bin/env python3
"""Generate root worker.config.json from canonical worker_files/worker.config.json."""

from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "worker_files" / "worker.config.json"
OUT = ROOT / "worker.config.json"

FIELDS = [
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

source = json.loads(CANONICAL.read_text(encoding="utf-8"))
root = {k: source[k] for k in FIELDS}
OUT.write_text(json.dumps(root, indent=2) + "\n", encoding="utf-8")
print(f"Updated {OUT.relative_to(ROOT)} from canonical config.")
