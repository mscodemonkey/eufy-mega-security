"""Feed one authenticated gateway video connection to go2rtc's private pipe.

The owner supplies a private connection file from diagnostic-bundle.py. This
process owns one HTTP response and its stdout pipe, without a retry loop or
camera controls. go2rtc owns consumer demand, process termination and RTSP
access. Gateway source ownership and normal idle cleanup remain authoritative.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class SourceError(Exception):
    """Report a fixed failure without exposing connection secrets or HTTP paths."""


class NoRedirect(HTTPRedirectHandler):
    """Keep the saved bearer credential on its original gateway origin."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Reject every redirect, including same-origin changes of camera route."""
        return None


def read_connection(path: Path) -> tuple[str, str]:
    """Read a finite owner-private regular file and admit only one camera video URL."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 16384:
            raise SourceError("Use the generated private connection file.")
        value = json.loads(stream.read(16385))
    if not isinstance(value, dict) or set(value) != {"schema", "url", "token"} or type(value["schema"]) is not int or value["schema"] != 1:
        raise SourceError("The producer connection is invalid.")
    url, token = value["url"], value["token"]
    if not isinstance(url, str) or not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,512}", token):
        raise SourceError("The producer connection is invalid.")
    parsed = urlsplit(url)
    parts = parsed.path.split("/")
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment or len(parts) != 5
            or parts[:3] != ["", "api", "cameras"] or parts[4] != "live.h264"
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", unquote(parts[3]))
            or any(ord(char) < 33 or ord(char) > 126 for char in url)):
        raise SourceError("The producer connection is invalid.")
    parsed.port
    return url, token


def stream_source(path: Path, output) -> None:
    """Hold one source until its consumer closes, refusing redirects and non-video replies."""
    url, token = read_connection(path)
    opener = build_opener(ProxyHandler({}), NoRedirect())
    request = Request(url, headers={"Authorization": "Bearer " + token})
    with opener.open(request, timeout=45) as response:
        if response.status != 200 or response.headers.get_content_type() != "video/h264":
            raise SourceError("The gateway did not open the expected video source.")
        while True:
            chunk = response.read1(16384)
            if not chunk:
                return
            output.write(chunk)
            output.flush()


def main(arguments=None) -> int:
    """Expose media only on stdout and fixed errors on stderr, with no automatic retry."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", type=Path, required=True)
    options = parser.parse_args(arguments)

    def stop(_signal, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    try:
        stream_source(options.connection, sys.stdout.buffer)
        return 0
    except (BrokenPipeError, KeyboardInterrupt):
        return 0
    except Exception:
        print("E10 source unavailable. Check the private connection and gateway log.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
