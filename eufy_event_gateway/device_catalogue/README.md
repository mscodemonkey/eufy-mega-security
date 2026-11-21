# Device capability catalogue

This is the contributor-editable source for what the integration can read,
control, stream, and receive from each device. It deliberately excludes
marketing specifications and general product observations.

Every device record uses the same compact YAML format and is validated by the
catalogue check.

Every record also has an `integration` status:

- `recognised` identifies the product without creating Home Assistant entities.
- `ready_to_test` admits it through an implemented handler but still needs
  focused real-hardware confirmation.
- `supported` admits it through an implemented handler with confirmed working
  behaviour.

`ready_to_test` and `supported` records name their `camera`, `sensor`, or
`homebase` handler. Runtime identity and admission tables are generated from
these fields, so do not maintain a separate model or device-type allowlist.

Use `alternate_device_types` only when the same retail model has credible
evidence for another numeric inventory type. A `declared`, `mixed`, or `unknown`
alternate is recognised for diagnostics but is not admitted. A `reported` or
`tested` alternate inherits the record's implemented handler.

Use `category` when it helps distinguish cameras, doorbells, HomeBases, NVRs,
locks, sensors, sirens, keypads, remotes, safes, trackers, chimes, and other
accessories. Put alternate product names under `aliases` and model or product
codes under `models`. A short top-level `notes` value can hold a device-wide
caveat so it does not need to be repeated on every capability.

Each filename combines the primary model code and readable display name, such
as `t8170-solocam-s340.yaml`. The `id` stays minimal and stable, so that record
uses `t8170`. Add the shortest meaningful ID suffix only when distinct records
share a model code, such as `t8200-standard` and `t8200-variant-6`. Use a stable
product slug when no model code is confirmed. Source-specific identifiers do
not belong in filenames or IDs.

## Event exposure profiles

An admitted camera can explicitly select an implemented event profile under
`integration.event_profile`. The existing profile ID
`motion-person-pet-vehicle-sound` selects those five event entities when the
runtime has resolved the camera's direct connection. The generator binds the
profile to the first model in `models` and the primary numeric `device_type`.
Aliases, alternate numeric types and attached or unresolved connections do
not inherit it. Use this only for reviewed event exposure. Actual event delivery
still needs evidence in the appropriate `capabilities.events` connection.

## Capability groups

- `readable` contains values the integration can read but cannot change.
- `controls` contains settings or actions the integration can change. Put
  readable state for the same control in its `read` block.
- `media` contains live view, snapshots, and recordings.
- `events` contains motion, person, doorbell, sound, and similar events.

Omit groups that have no known entries. Use `ignored` only when a device reports
misleading values that the integration must deliberately suppress.

Use HomeBase model codes as connection IDs: `T8010`, `T8030`, and `T9000`.
Use `direct` for a camera that can connect without a HomeBase, and for a hub's
own capabilities. Every capability has its own `connections` map because a
feature may work through one HomeBase and fail through another. List each model
explicitly rather than assuming an untested future HomeBase will behave the
same way. The device's overall connection list is derived from those capability
maps, so do not repeat it at the top of the file.

Always quote human-facing labels under `values`. This keeps formatting
consistent and prevents YAML from interpreting labels such as `On`, `Off`,
`Yes`, or `No` as another data type.

For a command that accepts a numeric range, describe its argument under
`write.input` with a name, type, minimum, and maximum. Do not leave the range
only in prose.

Use numeric `write.command` when the command identifier is known. Use a
plain-language `write.action` such as `lock`, `unlock`, or `verify_pin` when the
device action is known but a safe numeric identifier is not. Never invent a
command number to satisfy the schema.

Use `requires_parameter` when the device must report a capability parameter
before a control can be exposed. A non-numeric cloud field belongs under
`read.field` instead of `read.parameter`.

## Evidence boundary

Each capability records one support level for every listed connection:

- `tested` means the capability was confirmed on real hardware through this
  gateway.
- `reported` means a user supplied the result but it has not been reproduced.
- `mixed` means different real-world reports disagree for that connection.
- `declared` means device data says the capability exists.
- `failing` means the capability was attempted through that connection and is
  currently not working.
- `unsupported` means that connection is known not to offer the capability.
- `unknown` keeps an unconfirmed research lead visible.

A real-world result may include `tested_on` and `tested_by`, including results
reported by another user. Store `tested_by` as the contributor's GitHub
username without the leading `@`.

Runtime code may consume only capabilities marked `tested`. Other levels remain
research until they are confirmed.

