# C31 live talkback implementation

This work adds an opt-in microphone path to the normal camera viewer. The
existing prepared-file speaker action remains separate. Default HLS cameras,
other models and their source ownership must retain their existing behaviour.

HA Core 2026.10 supports native WebRTC offers and candidates,
but has no two-way-audio camera capability or microphone button. Core 2026.11
adds that capability behind its Labs feature, with browser microphone access
requiring HTTPS. Older Core must still import and use this integration. A
separate camera subclass confines native WebRTC to the opted-in C31, avoiding
HA's class-level native-WebRTC detection on every other camera.

The gateway accepts only authenticated offers for the exact standalone C31,
from its owner or its signed-in type-1 member. Account and inventory bindings
are checked again while audio streams.
One WebRTC peer borrows the manager's normal video/audio source as a viewer.
Its encoder sends H.264 baseline video and PCMU audio through negotiated RTP.
Only negotiated PCMU microphone RTP enters a bounded pipe encoder. Native
AAC-LC 16 kHz mono frames stream through the existing C31 connection and its
1001/1002 speaker lifecycle. There is no host microphone device or persistent
audio file. Generated RTP is used for transport qualification.

The peer owns its encoder children, loopback RTP receivers, input queue and
finite camera lease. Each view is limited to 120 seconds and an uninterrupted
microphone segment to 90 seconds. Experimental video is H.264 baseline at up
to 720p and 10 frames per second. Normal HLS cameras are unchanged. Speaker cleanup must finish before releasing that lease.
Disconnects, gaps, failed encoding, buffer overflow and unsupported offers fail
closed without creating another camera connection or replaying a microphone
utterance. Existing viewers remain owned by their original consumers. Fixed
reason codes and counters explain the failed boundary without retaining speech.

Implementation and hardware qualification are in progress. No audible output,
real microphone result or normal HA microphone UI is claimed by this document.
