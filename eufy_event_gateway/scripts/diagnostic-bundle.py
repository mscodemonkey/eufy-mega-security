"""Run consented private diagnostics through the saved gateway connection.

This owner-run utility reads Home Assistant's existing local integration token
without displaying it. The gateway owns selection, consent and capture limits.
The utility owns bounded transfers, an optional live viewer and exclusive private
output files. Archive inspection never executes content or displays private media.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import math
import multiprocessing
import os
from pathlib import Path
import stat
import sys
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import ProxyHandler, Request, build_opener
import zlib


SPEC = importlib.util.spec_from_file_location(
    "eufy_private_export", Path(__file__).with_name("export-event-image-capture.py")
)
assert SPEC and SPEC.loader
HELPERS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPERS)
MAX_WIRE = 96 * 1024 * 1024
MAX_JSON = 112 * 1024 * 1024
MAX_MEDIA = 64 * 1024 * 1024
MAX_RECORDS = 20_000
MOVEMENT_DIRECTIONS = ("left", "right", "up", "down")
MOVEMENT_ADMISSION_MESSAGES = {
    "connection_key_unavailable": "The camera connection key is not ready.",
    "direct_route_unavailable": "The direct camera route is not ready.",
    "owner_account_required": "The configured account does not own the admitted camera route.",
    "unsupported_identity": "The selected device identity is not admitted for this test.",
}


class DiagnosticError(Exception):
    """Carry fixed safe errors rather than credential-bearing network exceptions."""


class DiagnosticRequestError(DiagnosticError):
    """Retain only an HTTP status, never an upstream URL, body or exception."""

    def __init__(self, status: int | None = None):
        """Use a missing status when no accepted HTTP response was available."""
        self.status = status if type(status) is int and 100 <= status <= 599 else None
        message = f"Gateway request failed (HTTP {self.status})." if self.status else "Gateway connection failed."
        super().__init__(message)


def request(url: str, token: str, method: str = "GET", value=None, *, timeout: int = 15, transfer_seconds: int = 45) -> bytes:
    """Reject redirects and proxies, and limit response size and transfer time."""
    data = json.dumps(value).encode() if value is not None else None
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
    opener = build_opener(ProxyHandler({}), HELPERS.NoRedirect())
    deadline = time.monotonic() + transfer_seconds
    try:
        with opener.open(Request(url, data=data, headers=headers, method=method), timeout=timeout) as response:
            body = bytearray()
            while True:
                if time.monotonic() >= deadline:
                    raise DiagnosticError("Diagnostic transfer timed out.")
                chunk = response.read(min(64 * 1024, MAX_WIRE + 1 - len(body)))
                if not chunk:
                    return bytes(body)
                body.extend(chunk)
                if len(body) > MAX_WIRE:
                    raise DiagnosticError("Diagnostic response exceeded its limit.")
    except DiagnosticError:
        raise
    except HTTPError as error:
        status = error.code
        error.close()
        raise DiagnosticRequestError(status) from None
    except Exception:
        raise DiagnosticRequestError() from None


def inspect_archive(body: bytes) -> dict:
    """Validate gzip, record limits and every media checksum without executing data."""
    if len(body) > MAX_WIRE:
        raise DiagnosticError("Diagnostic file exceeded its limit.")
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    decoded = decoder.decompress(body, MAX_JSON + 1)
    if len(decoded) > MAX_JSON or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise DiagnosticError("Diagnostic compression is invalid or exceeds its limit.")
    archive = json.loads(decoded)
    if not isinstance(archive, dict) or archive.get("schema") != "eufy-diagnostics-1":
        raise DiagnosticError("Unrecognized diagnostic archive.")
    if set(archive) != {"schema", "summary", "capture", "stages", "records", "media"}:
        raise DiagnosticError("Unrecognized diagnostic members.")
    records, media = archive["records"], archive["media"]
    if not isinstance(records, list) or not isinstance(media, list) or len(records) + len(media) > MAX_RECORDS:
        raise DiagnosticError("Diagnostic record limit exceeded.")
    for section in (records, media):
        previous = -1
        for row in section:
            value = row.get("offsetMs") if isinstance(row, dict) else None
            if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= 60_000 or value < previous:
                raise DiagnosticError("Invalid diagnostic timing.")
            previous = value
    total = 0
    kinds = {}
    for row in media:
        if set(row) != {"offsetMs", "device", "kind", "codec", "bytes", "sha256", "base64"}:
            raise DiagnosticError("Unrecognized media record.")
        if row["kind"] not in {"video", "audio", "snapshot", "event-image"} or row["codec"] not in {"h264", "h265", "unknown", "aac", "jpeg"}:
            raise DiagnosticError("Unrecognized media format.")
        raw = base64.b64decode(row["base64"], validate=True)
        total += len(raw)
        if total > MAX_MEDIA or len(raw) != row["bytes"] or hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise DiagnosticError("Diagnostic media failed its integrity check.")
        kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
    if not isinstance(archive["capture"], dict) or archive["capture"].get("mediaBytes") != total:
        raise DiagnosticError("Diagnostic manifest does not match its media.")
    return {"valid": True, "archiveBytes": len(body), "records": len(records),
            "mediaChunks": len(media), "mediaBytes": total, "kinds": kinds,
            "sharing": "private_cloud_link" if len(body) > 20_000_000 else "email_or_private_cloud_link"}


def read_archive(path: Path) -> bytes:
    """Read a regular, non-symlink input with a strict compressed size limit."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise DiagnosticError("Choose a regular diagnostic file.")
        body = stream.read(MAX_WIRE + 1)
    if len(body) > MAX_WIRE:
        raise DiagnosticError("Diagnostic file exceeded its limit.")
    return body



