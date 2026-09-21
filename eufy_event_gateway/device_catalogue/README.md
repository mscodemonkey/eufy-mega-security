# Device capability catalogue

This is the detailed, contributor-editable device reference for the gateway.
Each file in `devices/` describes one device or hardware variant, including:

- model codes, aliases, product category, and SDK mapping
- device and station properties
- device and station commands
- hardware features
- raw selectable values and their app labels
- evidence level, hardware confirmation, conflicts, and notes

The files are split by device so a contributor can update one model without
editing an 80-column spreadsheet or creating merge conflicts across the whole
catalogue. JSON was chosen because GitHub renders it clearly, editors can apply
`schema.json`, and the gateway can consume it without a custom parser.

## Evidence boundary

An SDK declaration says that a property may exist. It does not prove that a
device reports it or that a write works. Keep `evidence_tier`,
`hardware_verified`, `confidence`, and `conflict_flag` intact so runtime code
can make conservative decisions.

The existing `src/provider/devices/catalogue.ts` remains the smaller ledger of
gateway behaviour confirmed by developer or community testing. This reference
catalogue does not automatically enable a control.

## Updating a device

1. Open the matching file under `devices/`.
2. Update the relevant capability, value, or evidence fields.
3. Add a new device file by copying the closest model when no match exists.
4. Run `npm run catalogue:check` from `eufy_event_gateway`.

Use the model query when locating a record:

```sh
npm run catalogue:query -- T817L
npm run catalogue:query -- T817L nightvision
```

Do not add serial numbers, account details, camera names, credentials, or raw
payloads. Model numbers, numeric device types, protocol parameter identifiers,
and public evidence links are suitable for this catalogue.

## Supporting files

- `property-reference.json` is the cross-device property glossary.
- `unmapped-device-types.json` records known numeric types without a confirmed
  retail model.
- `unmatched-hardware-evidence.json` preserves evidence that applies to a model
  such as a HomeBase but did not map to one of the supplied camera records.
- `import-provenance.json` records all eight source files and their imported row
  counts without retaining a second copy of the wide matrix.
- `schema.json` documents the editable structure.

`tools/import_device_catalogue.py` records the original CSV migration. It is a
replacement import, not the normal contribution workflow. Direct device-file
edits are authoritative after the migration.
