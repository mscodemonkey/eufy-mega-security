# Cloud calendar hints

The default-off cloud recording diagnostic includes a **Load month** button.
Select a camera and a date, then choose **Load month** in gateway Diagnostics.
The API token and `experimental_cloud_recordings` option are required. This
metadata check does not download footage or change any recording settings.

The dates are availability hints. They do not prove that a particular recording
belongs to the selected camera, that its thumbnail can be downloaded, or that
its video can be played. The endpoint and its per-camera filtering remain
unconfirmed on real accounts. Recording selection and playback perform their
own ownership checks. The existing day list and preview are described in
[the recording trial guide](CLOUD_RECORDING_TRIAL.md).

The calendar uses a fixed timezone offset for the month, taken from the browser's
first day of that month. Positive offsets mean seconds east of UTC. That sign
convention is inferred from the existing client. Month bounds are exclusive at
the next month's midnight, which is our convention rather than verified vendor
behaviour. In a month with a daylight saving change, calendar hints can differ
from the day list by up to an hour near a date boundary.

Only plain MP4 and the already supported v8 recording path have a preview.
Legacy v1 and v5 formats remain unsupported. They need a complete file traversal
and key contract plus a sanitized valid encrypted fixture before safe playback
can be implemented. A calendar marker does not change that limitation.

If you already have cloud recordings and choose to test this, compare the dates
with the Eufy app. Report whether the hints match, without sharing camera names,
recording identifiers, picture links or footage. A successful automated test is
not real-account confirmation.
