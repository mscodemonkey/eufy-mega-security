# S120 light test through HomeBase 3

This default-off experiment is for model T81A0, device type 10005, connected to HomeBase 3 (T8030). Other S120 model names and connections are not admitted by this test. It needs an owner account, a unique camera channel and an available local connection.

The native app selects a different command for this attached connection. The gateway implements its integer On/Off request using its existing encrypted HomeBase control envelope. The precise wire layout, encryption selection and physical effect still need hardware confirmation. A successful reply acknowledges receipt. It does not prove the light changed.

1. Note whether the light is on or off before starting. Close live viewers for this HomeBase.
2. Enable **Experimental model controls** in the app options.
3. On the S120's normal Home Assistant device page, enable **Turn camera light on (experimental)** and **Turn camera light off (experimental)**. Both buttons start disabled.
4. Press the opposite-state button once while watching the light.
5. Restore its starting state afterward, using the Eufy app if necessary.

No separate Diagnostics page or observation checkbox is needed. The equivalent
manual-light test remains available in Diagnostics for investigating a failure.
The buttons do not publish an on/off state.

The gateway sends once and waits up to ten seconds for an authenticated, matching acknowledgement. No reply, a failed reply or a cancelled connection leaves the actual light state unknown. Check the light and restore it before trying again. The complete operation has a one-minute deadline and reserves the HomeBase against competing local controls or streams.

This is a momentary light action, like the existing manual movement test. It does not change alarm, privacy, motion-detection or recording settings. It does not read or publish a confirmed light state, and does not create a stateful Home Assistant light entity. Nothing runs automatically or during gateway startup.

Share only whether On and Off worked and the complete `model_control_trial_failed` line if a test failed. Keep device names, serials, account details, tokens and raw messages private.
