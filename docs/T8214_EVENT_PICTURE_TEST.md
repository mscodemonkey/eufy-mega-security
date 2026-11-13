# E340 event-picture recovery trial

This disabled-by-default trial is for the E340 doorbell, exact model T8214 and
type 94, attached to HomeBase 3 T8030. It does not cover standalone doorbells,
other HomeBase generations or other E340 routes. Physical picture recovery on
this camera is unconfirmed.

Enable `experimental_homebase_event_images` in the gateway app options. Keep the
same account and normal camera settings. Allow an ordinary future press or person
event to arrive. There is no need to arrange another visit or repeat a capture.

A notification without a picture URL can now try to recover that event's saved
thumbnail. The request still needs its exact event ID and recording reference.
It reads one history page and at most one matching image. It will not interrupt
another live view or recording retrieval, search nearby visits, or use an image
from another camera. Detections continue even when recovery fails.

Check whether **Last Event Image** updates for that event while the doorbell is
idle. Opening live video updates a different retained image and does not confirm
this result. If the event picture remains missing, send only the complete
`push_snapshot_recovery_unavailable` line. Do not send images, private paths or
raw notification data. If the trial does not help, turn the option off again.