def private_output_path(config: Path, output: Path) -> Path:
    """Allow HA's trusted config mount alias, rejecting symlinks beneath that root."""
    target = Path(os.path.abspath(output))
    root = Path(os.path.abspath(config)).parent.parent
    try:
        relative = target.relative_to(root)
    except ValueError:
        pass
    else:
        current = root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise DiagnosticError("Choose a non-symlink private output path.")
        target = root.resolve() / relative
    target = HELPERS.output_path(config, target)
    if any(part.lower() in {"www", "public", "static"} for part in target.parts):
        raise DiagnosticError("Choose a private output folder.")
    return target

def save_archive(config: Path, output: Path, body: bytes) -> dict:
    """Validate before creating a private file, refusing overwrite and public paths."""
    report = inspect_archive(body)
    target = private_output_path(config, output)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    identity = os.fstat(descriptor)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        current = target.lstat()
        if current.st_ino == identity.st_ino and current.st_dev == identity.st_dev:
            target.unlink()
        raise
    return report


def live_view(url: str, token: str) -> None:
    """Hold an existing camera viewer in an owned child, discarding HTTP media copies."""
    try:
        opener = build_opener(ProxyHandler({}), HELPERS.NoRedirect())
        with opener.open(Request(url, headers={"Authorization": "Bearer " + token}), timeout=45) as response:
            while response.read(64 * 1024):
                pass
    except Exception:
        pass


def devices(endpoint: str, token: str) -> list[dict]:
    """Read the current closed device selection without exposing identifiers."""
    value = json.loads(request(endpoint + "/targets", token))
    rows = value.get("devices") if isinstance(value, dict) else None
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise DiagnosticError("Gateway returned an invalid device list.")
    return rows



def s220_settings_check(url: str, token: str, target: dict) -> dict:
    """Summarize cached S220 settings admission without a camera query or write.

    The gateway owns these observations. A missing current value can withhold
    an entity, while a known value with unavailable control leaves other gates
    unresolved. Neither result proves physical settings or authorizes a change.
    """
    if target.get("model") != "T8134" or not isinstance(target.get("serial"), str) or not target["serial"]:
        raise DiagnosticError("Select the exact S220 model T8134 from the current list.")
    try:
        value = json.loads(request(url + "/api/cameras", token))
        rows = value.get("cameras") if isinstance(value, dict) else None
        if not isinstance(rows, list) or len(rows) > 1000 or any(not isinstance(row, dict) for row in rows):
            raise ValueError()
        matches = [row for row in rows if row.get("serial") == target["serial"]]
        if len(matches) != 1 or matches[0].get("model") != "T8134":
            raise ValueError()
        camera = matches[0]
        quality, sensitivity = camera.get("streamingQualityControlSupported"), camera.get("motionSensitivityControlSupported")
        settings = camera.get("reportedSettings")
        if settings is not None and not isinstance(settings, dict):
            raise ValueError()
        settings = settings or {}
        modes = camera.get("streamingQualityModes")
        if type(quality) is not bool or type(sensitivity) is not bool or not isinstance(modes, list) or len(modes) > 4:
            raise ValueError()
        choices = []
        for mode in modes:
            if not isinstance(mode, dict) or type(mode.get("value")) is not int or not 0 <= mode["value"] <= 3:
                raise ValueError()
            choices.append(mode["value"])
        if len(set(choices)) != len(choices):
            raise ValueError()
        current = settings.get("streamingQualityTier")
        step = settings.get("motionSensitivityStep")
        return {"model": "T8134", "qualityControlAvailable": quality,
                "qualityCurrentKnown": type(current) is int and 0 <= current <= 3,
                "qualityChoiceCount": len(choices), "sensitivityControlAvailable": sensitivity,
                "sensitivityCurrentKnown": type(step) is int and 1 <= step <= 7,
                "commandSent": False}
    except (ValueError, TypeError, DiagnosticError):
        raise DiagnosticError("S220 settings summary unavailable. No camera command was sent.") from None


