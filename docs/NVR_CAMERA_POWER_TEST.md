# NVR camera-power test

This optional test is limited to a T8E00 camera, type 301, connected to an NVR S4
T8N00, type 300. It temporarily changes the camera's power/privacy state and
attempts to restore its original state. Normal Home Assistant controls and NVR
guard modes remain unavailable.

Hardware behaviour in this gateway is unconfirmed. Turning the camera off can
interrupt recording and notifications. Only test while you can observe the
camera and restore it in the Eufy app if needed. A connection failure or gateway
restart can prevent automatic restoration.

1. Update the app and integration to the release containing this test.
2. Enable **Experimental NVR video**, **Experimental model controls** and the
   separate **Experimental NVR camera-power test** option. The last option is
   off by default.
3. Close all viewers for cameras sharing the NVR.
4. Check the camera's existing power/privacy state in Eufy and record it.
5. Open Diagnostics, load devices and select the T8E00 camera.
6. Open **Experimental NVR camera-power test**. Choose your recorded original
   and the temporary state you want to test, then confirm the observation consent.
7. Choose **Test and restore camera power**. Watch the camera throughout.
8. Check that the physical camera and Eufy both return to the original state.
   Restore it manually in Eufy if necessary, even if a displayed result says it
   was restored.

The test takes up to two minutes. It checks the original against a fresh device
reading before changing anything. A mismatch stops the test. It sends the
selected change once and checks a new reading, then attempts restoration.
A failed restoration is reported as needing a manual check.

**Cancel and request restoration** starts recovery rather than immediately
closing the connection. Leaving the page also requests recovery. Neither can
show the eventual result after the browser disconnects. Check the camera against
the original you recorded and restore it manually if needed. A gateway crash or
restart cannot guarantee recovery, and the next start does not replay writes.

Share only the displayed summary and whether the temporary state and restoration
matched what you observed. If it fails, share only the complete
`nvr_power_trial_failed` line. Keep device identifiers, configuration, accounts
and diagnostic bundles private.

This test requires the authenticated owner, an unchanged device connection and
an idle NVR. It refuses competing local operations and has a one-minute cooldown
after an attempted change. It uses cloud inventory and a private NVR connection.
A cloud outage during recovery can use the same verified connection, but a known
change in ownership or device binding prevents further writes.

The on/off mapping is hardware-unconfirmed for this exact admitted camera. A wrong
mapping can leave it off despite restoration attempts, so keep observing and
verify the original manually. A browser or proxy timeout requests recovery but
cannot display the eventual result. Both restore attempts share a 60-second
budget, which may expire before both finish. The parent cooldown is in memory
and resets on gateway restart. Restart, shutdown or lost transport can prevent
restoration, and startup never replays writes.
