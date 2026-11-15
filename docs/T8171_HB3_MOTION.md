# T8171 motion detection through HomeBase 3

The T8171/type-88 motion switch has distinct standalone and attached routes.
The current model handler uses MotionDetectionStatusParser v1. Its HomeBase
branch sends command 1011 and reads parameter 1011. A standalone connection or
native outdoor-mode override selects 1700/6040 instead. Missing parameter 6271
means the override is off. An invalid or duplicated override is unqualified.

The attached implementation requires an exact T8030/type-18 parent, a distinct
parent identity, child channel 0 through 31, an owned ready route and known
motion state. It rejects the outdoor override. The standalone route continues
to use its native status envelope.

An attached request has a 136-byte clear body containing the child channel and
absolute state as little-endian 32-bit integers, followed by the existing account
field. The request uses the established level-two authenticated encryption.
One logical command is dispatched. The observed clear reply has 132 bytes,
with the result scalar first and an opaque tail. Accept it only for this exact
session profile, command, response flag and child channel. This reply is not
authenticated state evidence. The provider retires its connection and requires
fresh inventory confirmation. An unknown result never causes another write.

A native reference-app test on 15 November 2026 observed one off request and one
restoring on request through HomeBase 3, child channel 1. Each encrypted request
matched one captured packet. Independent authenticated decryption matched the
136-byte bodies. Both native replies contained result zero. Their identical
payloads prevent unique packet-to-reply assignment, which is retained as an
evidence limit. The app's property followed false then true, and reopening its
motion page showed on again. Capture ownership was released, Home restored and
the existing raw recorder session preserved. This does not prove new physical
motion notifications or every firmware and child channel.

Synthetic socket tests exercise the production handshake, exact wire layout,
wrong-channel and malformed replies, rejection, timeout and no replay. Provider
tests independently confirm parameter selection and fresh inventory after an
acknowledgement is missing. The installed gateway fingerprint and HA switch source matched. The actual
registered HA switch then reached off and on, with pending control settled and
fresh gateway confirmation for each. The original on baseline and entity
registry state were restored. The first immediate HA read ran before its queued
change completed and is retained as an unqualified check, not a device failure.
No physical motion trigger was part of this control test.
