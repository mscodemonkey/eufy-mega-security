# Security policy

## Reporting a problem

Please do not open a public issue for a suspected credential leak, account takeover, authentication bypass, or private media exposure. Contact the maintainer privately through the GitHub profile for `mscodemonkey` and include a short description, affected version, reproduction steps, and the minimum redacted evidence needed to investigate.

Remove passwords, access tokens, session files, verification codes, CAPTCHA answers, signing keys, media URLs, and full device identifiers from the report. If a log or packet capture is necessary, redact those values before sending it.

## Handling secrets while developing

Keep Eufy credentials in environment variables or Home Assistant's private app configuration. Do not commit `.env`, the app data directory, Mega session files, generated API tokens, or raw camera media. The gateway's diagnostics are designed to report counts and state without printing authentication material. Preserve that rule when adding a new diagnostic field.

## Supported versions

The latest tagged release receives security fixes. Older versions may continue to work with Eufy's services, but they are not a supported place to report a security issue. Upgrade to the latest release before investigating a suspected fix unless upgrading would destroy evidence needed for the report.
