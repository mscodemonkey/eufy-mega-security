# Device capability catalogue

This is the detailed, contributor-editable device reference for the gateway.
Each file in `devices/` describes one device or hardware variant, including:

- model codes, aliases, product category, and device-type mapping
- device and station properties
- device and station commands
- hardware features
- raw selectable values and their app labels
- evidence level, hardware confirmation, conflicts, and notes

The files are split by device so a contributor can update one model without
editing an 80-column spreadsheet or creating merge conflicts across the whole
catalogue. JSON was chosen because GitHub renders it clearly, editors can apply
`schema.json`, and the gateway can consume it without a custom parser.

Each filename combines the primary model code and readable display name, such
as `t8170-solocam-s340.json`. The `id` stays minimal and stable, so that record
uses `t8170`. Add the shortest meaningful ID suffix only when distinct records
share a model code, such as `t8200-standard` and `t8200-variant-6`. Use a stable
product slug when no model code is confirmed. Source-specific identifiers do
not belong in filenames or IDs.

## Evidence boundary

An external declaration says that a property may exist. It does not prove that
a device reports it or that a write works. Keep `evidence_tier`,
`hardware_verified`, `confidence`, and `conflict_flag` intact so runtime code
can make conservative decisions.

Do not record reference implementation names, repository locations, source
excerpts, or cross-references here. Convert useful findings into neutral device
facts and retain only the evidence level needed to judge them safely.

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
- `schema.json` documents the editable structure.

The device files are the maintained source. Contributors should update them
directly instead of importing private research material into the repository.