def selected_device(rows: list[dict], index: int) -> dict:
    """Resolve a current one-based index while keeping serials out of output."""
    if not 1 <= index <= len(rows):
        raise DiagnosticError("Choose a device index from the current list.")
    row = rows[index - 1]
    if not isinstance(row.get("serial"), str) or not row["serial"]:
        raise DiagnosticError("Gateway returned an invalid device selection.")
    return row


def recording_index_window(begin: int | None, end: int | None) -> dict:
    """Validate UTC seconds before credentials or a camera connection are used."""
    now = int(time.time())
    if begin is None and end is None:
        return {}
    if (type(begin) is not int or type(end) is not int or begin < 946684800
            or end <= begin or end - begin > 1800 or end > now or begin < now - 86400):
        raise DiagnosticError("Choose an interval of at most thirty minutes within the previous day, in UTC Unix seconds.")
    return {"beginTime": begin, "endTime": end}


def recording_index_check(url: str, token: str, target: dict, begin: int | None = None, end: int | None = None) -> dict:
    """Read one exact C31 interval and return only matched structural counts.

    Refusals are never retried with another window or interpreted as empty
    recordings. The helper never starts playback or changes recording settings.
    """
    window = recording_index_window(begin, end)
    serial = target.get("serial")
    if target.get("model") != "T817L" or not isinstance(serial, str) or not serial:
        raise DiagnosticError("Select the exact standalone C31 model T817L from the current list.")
    endpoint = url + "/api/cameras/" + quote(serial, safe="") + "/recording-index-trial"
    body = request(endpoint, token, "POST", {"consentReadRecordingIndex": True, **window},
                   timeout=50, transfer_seconds=50)
    try:
        if len(body) > 16384:
            raise ValueError()
        value = json.loads(body)
        if not isinstance(value, dict) or set(value) != {
                "outcome", "windowMatches", "ownerMatches", "valid", "invalid", "overlapping"}:
            raise ValueError()
        if (value["windowMatches"] is not True or value["ownerMatches"] is not True
                or any(type(value[key]) is not int or not 0 <= value[key] <= 512
                       for key in ("valid", "invalid", "overlapping"))
                or value["valid"] + value["invalid"] > 512 or value["overlapping"] > value["valid"]):
            raise ValueError()
        expected = "empty" if value["valid"] + value["invalid"] == 0 else "intervals" if value["valid"] else "unusable"
        if value["outcome"] != expected:
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise DiagnosticError("Gateway returned an invalid recording-index summary.") from None
    return {"model": "T817L", **value, "playbackConfirmed": False}


def spotlight_read_check(url: str, token: str, target: dict) -> dict:
    """Request only the C35 state-read action, never falling back to a light command."""
    serial = target.get("serial")
    if target.get("model") != "T8110" or not isinstance(serial, str) or not serial:
        raise DiagnosticError("Select the C35 model T8110 from the current list.")
    endpoint = url + "/api/cameras/" + quote(serial, safe="") + "/model-control-trial"
    body = request(endpoint, token, "POST", {"action": "spotlightState", "enabled": False},
                   timeout=50, transfer_seconds=50)
    try:
        if len(body) > 16384:
            raise ValueError()
        value = json.loads(body)
        if not isinstance(value, dict) or value.get("readOnly") is not True or len(value) != 3:
            raise ValueError()
        if value.get("outcome") == "reported":
            if set(value) != {"outcome", "readOnly", "spotlightEnabled"} or type(value["spotlightEnabled"]) is not bool:
                raise ValueError()
        elif value.get("outcome") == "unavailable":
            if set(value) != {"outcome", "readOnly", "reason"} or value.get("reason") not in (
                    "no_reply", "not_decoded", "invalid_json", "invalid_schema", "setting_missing", "unavailable"):
                raise ValueError()
        else:
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise DiagnosticError("Gateway returned an invalid spotlight state-read summary.") from None
    return {"model": "T8110", **value, "lightCommandSent": False}


