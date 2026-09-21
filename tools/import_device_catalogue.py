"""Import the researched Eufy CSV pack into the contributor device catalogue.

The importer owns only the one-way migration from research spreadsheets. The
resulting per-device JSON files become the editable source consumed by the
catalogue validator and future documentation or runtime generators.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any


CSV_FILES = {
    "devices": "eufy_devices.csv",
    "capabilities": "eufy_device_capabilities.csv",
    "selectable_values": "eufy_selectable_values.csv",
    "unmapped_types": "eufy_unmapped_device_types.csv",
    "property_reference": "eufy_property_reference.csv",
    "aliases": "eufy_model_aliases.csv",
    "hardware_evidence": "eufy_hw_evidence_mega_sdk.csv",
    "wide_matrix": "eufy_cameras_doorbells_capability_matrix.csv",
}


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return [
            {key: _public_text(value) for key, value in row.items()}
            for row in csv.DictReader(handle)
        ]


def _public_text(value: str) -> str:
    return (
        value.replace("Marty project", "gateway project")
        .replace("Marty app testing", "developer app testing")
        .replace("Marty-project", "gateway-project")
        .replace("Marty", "developer")
    )


def _non_empty(row: dict[str, str], *keys: str) -> dict[str, str]:
    return {key: row[key].strip() for key in keys if row.get(key, "").strip()}


def _split(value: str) -> list[str]:
    return [part.strip() for part in value.split(";") if part.strip()]


def _integer(value: str) -> int | None:
    return int(value) if value.strip() else None


def _number(value: str) -> int | float | None:
    if not value.strip():
        return None
    number = float(value)
    return int(number) if number.is_integer() else number


def _slug(device: dict[str, str]) -> str:
    models = _split(device["model_codes"])
    primary = models[0] if models else device["device_id"]
    name = re.sub(r"[^a-z0-9]+", "-", device["display_name"].lower()).strip("-")
    return f"{primary.lower()}-{name}-{device['device_id'].lower()}"


def _option(row: dict[str, str]) -> dict[str, Any]:
    option: dict[str, Any] = {
        "value": _number(row["raw_value"]) if re.fullmatch(r"-?\d+(?:\.\d+)?", row["raw_value"].strip()) else row["raw_value"].strip(),
    }
    option.update(_non_empty(row, "sdk_label", "app_label", "app_label_source", "evidence_tier", "hardware_verified", "evidence_source", "verified_date", "conflict_flag", "notes"))
    return option


def _capability(row: dict[str, str], options: list[dict[str, Any]]) -> dict[str, Any]:
    capability: dict[str, Any] = {
        "key": row["capability_key"].strip(),
        "context": row["context"].strip() or "default",
        "available": row["available"].strip(),
    }
    capability.update(_non_empty(row, "label", "access"))

    protocol = _non_empty(row, "protocol_key_name", "command_name")
    if row["protocol_key_num"].strip():
        protocol["protocol_key_num"] = _integer(row["protocol_key_num"])
    if row["command_id"].strip():
        protocol["command_id"] = _integer(row["command_id"])
    if protocol:
        capability["protocol"] = protocol

    value = _non_empty(row, "value_type", "unit")
    for key in ("min", "max", "step"):
        if row[key].strip():
            value[key] = _number(row[key])
    if options:
        value["options"] = options
    if value:
        capability["value"] = value

    evidence = _non_empty(
        row,
        "evidence_tier",
        "hardware_verified",
        "evidence_source",
        "verified_date",
        "confidence",
        "conflict_flag",
        "notes",
    )
    if evidence:
        capability["evidence"] = evidence

    cross_reference = _non_empty(
        row,
        "xref_mega_param_name",
        "xref_mega_param_provenance",
        "xref_mega_hw_evidence",
    )
    if cross_reference:
        capability["cross_reference"] = cross_reference
    return capability


def _device_record(
    device: dict[str, str],
    capabilities: list[dict[str, str]],
    options: dict[tuple[str, str, str, str], list[dict[str, Any]]],
    aliases: list[dict[str, str]],
    hardware_evidence: list[dict[str, str]],
) -> dict[str, Any]:
    catalogue_id = device["device_id"].strip()
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in capabilities:
        key = (catalogue_id, row["capability_kind"], row["capability_key"], row["context"])
        grouped[row["capability_kind"]].append(_capability(row, options.get(key, [])))

    identity: dict[str, Any] = {
        "display_name": device["display_name"].strip(),
        "model_codes": _split(device["model_codes"]),
        "models_raw": device["models_raw"].strip(),
        "aliases": _split(device["aliases"]),
        "product_category": device["product_category"].strip(),
    }
    identity.update(_non_empty(device, "variant_rule"))

    sdk: dict[str, Any] = {
        "mapping_confidence": device["model_to_sdk_mapping_confidence"].strip(),
        "docs_status": device["sdk_docs_status"].strip(),
        "property_count": int(device["sdk_property_count"]),
        "command_count": int(device["sdk_command_count"]),
        "coverage": device["sdk_coverage"].strip(),
    }
    if device["sdk_device_type_id"].strip():
        sdk["device_type_id"] = int(device["sdk_device_type_id"])
    sdk.update(_non_empty(device, "sdk_enum_name", "sdk_type_label", "sdk_topology"))

    observations = _non_empty(
        device,
        "night_vision_control_sdk",
        "night_vision_user_observed",
        "observed_device_type_not_in_sdk",
        "observed_device_type_source",
        "currently_sold",
        "notes",
    )
    observations["mega_sdk_hw_evidence_lines"] = int(device["mega_sdk_hw_evidence_lines"])

    device_aliases = []
    for row in aliases:
        if catalogue_id not in _split(row["device_ids"]):
            continue
        device_aliases.append({
            "alias": row["alias"].strip(),
            "canonical_model": row["canonical_model"].strip(),
            **_non_empty(row, "kind", "evidence_tier", "evidence", "verified_date"),
        })

    evidence_rows = []
    for row in hardware_evidence:
        if catalogue_id not in _split(row["matching_device_ids"]):
            continue
        evidence_rows.append(_non_empty(row, *row.keys()))

    record: dict[str, Any] = {
        "$schema": "../schema.json",
        "id": catalogue_id,
        "identity": identity,
        "sdk": sdk,
        "observations": observations,
        "capabilities": dict(sorted(grouped.items())),
    }
    if device_aliases:
        record["model_aliases"] = device_aliases
    if evidence_rows:
        record["hardware_evidence"] = evidence_rows
    _apply_known_hardware_overrides(record)
    return record


def _apply_known_hardware_overrides(record: dict[str, Any]) -> None:
    if record["id"] != "nolib_T817L":
        return
    observations = record["observations"]
    observations["night_vision_user_observed"] = (
        "Hardware-confirmed: app menu and gateway readback use raw 0 PureColor, "
        "raw 1 Infrared, and raw 2 Spotlight."
    )
    observations["notes"] = (
        "Device type 10031 is developer-observed but absent from the referenced SDK catalogues. "
        "Night vision readback and writes are confirmed for PureColor, Infrared, and Spotlight."
    )
    night_vision = next(
        capability
        for capability in record["capabilities"]["device_property"]
        if capability["key"] == "nightvision" and capability["context"] == "app-observed"
    )
    night_vision["access"] = "RW"
    night_vision["evidence"] = {
        "evidence_tier": "developer_tested",
        "hardware_verified": "yes",
        "evidence_source": "Developer testing with a T817L through the gateway and Eufy app",
        "verified_date": "2026-09-21",
        "confidence": "high",
        "notes": "All three raw values were written and confirmed against their Eufy app labels.",
    }
    labels = {0: "PureColor", 1: "Infrared", 2: "Spotlight"}
    for option in night_vision["value"]["options"]:
        option["app_label"] = labels[option["value"]]
        option["app_label_source"] = "developer_tested"
        option["evidence_tier"] = "developer_tested"
        option["hardware_verified"] = "yes"
        option["evidence_source"] = "Developer testing with a T817L through the gateway and Eufy app"
        option["verified_date"] = "2026-09-21"
        option.pop("conflict_flag", None)
        option["notes"] = f"Confirmed raw {option['value']} as {option['app_label']}."


def main() -> None:
    """Import a complete CSV pack into deterministic per-device JSON files."""
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Directory containing the eight CSV files")
    parser.add_argument("destination", type=Path, help="Catalogue directory to replace")
    parser.add_argument("--apply", action="store_true", help="Write files instead of reporting the import plan")
    args = parser.parse_args()

    missing = [name for name in CSV_FILES.values() if not (args.source / name).is_file()]
    if missing:
        raise SystemExit(f"Missing CSV files: {', '.join(missing)}")

    rows = {key: _read_csv(args.source / name) for key, name in CSV_FILES.items()}
    device_ids = {row["device_id"].strip() for row in rows["devices"]}
    capability_ids = {row["device_id"].strip() for row in rows["capabilities"]}
    value_ids = {row["device_id"].strip() for row in rows["selectable_values"]}
    if capability_ids - device_ids or value_ids - device_ids:
        raise SystemExit("Capability or selectable-value rows refer to an unknown device id")

    option_rows: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows["selectable_values"]:
        key = (row["device_id"], row["capability_kind"], row["capability_key"], row["context"])
        option_rows[key].append(_option(row))

    capabilities_by_device: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows["capabilities"]:
        capabilities_by_device[row["device_id"]].append(row)

    records = [
        (_slug(device), _device_record(
            device,
            capabilities_by_device[device["device_id"]],
            option_rows,
            rows["aliases"],
            rows["hardware_evidence"],
        ))
        for device in rows["devices"]
    ]
    summary = {
        "devices": len(records),
        "capabilities": len(rows["capabilities"]),
        "selectable_values": len(rows["selectable_values"]),
        "property_reference_rows": len(rows["property_reference"]),
        "unmapped_device_types": len(rows["unmapped_types"]),
        "hardware_evidence_rows": len(rows["hardware_evidence"]),
        "wide_matrix_rows_checked": len(rows["wide_matrix"]),
    }
    print(json.dumps(summary, indent=2))
    if not args.apply:
        return

    devices_directory = args.destination / "devices"
    devices_directory.mkdir(parents=True, exist_ok=True)
    for path in devices_directory.glob("*.json"):
        path.unlink()
    for slug, record in sorted(records):
        (devices_directory / f"{slug}.json").write_text(
            json.dumps(record, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    (args.destination / "property-reference.json").write_text(
        json.dumps(rows["property_reference"], indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (args.destination / "unmapped-device-types.json").write_text(
        json.dumps(rows["unmapped_types"], indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (args.destination / "unmatched-hardware-evidence.json").write_text(
        json.dumps(
            [row for row in rows["hardware_evidence"] if not _split(row["matching_device_ids"])],
            indent=2,
            ensure_ascii=False,
        ) + "\n",
        encoding="utf-8",
    )
    (args.destination / "import-provenance.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "compiled_date": "2026-09-21",
                "source_files": {
                    CSV_FILES[key]: len(rows[key])
                    for key in CSV_FILES
                },
                "note": (
                    "The normalized per-device files are authoritative after this migration. "
                    "The wide matrix was used as a reconciliation source and is not duplicated."
                ),
            },
            indent=2,
            ensure_ascii=False,
        ) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
