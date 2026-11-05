# Experimental T8170 alarm-state read

This optional Diagnostics test is for an exact standalone T8170, device type 48, channel zero, on its authenticated owner account. It needs API authentication and experimental model controls enabled. The gateway must already hold a current connection key. Listing the action never fetches a key or opens a session.

## What the experiment does

Choose **Read alarm state (experimental)**, read the consent and choose **Read only**. It opens one exclusive control session and waits for key preparation before sending one clear C31-style camera-info query. It sends no arm, disarm, siren, media or setting-write command. The camera's reaction to this query is unconfirmed. This is a hypothesis to test, not established T8170 support.

The session has a 40-second maximum after connection. Closing the browser does not cancel its ownership. Wait for completion before starting another device operation. Shutdown closes it. There is no automatic retry or alternative query.

## Reading the result

- **Decoded** reports a count of distinct parameter types and, when strictly valid, a numeric guard mode. The guard-mode mapping is unconfirmed. A decoded document is uncorrelated and does not prove it answered this query.
- **Timeout** is inconclusive. The query may have reached the camera without a usable reply.
- **Unavailable**, with `keyReady: false`, means the query was not sent and this hypothesis was not tested.
- **Unavailable**, with `keyReady: true`, is inconclusive. The query may or may not have been sent before the session ended.

The read never publishes an arming state to Home Assistant or updates normal camera state. Connection negotiation alone does not establish a successful alarm-state read.

## Private comparison

Read the current state in the Eufy app without changing it. Do not arm or disarm the household for this test. If you choose to test, send only the outcome, parameter count, numeric guard mode if shown, and current app state through the configured private project mailbox or another agreed private channel. These reveal household security state, so do not put them in a public issue. Do not send identifiers, full logs or account details.
