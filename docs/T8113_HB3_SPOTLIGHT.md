# eufyCam 2C spotlight through HomeBase 3

The experimental standard HA light is limited to T8113-Z/type 8 attached to
T8030/type 18. HomeBase 2 and other models are excluded. Enable gateway
experimental model controls and then the disabled Spotlight (experimental)
entity. Current account membership, the exact child and parent relationship,
an API token and a readable baseline are checked before dispatch.

This camera rejected manual light commands from idle in the observed tests.
Commands worked with the official viewer open and with HA's own decoded live
source. Both directions through the actual HA light entity have physical
confirmation. The corrected receiver recognises the observed encrypted light
state instead of treating successful writes as unknown.

The new idle-start candidate uses the media manager's shared source ownership.
On starts or joins live video, waits for a fresh decoded image, sends one absolute
light command and retains its media lease after confirmation. Off sends one
absolute command and releases only that lease. Other viewers keep their source.
The existing maximum stream lifetime still applies. Expiry clears the retained
light state, and a new absolute request can recover from unknown state.
Startup cancellation removes its own waiter. A failed or unconfirmed write
releases the light's lease without replaying the command.

The light went off after the controlled viewer retired, with no off command sent.
That observation does not establish the firmware's internal timeout or promise
unlimited illumination. This control does not change motion lighting, brightness,
recording preferences or night-vision policy.

The new automatic idle-start and retained-source lifecycle still need their
installed HA and physical test. Earlier warm-viewer confirmation does not
qualify that new lifecycle. Keep the PR in draft until that test is complete.