Admission is intentionally reviewed rather than inferred from catalogue
identity alone. A `ready_to_test` promotion should have a known reporter who can
check discovery, events, snapshots, and live view on the stated connection.
Home Assistant's **Download diagnostics** action exports the gateway's
privacy-safe catalogue evidence for that report. Apply the reporter's results
to each exact capability and connection instead of promoting every declaration
for the device at once.

Do not record reference implementation names, repository locations, source
excerpts, or cross-references here. Convert useful findings into neutral device
facts and retain only the support level needed to judge them safely.

## Adding a device

### Review the evidence before choosing an integration status

1. Run `npm run catalogue:query -- MODEL` from `eufy_event_gateway`. Use an
   existing record when the exact model and numeric type are already covered.
   Queries also match display names and aliases. For example, `S380` finds the
   `T8030` HomeBase.
2. Compare the exact model code, numeric inventory type, connection and
   capability with the closest implemented device. For a HomeBase route,
   identify the parent model as well. Keep the reference revision and evidence
   for event decoding, transport and real-device behaviour in the private
   investigation. Bring only the normalized device facts into the catalogue.
3. Choose the smallest change that fits the evidence.

| Evidence | Catalogue change | Verification |
| --- | --- | --- |
| An app definition declares a feature and the integration path is unverified. | Record it as `declared` on the connection it describes. Use `recognised` for a new diagnostic-only identity. | Verify that the generated record has no handler binding and the model stays out of Home Assistant. |
| The exact identity and route can use an implemented handler. | Use `ready_to_test` for the reviewed handler. Add an explicit event profile only when that existing profile fits. | Exercise an exact match, a near match and an unsupported or unresolved connection. Arrange focused real-device confirmation. |
| The device requires a different decoder, command or route. | Record the known identity and evidence. Identify the missing behaviour in the investigation. | Qualify the missing implementation in a separate change with a focused fixture. Treat capability and connection evidence independently. |

Review shared numeric types before adding a record. Some camera admission still
uses numeric type, so a `recognised` row alone may leave an existing type-wide
handler available. If the new model can reach that handler unexpectedly, review
the exact model/type admission rule before claiming diagnostic-only behaviour.

### Example 1 · A recognised camera with declared motion

Try this with a synthetic model in a disposable checkout. From
`eufy_event_gateway`, scaffold its YAML file.

```sh
npm run catalogue:new -- T9599 "Synthetic camera"
```

In `device_catalogue/devices/t9599-synthetic-camera.yaml`, retain
`integration.status: recognised`, set `device_type: 9599` and replace the
empty capabilities map with these declaration facts.

```yaml
capabilities:
  events:
    motion:
      connections:
        direct:
          status: declared
```

Generate the runtime data, validate the catalogue and query the record.

```sh
npm run catalogue:generate
npm run catalogue:check
npm run catalogue:query -- T9599 motion
```

Expect a recognised device, a direct motion declaration and no camera handler or
event profile. The synthetic regression below exercises that inventory row and
verifies that it does not enter the camera integration.

### Example 2 · Reuse a reviewed direct event profile

Query the standalone 4G LTE Cam S330 to see the existing binding.

```sh
npm run catalogue:query -- T86P2
```

An exact compatible camera can select the same handler through this integration
block after review of its identity, route and event behaviour.

```yaml
integration:
  status: ready_to_test
  handler: camera
  event_profile:
    id: motion-person-pet-vehicle-sound
    connection: direct
```

In the disposable checkout, apply that block to the synthetic record and
regenerate and check the catalogue again. The test below runs both versions of
the record against the real generator and capability selector in a temporary
copy.

```sh
node --import tsx --test test/catalogue-event-profiles.test.ts
```

The exact primary model and type on the direct route select motion, person,
pet, vehicle and sound. An alias, alternate numeric type, attached route or
unresolved route leaves this profile unapplied. The test leaves motion evidence
at `declared`. For a real device, update the evidence entry when that event is
observed on its exact connection. Video, pictures, audio and controls each
require their own evidence.

Before submitting a real record, review the YAML beside its generated diff.
Keep serials, account details, configured names, credentials, raw captures and
vendor definitions out of Git. Exclude the synthetic example from the shipped
catalogue.

## Supporting files

- `DEVICE_TEMPLATE.yaml` is the commented starting point for contributors.
- `device.schema.json` describes the simplified YAML format.
- `property-reference.json` is the legacy cross-device property glossary.
- `unmapped-device-types.json` records known numeric types without a confirmed
  retail model.

The device files are the maintained source. Contributors should update them
directly instead of importing private research material into the repository.
