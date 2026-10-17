# S120 light test through HomeBase 3

This default-off diagnostic is for model T81A0, device type 10005, connected to HomeBase 3 (T8030). Other S120 model names and connections are not admitted by this test. It needs an owner account, a unique camera channel and an available local connection.

The native app selects a different command for this attached connection. The gateway implements its integer On/Off request using its existing encrypted HomeBase control envelope. The precise wire layout, encryption selection and physical effect still need hardware confirmation. A successful reply acknowledges receipt. It does not prove the light changed.

1. Note whether the light is on or off before starting. Close live viewers for this HomeBase.
2. Enable **Experimental model controls** in the app options.
3. Open gateway **Diagnostics**, enter the API token, load devices and select the T81A0.
4. Open **Experimental model controls** and choose **Check available controls**.
5. Choose **Manual light (S120 through HomeBase 3)**, read and tick the observation/restore consent, choose **On** or **Off**, then choose **Try once**.
6. Watch whether the light changes. Restore its starting state afterward, using the Eufy app if necessary.

The gateway sends once and waits up to ten seconds for an authenticated, matching acknowledgement. No reply, a failed reply or a cancelled connection leaves the actual light state unknown. Check the light and restore it before trying again. The complete operation has a one-minute deadline and reserves the HomeBase against competing local controls or streams.

This is a momentary light action, like the existing manual movement test. It does not change alarm, privacy, motion-detection or recording settings. It does not read or publish a confirmed light state, and adds no normal Home Assistant light control. Nothing runs automatically or during gateway startup.

Share only whether On and Off worked and the complete `model_control_trial_failed` line if a test failed. Keep device names, serials, account details, tokens and raw messages private.
