# Retired T8172 event-picture request test

The headerless request experiment has been retired. Comparison with the retained
Eufy app showed that its HTTP picture loaders attach account authentication.
The earlier statement that the Android loader omits those headers was incorrect.

Pictures now always use the normal authenticated request, including when the
old option remains enabled in saved settings. The option is accepted for
compatibility and has no effect. `event_image_trial_retired` explains this at
startup when the saved option is enabled.

An initial HTTP 401 from the old experiment does not establish that an event
has no image. Its result also does not explain the intermittent object-store
404 reports. Those picture failures remain unresolved. There is no useful
reason to repeat the retired test or change encryption settings.

If a normal event picture still fails, the useful diagnostic is the matching
`push_snapshot_unavailable` line. Current results identify the request as
`request_style=authenticated`. A retained picture confirms that event only.
Never post raw picture addresses, images, device identifiers or captures publicly.
