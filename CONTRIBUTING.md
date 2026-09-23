# Contributing to Eufy Mega Security

Thanks for taking an interest in the project. The useful contributions here are practical ones: a protocol observation backed by a capture or test, a small fix with a regression test, or documentation that saves the next person an evening of guessing.

## Start with the boundary

If this is your first day on the project, read [Developers start here](docs/DEVELOPERS_START_HERE.md) before changing protocol or entity code. It defines Mega, PPCS, the data transformations, and the reason the repository is split into a gateway and a Home Assistant integration.

The repository contains two cooperating pieces:

- `eufy_event_gateway` is the Eufy client and media gateway. It owns Mega authentication, device discovery, push events, snapshots, and native camera transport.
- `custom_components/eufy_event_gateway` is the Home Assistant integration. It talks to the gateway's authenticated HTTP and SSE API and turns the returned state into entities.

Keep Eufy protocol work in the gateway. The Home Assistant integration should not contain Eufy credentials, Eufy cryptography, device polling logic, or a second copy of the camera protocol.

The gateway deliberately does not use `eufy-security-client`, the SmartLife/Thing login, or the expiring Web Portal Access PIN. Please do not add any of those back as a shortcut. If a camera or account path is missing, document the missing protocol step and add a focused test or probe result.

## Device capability data

The detailed device reference is in
`eufy_event_gateway/device_catalogue/devices/`, with one YAML file per device or
hardware variant. Update the matching file when you confirm a property, command,
selectable value, or app label. Keep declarations, inferences, and hardware
results separate in the evidence fields.

Use `recognised` for diagnostic-only knowledge, `ready_to_test` only when an
implemented family handler can safely admit the device, and `supported` after
working integration behaviour is confirmed. Run `npm run catalogue:generate`
after editing a record, then `npm run catalogue:check` before submitting the
change. You can locate a device with `npm run catalogue:query -- T817L`.

## Local setup

The gateway requires Node.js 24 or newer. Install its dependencies from the gateway directory:

```sh
cd eufy_event_gateway
npm ci
```

FFmpeg is needed for live H.264 to JPEG extraction and MP4 recording. The CI job installs it with the system package manager. On macOS, install it with Homebrew if it is not already available:

```sh
brew install ffmpeg
```

Copy `.env.example` to a private local file or export the variables in your shell. Never commit `.env`, account passwords, session files, API tokens, verification codes, CAPTCHA answers, or raw Eufy payloads. A real account is not needed for most work:

```sh
cd eufy_event_gateway
EUFY_GATEWAY_PROVIDER=simulated npm run dev
```

The simulated provider gives the HTTP API, SSE events, entity state, and stream lifecycle a deterministic local source.

## Translating the Home Assistant integration

Human-edited translations live in
`custom_components/eufy_event_gateway/translation_sources/`. Home Assistant's
required JSON files are generated from them. To add a language:

1. Copy `en.yaml` to a file named with the language's BCP 47 code. For
   example, Danish is `da.yaml` and Dutch is `nl.yaml`.
2. Translate only the text values. Keep every YAML key and placeholders such
   as `{medium}` unchanged.
3. Run `cd eufy_event_gateway && npm run translations:generate`.
4. Commit the YAML source and generated JSON file, then open a pull request.

Please translate the wording naturally rather than word for word. Home
Assistant uses the server's configured language when it creates entity names,
so existing entities may retain their previous names until Home Assistant
recreates them.

## Checks before opening a pull request

Run the same gateway checks used by GitHub Actions:

```sh
cd eufy_event_gateway
npm run check
npm run build
```

At the repository root, also run:

```sh
git diff --check
```

The workflow also runs HACS validation and Home Assistant's `hassfest` checks. If a change touches `manifest.json`, translations, config flow metadata, or entity definitions, run those checks in CI and fix their feedback before asking for review.

## Working on a real Eufy camera

Use a separate guest account shared with only the cameras needed for the test. The gateway stores its Mega session under its private data directory. The PPCS proof-of-concept can enumerate the account and write a raw H.264 file plus a first-frame JPEG:

```sh
cd eufy_event_gateway
npm run poc:ppcs
```

The probe prints camera names, models, byte counts, and safe diagnostics. It intentionally omits credentials, tokens, signing keys, complete serial numbers, and raw protocol payloads. Treat a camera as stream-tested only when both H.264 and JPEG byte counts are non-zero. A battery camera that is asleep or out of charge is a hardware state, not evidence that the transport is broken. Record that distinction in an issue or test notes.

When Eufy asks for a CAPTCHA or an email verification code, use the gateway Web UI. The answer is held in memory and the resulting session is persisted. Do not put a challenge answer or code in a source file, issue, screenshot, or log attachment.

## Making changes

1. Create a branch from the current working branch. Do not develop on `main`.
2. Read the relevant source and tests before changing a protocol or entity contract.
3. Add or update a test with the change. Prefer a fixture that proves the smallest protocol or state transition involved.
4. Keep diagnostics safe. Redact serials when they are not needed to identify a test camera, and never print secrets.
5. Update the README, file map, or project memory when a user-visible behaviour or architecture boundary changes.
6. Run the local checks above and include the result in the pull request.

Protocol code should explain the packet layout, byte order, encryption boundary, and the reason for any magic number. State code should explain ownership and lifecycle. A short comment that says why a field exists is more useful than a comment that repeats its name.

## Pull request notes

Please include:

- what changed and why;
- which checks ran;
- whether a real Eufy account or camera was used;
- the camera model and power state, without posting account details or full device identifiers;
- screenshots or redacted logs only when they make a UI or protocol result easier to verify.

If a change is still exploratory, say so. A failed camera probe is useful evidence when the failure is described precisely and the camera's battery or network state is known.

## Releases

Only maintainers should cut a release. A release updates the gateway package, app manifest, Home Assistant manifest, repository changelog, and `eufy_event_gateway/CHANGELOG.md` together, then tags the commit with the same version. `npm run release:check` enforces matching public versions and requires the current version heading in both changelogs. The HACS integration and the Home Assistant app are published from the same repository, but they are installed and updated separately. Do not claim a release is available until the tag and both published artifacts have been checked.

## Where to look first

The [file map](docs/FILE_MAP.md) describes each source file and the direction of dependencies. The checked-in [project memory](docs/project-memory/README.md) records the current protocol boundary and delivery state. Read both before proposing a large change.
