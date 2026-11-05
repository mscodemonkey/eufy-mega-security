# T8910 local motion test

This default-off diagnostic listens for local motion timestamps from one T8910 sensor, device type 10, through HomeBase 2 (T8010) or HomeBase 3 (T8030). It is implemented for testing. Delivery on hardware, including when phone notifications are already off, remains unconfirmed. It does not yet publish these readings as Home Assistant motion events.

Use your existing configuration. Do not disable alerts, change recording settings, arm or disarm your system for this test. Close live viewers first. The gateway checks cloud device information and may contact Eufy to find the HomeBase. Opening the connection may compete with the Eufy app's connection.

1. Enable **Experimental model controls** in the app options.
2. Open the gateway **Diagnostics** page, enter its API token and load devices.
3. Select one T8910 and open **Experimental T8910 local motion test**.
4. Read and tick the consent box, then choose **Listen for local motion**.
5. Walk past the sensor during the 45-second listening period. Share only the displayed summary. If it fails, share only the complete `local_motion_trial_failed` log line.

The gateway makes no sensor, alarm, push-notification or recording setting writes. It uses a dedicated passive connection and rejects competing HomeBase controls, reads and streams. It compares fresh cloud bindings around the observation and requires the child and parent to have the same nonempty, unchanged owner value. This does not independently prove that value is the authenticated account identity.

Only timestamps newer than the listening period, received within one minute and no more than two seconds into the future, can count. Repeated, conflicting or older timestamps are ignored. A clock difference can make genuine motion inconclusive. Counts are capped at 16. A clean result with no observations is inconclusive, and a failed or interrupted connection discards all counts.

The summary excludes device identities, account details, timestamps and raw messages. Keep tokens, names, serials and raw payloads private. Cancel, changing the selected device or leaving the page stops the test. There is a ten-second cooldown per HomeBase after each admitted attempt. Nothing runs automatically at startup.