def movement_admission(url: str, token: str, target: dict) -> str:
    """Read admission without any write and retain only fixed safe failure details."""
    endpoint = url + "/api/cameras/" + quote(target["serial"], safe="") + "/model-control-trial"
    try:
        admission = json.loads(request(endpoint, token))
    except DiagnosticRequestError as error:
        detail = f"Gateway replied HTTP {error.status}." if error.status else "Gateway connection failed."
        raise DiagnosticError(f"Movement admission failed before any command was sent. {detail}") from None
    except (ValueError, UnicodeError):
        raise DiagnosticError("Gateway returned an invalid movement admission. No command was sent.") from None
    except Exception:
        raise DiagnosticError("Movement admission failed before any command was sent. Check the gateway connection and try the current list again.") from None
    actions = admission.get("actions") if isinstance(admission, dict) else None
    if not isinstance(actions, list) or any(not isinstance(action, str) for action in actions):
        raise DiagnosticError("Gateway returned an invalid movement admission. No command was sent.")
    if "ptz" not in actions:
        reason = admission.get("unavailableReason") if isinstance(admission, dict) else None
        detail = MOVEMENT_ADMISSION_MESSAGES.get(reason, "The selected device has no admitted movement test.")
        raise DiagnosticError(f"Movement was not sent. {detail}")
    return endpoint


def movement_test(url: str, token: str, rows: list[dict], index: int, direction: str) -> dict:
    """Send one admitted movement and return only its closed confirmation boundary."""
    endpoint = movement_admission(url, token, selected_device(rows, index))
    try:
        result = json.loads(request(endpoint, token, "POST", {"action": "ptz", "direction": direction}))
    except DiagnosticRequestError as error:
        detail = f"Gateway replied HTTP {error.status}." if error.status else "Gateway connection failed."
        raise DiagnosticError(f"Movement request did not complete. {detail} Check the camera and restore its original view before trying again.") from None
    except Exception:
        raise DiagnosticError("Movement was admitted but did not complete. Check the gateway for the model_control_trial_failed line.") from None
    if not isinstance(result, dict) or result.get("outcome") != "acknowledged" or result.get("physicalConfirmationRequired") is not True:
        raise DiagnosticError("Gateway did not acknowledge the movement test.")
    return {"outcome": "acknowledged", "physicalConfirmationRequired": True,
            "next": "Check whether the camera moved, then restore its original view in Eufy."}


def parameter_check(url: str, token: str, target: dict) -> dict:
    """Read one supported profile and reject private or unrecognised response fields."""
    profiles = {
        "T8410": ("power_candidates", {"1035", "2001"}),
        "T8417": ("privacy_candidates", {"1035", "2001", "6250", "6271"}),
        "T8030": ("alarm_volume_candidate", {"1235"}),
        "T8910": ("motion_time_candidate", {"1605"}),
    }
    model = target["model"]
    if model not in profiles:
        raise DiagnosticError("The selected model does not support this read-only state check.")
    result = json.loads(request(url + "/api/diagnostics/parameter-check", token, "POST",
                                {"serial": target["serial"], "consent": True}, timeout=35))
    profile, fields = profiles[model]
    allowed = ({"missing", "unset", "recent", "older", "future", "invalid", "conflicting"} if model == "T8910"
               else {"missing", "invalid", "conflicting", "valid"} if model == "T8030"
               else {"missing", "invalid", "conflicting", "zero", "one"})
    if (not isinstance(result, dict) or set(result) != {"model", "profile", "observations"}
            or result["model"] != model or result["profile"] != profile
            or not isinstance(result["observations"], dict) or set(result["observations"]) != fields
            or any(not isinstance(value, str) or value not in allowed for value in result["observations"].values())):
        raise DiagnosticError("The read-only state check returned an unsupported summary.")
    return result


