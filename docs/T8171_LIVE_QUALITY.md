# Attached T8171 live quality

An experimental streaming-quality select is available for an exact T8171
(device type 88) attached to a T8030 HomeBase 3 (type 18). Enable
**Experimental model controls**, then enable the camera's disabled-by-default
**Streaming quality (experimental)** entity in Home Assistant. The gateway
requires API authentication and either the owner's Eufy account or an explicitly
verified shared membership for both the camera and HomeBase. Unknown memberships
remain unavailable.

Open the camera's live view in Home Assistant before choosing Auto, HD (720P),
Full HD (1080P) or 2K. The control uses that existing connection. It does not
start a separate viewer or change recorded-video quality. Other HomeBase
operations can temporarily make it unavailable.

The choice applies to the current live connection. It becomes unknown when
that connection ends, including an automatic reconnect. The select remains
unavailable until a new live connection has produced video. It does not restore
an old choice automatically or claim that the camera saved it permanently.

The reported choice means the camera returned the matching live-quality reply.
It is not a measurement of the displayed resolution. Auto can change resolution
while streaming. The attached camera's older cloud quality value is deliberately
not used to confirm this control.

Native reference testing decoded 720P at 1280 by 720. After restoring Auto, the
same source adapted between 1280 by 720, 1920 by 1080 and 2560 by 1440. These
observations qualify that reference stream only. Other firmware and routes
remain unconfirmed.
