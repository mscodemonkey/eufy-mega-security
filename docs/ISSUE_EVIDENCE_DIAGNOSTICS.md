# Evidence diagnostics for custom modes and stream startup

These diagnostics help investigate issues #288 and #204. They do not change
security-mode selection, command routing, packet acceptance, or stream recovery.
They require an app build containing this change. They are not a hardware fix.

## Custom guard modes

`guard_mode_metadata_observed` is emitted for station inventory rows containing
custom-mode metadata. The existing inventory summary is unchanged. `structure`
preserves nesting and repeated text relationships with document-local `textN`
and `fieldN` aliases. Labels, arbitrary keys and arbitrary numeric identifiers
are not retained. Only known field names and mode IDs 0 through 5 survive.
Aliases restart for each document and cannot identify an app label independently.

Input is limited to 16,384 characters. Traversal permits 16 entries per container,
128 nodes and container depth 4. Explicit `capped:entries`, `capped:nodes`,
`capped:depth` and `capped:length` markers identify incomplete evidence. Output
is limited to 2,048 characters. This is diagnostic evidence, not authorization
for a mode write. App labels still require an explicit reporter comparison.

## Stream sequence evidence

Existing stream outcome lines gain `sequence_channels` when session statistics
provide it. Each channel reports received (`rx`), accepted (`ac`) and stale (`st`)
first-last sequence values and counts. Received values include repeated and held
arrivals. Accepted values follow actual delivery order. `behind` gives the
minimum and maximum modular distance behind the last accepted value. `run`
gives the longest forward stale run and the longest consecutive stale run.
Non-stale arrivals break runs. Missing ranges use `---`. At most eight channels
are included, sorted by type, with an omitted-channel count when necessary.

Only unsigned sequence values and channel types enter this diagnostic. Invalid
inputs keep the existing packet-processing behavior. No packet payload, address,
identity or key is added. Statistics remain readable after session shutdown.
The existing logger's overall line limit still applies to outcome lines.

A short backward run may be a numbering reset or delayed data. These counters
provide evidence to distinguish hypotheses but do not prove either one. Packet
acceptance and recovery thresholds remain unchanged until hardware evidence
supports a specific correction.