def e10_video_test(url: str, token: str, target: dict, config: Path, output: Path) -> dict:
    """Save one consented E10 clip using the existing server admission and lifetime.

    The gateway independently checks type, topology and owner before any trial.
    Reserve a private file before dispatch and never retry an uncertain request.
    A received MP4 header is not a playback or selected-camera confirmation.
    """
    if target.get("model") != "T8404":
        raise DiagnosticError("Choose the exact T8404 E10 from the current list. No trial was sent.")
    destination = private_output_path(config, output)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    identity = os.fstat(descriptor)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            try:
                clip = request(url + "/api/cameras/" + quote(target["serial"], safe="") + "/nvr-live-trial",
                               token, "POST", {"consentPrivateMedia": True}, timeout=90, transfer_seconds=90)
            except DiagnosticError as error:
                status = error.status if isinstance(error, DiagnosticRequestError) else None
                detail = f" Gateway replied HTTP {status}." if status else ""
                raise DiagnosticError("E10 video test did not complete." + detail
                                      + " Do not repeat it. Share only the nvr_live_trial_failed line if one was logged.") from None
            if not 12 <= len(clip) <= MAX_MEDIA or clip[4:8] != b"ftyp":
                raise DiagnosticError("E10 test returned an unsupported clip. Do not repeat it. Keep any failure details private.")
            stream.write(clip)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        try:
            current = destination.lstat()
            if current.st_ino == identity.st_ino and current.st_dev == identity.st_dev:
                destination.unlink()
        except FileNotFoundError:
            pass
        raise
    return {"clipSaved": True, "bytes": len(clip), "playbackConfirmed": False,
            "next": "Check the private clip for ten seconds of the selected camera. Keep it private and restore the experimental option."}


def run(options) -> dict:
    """Perform the selected owner-requested workflow, retaining tokens only in memory."""
    if options.command == "inspect":
        return inspect_archive(read_archive(options.input))
    if options.command == "e10-video-test" and not options.consent_private_media:
        raise DiagnosticError("The E10 video test requires explicit private-media consent.")
    if options.command == "state-check" and not options.consent_read:
        raise DiagnosticError("The read-only state check requires explicit read consent.")
    if options.command == "recording-index-check":
        if not options.consent_read:
            raise DiagnosticError("The recording-index check requires explicit read consent.")
        recording_index_window(options.begin_time, options.end_time)
    if options.command == "spotlight-read-check" and not options.consent_read:
        raise DiagnosticError("The spotlight state check requires explicit read consent.")
    url, token = HELPERS.gateway_connection(options.config, options.entry_id)
    endpoint = url + "/api/diagnostics/bundle"
    if options.command == "list":
        rows = devices(endpoint, token)
        return {"devices": [{"index": i + 1, "model": row["model"], "streamSupported": row["streamSupported"]}
                            for i, row in enumerate(rows)]}
    if options.command == "s220-settings-check":
        return s220_settings_check(url, token, selected_device(devices(endpoint, token), options.target_index))
    if options.command == "state-check":
        rows = devices(endpoint, token)
        return parameter_check(url, token, selected_device(rows, options.target_index))
    if options.command == "recording-index-check":
        target = selected_device(devices(endpoint, token), options.target_index)
        return recording_index_check(url, token, target, options.begin_time, options.end_time)
    if options.command == "spotlight-read-check":
        return spotlight_read_check(url, token, selected_device(devices(endpoint, token), options.target_index))
    if options.command == "e10-video-test":
        return e10_video_test(url, token, selected_device(devices(endpoint, token), options.target_index), options.config, options.output)
    if options.command == "movement-check":
        rows = devices(endpoint, token)
        movement_admission(url, token, selected_device(rows, options.target_index))
        return {"movementAdmitted": True, "commandSent": False}
    if options.command == "movement-test":
        if not options.consent_restore_view:
            raise DiagnosticError("Movement testing requires explicit restore-view consent.")
        return movement_test(url, token, devices(endpoint, token), options.target_index, options.direction)
    if options.command in {"status", "clear"}:
        return json.loads(request(endpoint, token, "DELETE" if options.command == "clear" else "GET"))
    if options.command == "export":
        return save_archive(options.config, options.output, request(endpoint + "/export", token, "POST"))
    if options.media and not options.consent_private_media:
        raise DiagnosticError("Private media capture requires explicit consent.")
    private_output_path(options.config, options.output)
    target = None
    rows = devices(endpoint, token)
    if options.target_index is not None:
        target = selected_device(rows, options.target_index)
    if options.open_live and (not options.media or not target or not target["streamSupported"]):
        raise DiagnosticError("Live capture requires media consent and one supported camera.")
    request(endpoint, token, "POST", {"target": target["serial"] if target else None,
            "seconds": options.seconds, "media": options.media, "consentPrivateMedia": options.consent_private_media})
    viewer = None
    try:
        if options.open_live:
            viewer = multiprocessing.get_context("spawn").Process(target=live_view,
                args=(url + "/api/cameras/" + quote(target["serial"], safe="") + "/live.h264", token))
            viewer.start()
        time.sleep(options.seconds)
    finally:
        if viewer:
            viewer.terminate()
            viewer.join(2)
            if viewer.is_alive():
                viewer.kill()
                viewer.join()
        request(endpoint + "/stop", token, "POST")
    return save_archive(options.config, options.output, request(endpoint + "/export", token, "POST"))


