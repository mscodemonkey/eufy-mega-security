# HomeBase 2 volume trial

The exact HomeBase 2 T8010/type 0 has opt-in alarm-volume and spoken-prompt-volume candidates. Enable experimental model controls in the gateway options to use this trial. Each number appears only when its own local value is reported. A known prompt volume never supplies a missing alarm volume.

API authentication and an owner or explicit administrator account are required. The gateway checks fresh account membership, reads the current local value, sends the absolute command once and requires a matching fresh local readback. Values range from 1 to 26. Close live views sharing the HomeBase before changing a trial volume.

The numbers are labelled experimental in Home Assistant and retain the standard station volume identities. Other managed HomeBase commands are unchanged. Missing values, guest permissions, account changes and an unknown command result withdraw the affected control. An uncertain write is not repeated automatically.

Before a voluntary test, note the original Eufy app volume. Change one step, independently check the result, then restore the original value and check again. Physical behaviour is unconfirmed. This trial does not start a siren or supply missing alarm-state feedback.
