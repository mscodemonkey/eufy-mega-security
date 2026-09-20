# Eufy Mega Security

This app runs the local Eufy gateway beside Home Assistant. It signs in through Eufy's current Mega service, receives Eufy and HomeBase events continuously, and retains the last useful camera image.

## Configuration

- **Username**: the dedicated guest Eufy account shared with the required cameras.
- **Password**: that account's Eufy password.
- **Country**: the two-letter Eufy account country, such as `AU`.
- **Native camera transport**: live-view work uses the gateway-owned Mega/PPCS UDP path and does not use the separate SmartLife/Thing login or an expiring Web Portal Access PIN.
- **Verification code**: this field is always visible. Leave it empty unless Eufy requests an emailed code, then enter the code, restart once, and remove it after the app connects.

The app generates its own API token on first start and sends the private connection details to the integration through Supervisor discovery. The gateway port is not exposed to the LAN and no token needs to be copied or entered manually.

The app uses Home Assistant's host network so its local-only Eufy PPCS transport can discover a HomeBase or camera through UDP broadcast on the LAN. This access does not expose the gateway port unless you explicitly configure the optional port mapping.

The app stores its authenticated Eufy session and retained snapshots in its private `/data` volume so they survive restarts and are included in Home Assistant backups.

After the first successful discovery, the app captures one snapshot from each camera that does not already have a retained image. It handles cameras sequentially so startup does not open every live connection at once. A sleeping camera may remain blank until an event or manual stream supplies an image, but it does not block the remaining cameras.

After the app starts, open **Settings > Devices & services**. Home Assistant should show a discovered **Eufy Mega Security** integration. Select **Configure** to create its camera, detection, and HomeBase entities. The HomeBase device includes a code-free alarm panel, configured and effective guard modes, current siren state, PPCS connection diagnostics, separate eMMC and HDD or SSD storage sensors, volume controls, and alarm tone.

HomeBase commands are not optimistic. The app sends each command once, waits for its acknowledgement, and reads the device again before Home Assistant shows the new value. A HomeBase security command stops camera media using the same station before it runs. HomeBase and camera sirens expose bounded trigger and explicit stop controls when their command capability is reported.

Mega events and native camera transport use the gateway's Mega session. If Eufy requests a CAPTCHA or sends an email code, open the app's **Web UI** and complete the prompt. The authenticated session persists in the app's private data volume, so routine upgrades and restarts do not repeat the challenge.

The gateway-only PPCS probe has produced real H.264 and JPEG bytes for the test account's wired T8210 and USB-C-powered T817L. In v0.1.14, the companion integration exposes that transport through live camera views plus `capture_snapshot` and `record_clip`. A battery camera that is asleep or out of charge can complete the handshake without sending video; record its power state before treating that result as a software failure.
