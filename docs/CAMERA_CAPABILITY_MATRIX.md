# Camera capability lookup

The Mega gateway evaluates each discovered camera before Home Assistant creates entities. The published lookup is deliberately small. It contains the camera media and push paths we already handle, plus four battery readings that inventory may identify.

The core lookup is [`camera-capability-core.ts`](../eufy_event_gateway/src/provider/camera-capability-core.ts). It has 11 rows: retained and fresh images, live video, clip retrieval, motion and person events, battery level, charging, health, and temperature. The gateway validates the four battery values from Mega inventory and refreshes them every 60 seconds. Home Assistant creates an entity only when that camera reports the matching parameter. Known mains models that report a dummy battery level are suppressed.

The authenticated `GET /api/camera-capabilities` endpoint returns only these core rows. Each row separates device evidence from gateway support and says whether the feature is offerable. Startup writes a grouped `camera_capability_group` diagnostic with the admission decision, HA adapter, peer-route readiness, admitted media support, battery-read status, reported core reads, reads not yet implemented, and gateway-offerable paths. It omits serial numbers, names, raw parameter values, and push payloads.

Battery-history parameter 3100 remains diagnostic-only because its JSON fields are not yet verified. A live PPCS camera-info response is reduced to bounded field names and structural types in the stream outcome log; the raw JSON and all values are discarded. This probe must be compared with the device's Eufy-app reading before any Home Assistant entity is defined.

Unknown device types remain outside the camera admission list. A device must report both cover-image and video-specific inventory evidence, have a ready peer route, and not be a known accessory or station before the gateway flags it for review. This is only a diagnostic candidate, not automatic entity registration.

The gateway will add further camera features one at a time after checking its own protocol path, current-value freshness where needed, and real-device behaviour. [Sensors, HomeBases, and doorbells](DEVICE_CAPABILITY_BASELINES.md) have separate core decisions.
