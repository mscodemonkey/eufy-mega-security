# Experimental T8172 event-picture request

This disabled-by-default option tests an Android-derived request hypothesis for issue #325. It applies only to authenticated T8172 devices, type 89, in the security category. It changes requests for pictures from existing events. It does not create events, add a new picture address, provide local picture retrieval or reproduce the iPhone's request.

## Before choosing the test

Enable **Experimental T8172 event picture request test** only if you want to compare one fresh known event. Pictures may stop while enabled. Disable that option and restart to restore the ordinary request style.

The Android picture loader omits the gateway's account headers on its initial picture GET. This test does the same. Runtime default HTTP headers still exist. The gateway already omits account headers after a redirect, including the failed final download hop in the report, so an unchanged redirect failure would not support this hypothesis. There is no physical-device proof that the test will help.

Authentication, URL restrictions, a single redirect, download size, request cancellation and the existing five-attempt 404 schedule remain enforced. There is no authenticated fallback from the experimental request.

## Interpret one fresh result

| Observation | Meaning |
| --- | --- |
| `push_snapshot_retained` with `request_style=native`, and the new picture appears | The selected request path retained a picture for that event. |
| `push_snapshot_unavailable` with `request_style=native`, showing hop 1 and HTTP 401 or 403 | The initial hop rejected this request style. |
| The same redirect hop still returns HTTP 404 | This result does not support the request-header hypothesis. |
| No marker or suffix | The experimental gate may not have matched, or there may have been no usable new event-picture request. This alone is not a successful comparison. |

Share only whether the fresh picture appeared and the matching `push_snapshot_unavailable` line on failure, with any account details removed. Never post raw image addresses, pictures, device identifiers or full captures publicly. A retained picture proves that event's request worked, not every future event.

The reporter may also be asked whether **Settings > Security > Local Advanced Encryption** is enabled. Its status is a separate diagnostic question. Do not change it for this experiment. Encryption has not been established as the cause of the reported 404.
