# C31 continuous-recording preview

This experimental preview retrieves ten seconds of existing continuous footage
from a standalone C31 (T817L, device type 10031). It is separate from event-clip
history and does not change the camera's recording settings.

Enable **Experimental model controls** in the app options. In Diagnostics,
select the C31, open **Experimental C31 continuous-recording preview**, and
choose a time with continuous footage from the last twenty-four hours. The time
uses your browser's local timezone. Close other live viewers, agree to retrieve
private footage, then choose **Load ten-second preview**. Use the resulting
player to watch or seek within the retrieved clip. Cancel, changing the selected
camera or leaving the page retires the request and discards its local preview.

The entire ten seconds must be inside one current recording interval. A missing,
ambiguous or changed interval is refused. The gateway checks account ownership
and the camera connection around retrieval. It stops camera playback before
packaging the preview and verifies that every included track fully decodes.

The preview is off by default and requires authentication plus explicit private
media consent for each request. It does not provide an always-running recording
stream, enable continuous recording, edit schedules or delete footage. The
resulting clip is private. Do not attach it or raw diagnostics to public issues.
On failure, share only the complete `continuous_recording_trial_failed` line.

The index query and official-app continuous playback have been verified on one
local C31. EMS playback verification is recorded separately from those results.
