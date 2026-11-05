"""Serialize existing Home Assistant playback state without opening media.

Home Assistant owns the stream and its consumers. The camera diagnostics
download consumes this allowlist, which never retains source URLs, identifiers,
tokens or error text and never creates or changes a playback session.
"""

from __future__ import annotations

from collections.abc import Mapping
import math
from typing import Any


def serialize_stream(stream: Any | None) -> dict[str, Any]:
    """Read an existing stream, isolating unavailable observations from each other.

    Counters are cumulative and a cached stream can exist while idle. These
    observations do not count viewers or establish physical camera activity.
    """
    if stream is None:
        return {"created": False}

    result: dict[str, Any] = {
        "created": True,
        "available": None,
        "preload": None,
        "hls_output": None,
        "recorder_output": None,
        "hls_idle": None,
    }
    try:
        available = stream.available
        if type(available) is bool:
            result["available"] = available
    except Exception:
        pass
    try:
        preload = stream.dynamic_stream_settings.preload_stream
        if type(preload) is bool:
            result["preload"] = preload
    except Exception:
        pass
    try:
        outputs = stream.outputs()
    except Exception:
        outputs = None
    if isinstance(outputs, Mapping):
        try:
            result["hls_output"] = "hls" in outputs
        except Exception:
            pass
        try:
            result["recorder_output"] = "recorder" in outputs
        except Exception:
            pass
        try:
            hls = outputs.get("hls")
            idle = hls.idle if hls is not None else None
            if type(idle) is bool:
                result["hls_idle"] = idle
        except Exception:
            pass
    try:
        values = stream.get_diagnostics()
    except Exception:
        values = None
    if isinstance(values, dict):
        for key in ("start_worker", "worker_error"):
            try:
                value = values.get(key)
                if type(value) is int and 0 <= value <= 2**31 - 1:
                    result[key] = value
            except Exception:
                pass
        try:
            value = values.get("retry_timeout")
            if type(value) in (int, float) and 0 <= value <= 86400 and math.isfinite(value):
                result["retry_timeout"] = value
        except Exception:
            pass
    return result