def main(arguments=None) -> int:
    """Run a capture or data-only inspection and print only a compact safe result."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("/config/.storage/core.config_entries"))
    parser.add_argument("--entry-id")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "status", "clear"):
        sub.add_parser(name)
    settings = sub.add_parser("s220-settings-check", help="Read cached S220 control availability without contacting the camera.")
    settings.add_argument("--target-index", type=int, required=True)
    state = sub.add_parser("state-check", help="Run one consented read-only reported-parameter check.")
    state.add_argument("--target-index", type=int, required=True,
                       help="Current one-based device index from the list command.")
    state.add_argument("--consent-read", action="store_true",
                       help="Allow one cloud parameter read using the existing configured account.")
    index = sub.add_parser("recording-index-check", help="Read one existing C31 recording interval without playback or settings changes.")
    index.add_argument("--target-index", type=int, required=True)
    index.add_argument("--begin-time", type=int, help="Interval start in UTC Unix seconds. Omit both times for the recent interval.")
    index.add_argument("--end-time", type=int, help="Interval end in UTC Unix seconds. Supply both times or neither.")
    index.add_argument("--consent-read", action="store_true")
    spotlight = sub.add_parser("spotlight-read-check", help="Read the C35 spotlight setting without operating the light.")
    spotlight.add_argument("--target-index", type=int, required=True)
    spotlight.add_argument("--consent-read", action="store_true")
    video = sub.add_parser("e10-video-test", help="Save one private E10 clip using the saved connection.")
    video.add_argument("--target-index", type=int, required=True)
    video.add_argument("--output", type=Path, required=True)
    video.add_argument("--consent-private-media", action="store_true")
    check = sub.add_parser("movement-check", help="Read movement admission without moving the camera.")
    check.add_argument("--target-index", type=int, required=True,
                       help="Current one-based device index from the list command.")
    movement = sub.add_parser("movement-test", help="Send one admitted experimental camera movement.")
    movement.add_argument("--target-index", type=int, required=True,
                          help="Current one-based device index from the list command.")
    movement.add_argument("--direction", choices=MOVEMENT_DIRECTIONS, required=True)
    movement.add_argument("--consent-restore-view", action="store_true",
                          help="Confirm that you recorded and will restore the original view.")
    capture = sub.add_parser("capture")
    capture.add_argument("--output", type=Path, required=True)
    capture.add_argument("--target-index", type=int)
    capture.add_argument("--seconds", type=int, choices=(30, 60), default=30)
    capture.add_argument("--media", action="store_true")
    capture.add_argument("--consent-private-media", action="store_true")
    capture.add_argument("--open-live", action="store_true")
    export = sub.add_parser("export")
    export.add_argument("--output", type=Path, required=True)
    inspect = sub.add_parser("inspect")
    inspect.add_argument("--input", type=Path, required=True)
    options = parser.parse_args(arguments)
    try:
        print(json.dumps(run(options), sort_keys=True))
        return 0
    except KeyboardInterrupt:
        message = ("E10 video test cancelled. Do not repeat it until its outcome is known. Restore the experimental option."
                   if options.command == "e10-video-test" else "Diagnostic capture cancelled. Stopped evidence may still be exported.")
        print(message, file=sys.stderr)
        return 130
    except DiagnosticError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("Diagnostic action failed. Check selection, consent, gateway connection and private file path.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
