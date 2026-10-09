"""Browse gateway-owned event recordings and proxy prepared media through HA.

The media platform borrows loaded entry coordinators. The gateway owns camera
sessions, decryption and expiring video buffers. HA owns browser authentication
and signed playback URLs, keeping gateway tokens out of the browser.
"""

from __future__ import annotations

from datetime import date, timedelta
import re
from urllib.parse import quote

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.auth import async_sign_path
from homeassistant.components.media_player import BrowseError, MediaClass, MediaType
from homeassistant.components.media_source import (
    BrowseMediaSource, MediaSource, MediaSourceItem, PlayMedia,
)
from homeassistant.components.media_source.error import MediaSourceError, Unresolvable
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .client import GatewayClientError
from .const import DOMAIN


def _coordinator(hass: HomeAssistant, entry_id: str, serial: str):
    """Require current loaded inventory before accessing a saved recording."""
    entry = next(
        (entry for entry in hass.config_entries.async_loaded_entries(DOMAIN)
         if entry.entry_id == entry_id), None,
    )
    if entry is None:
        raise MediaSourceError("Recording integration is not loaded")
    coordinator = entry.runtime_data.coordinator
    camera = coordinator.cameras.get(serial)
    if not camera or camera.get("storedRecordingsSupported") is not True:
        raise MediaSourceError("Stored recordings are unavailable for this camera connection")
    return coordinator


def _parts(identifier: str) -> list[str]:
    """Validate browser references without accepting camera filesystem paths."""
    parts = identifier.split("/") if identifier else []
    if len(parts) not in (0, 2, 3, 4) or any(
        not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", part) for part in parts[:2]
    ):
        raise MediaSourceError("Invalid recording reference")
    if len(parts) >= 3:
        try:
            if date.fromisoformat(parts[2]).isoformat() != parts[2]:
                raise ValueError
        except ValueError as error:
            raise MediaSourceError("Invalid recording day") from error
    if len(parts) == 4 and not re.fullmatch(r"[a-f0-9]{64}", parts[3]):
        raise MediaSourceError("Invalid recording reference")
    return parts


async def async_get_media_source(hass: HomeAssistant) -> EufyRecordingSource:
    """Create the lazy media platform and register its authenticated proxy once."""
    marker = f"{DOMAIN}_recording_view_registered"
    if not hass.data.get(marker):
        hass.http.register_view(EufyRecordingView(hass))
        hass.data[marker] = True
    return EufyRecordingSource(hass)


class EufyRecordingSource(MediaSource):
    """Expose camera/day/clip folders for the lifetime of HA's media platform.

    Entry coordinators are borrowed on every access so unloading an entry or
    moving a camera removes access immediately. Only opaque clip IDs cross
    this boundary. Browsing never starts a live viewer or changes settings.
    """

    name = "Eufy recordings"

    def __init__(self, hass: HomeAssistant) -> None:
        """Borrow the HA instance while the gateway retains all media state."""
        super().__init__(DOMAIN)
        self.hass = hass

    async def async_browse_media(self, item: MediaSourceItem) -> BrowseMediaSource:
        """List folders and translate gateway failures into browser-visible errors."""
        try:
            return await self._browse_media(item)
        except MediaSourceError as error:
            raise BrowseError(str(error)) from error

    async def _browse_media(self, item: MediaSourceItem) -> BrowseMediaSource:
        """List eligible cameras, fourteen recent days, or a day's saved clips."""
        parts = _parts(item.identifier)
        children = []
        title = self.name
        if not parts:
            for entry in self.hass.config_entries.async_loaded_entries(DOMAIN):
                for serial, camera in entry.runtime_data.coordinator.cameras.items():
                    if camera.get("storedRecordingsSupported") is True:
                        children.append(self._folder(
                            f"{entry.entry_id}/{serial}", camera.get("name", "Camera"),
                        ))
        else:
            coordinator = _coordinator(self.hass, parts[0], parts[1])
            if len(parts) == 2:
                title = coordinator.cameras[parts[1]].get("name", "Camera")
                today = dt_util.now().date()
                for offset in range(14):
                    day = today - timedelta(days=offset)
                    children.append(self._folder(
                        f"{item.identifier}/{day.isoformat()}", day.strftime("%A %d %B"),
                    ))
            elif len(parts) == 3:
                title = parts[2]
                try:
                    records = await coordinator.client.stored_recordings(parts[1], parts[2])
                except GatewayClientError as error:
                    raise MediaSourceError(str(error)) from error
                for record in records:
                    start = dt_util.parse_datetime(record["startTime"])
                    if start is None:
                        raise MediaSourceError("Recording time was invalid")
                    children.append(BrowseMediaSource(
                        domain=DOMAIN, identifier=f"{item.identifier}/{record['id']}",
                        media_class=MediaClass.VIDEO, media_content_type="video/mp4",
                        title=dt_util.as_local(start).strftime("%H:%M:%S"),
                        can_play=True, can_expand=False,
                    ))
            else:
                raise MediaSourceError("A recording cannot be browsed as a folder")
        return self._folder(item.identifier, title, children)

    async def async_resolve_media(self, item: MediaSourceItem) -> PlayMedia:
        """Prepare verified MP4 bytes and grant a ten-minute HA playback URL."""
        try:
            parts = _parts(item.identifier)
            if len(parts) != 4:
                raise MediaSourceError("Choose a recording to play")
            coordinator = _coordinator(self.hass, parts[0], parts[1])
            await coordinator.client.prepare_recording(parts[1], parts[3])
            path = (f"/api/{DOMAIN}/recordings/{quote(parts[0], safe='')}/"
                    f"{quote(parts[1], safe='')}/{parts[3]}.mp4")
            return PlayMedia(
                async_sign_path(self.hass, path, timedelta(minutes=10)), "video/mp4",
            )
        except (GatewayClientError, MediaSourceError) as error:
            raise Unresolvable(str(error)) from error

    @staticmethod
    def _folder(identifier: str, title: str, children=None) -> BrowseMediaSource:
        """Build a non-playable media folder with an optional populated child list."""
        return BrowseMediaSource(
            domain=DOMAIN, identifier=identifier, title=title,
            media_class=MediaClass.DIRECTORY, media_content_type=MediaType.PLAYLIST,
            can_play=False, can_expand=True, children=children,
        )


class EufyRecordingView(HomeAssistantView):
    """Proxy cached media using HA authentication for GET and HEAD requests.

    HA owns this shared view until shutdown. Every request rechecks the entry
    and camera connection, and only forwards bounded video bytes and range
    headers. The gateway credential is never placed in a playback URL.
    """

    url = f"/api/{DOMAIN}/recordings/{{entry_id}}/{{serial}}/{{record_id}}.mp4"
    name = f"api:{DOMAIN}:recording"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        """Borrow HA to resolve currently loaded coordinators on each request."""
        self.hass = hass

    async def get(self, request, entry_id: str, serial: str, record_id: str):
        """Serve prepared video or a browser byte range without waking the camera."""
        try:
            _parts(f"{entry_id}/{serial}/2000-01-01/{record_id}")
            coordinator = _coordinator(self.hass, entry_id, serial)
        except MediaSourceError as error:
            raise web.HTTPNotFound() from error
        try:
            status, body, headers = await coordinator.client.recording_media(
                serial, record_id, request.headers.get("Range"),
                head=request.method == "HEAD",
            )
        except GatewayClientError as error:
            raise web.HTTPBadGateway(text=str(error)) from error
        if status == 404:
            raise web.HTTPNotFound(text="Recording expired. Select the clip again.")
        return web.Response(status=status, body=body, headers=headers)

    async def head(self, request, entry_id: str, serial: str, record_id: str):
        """Return the same cache metadata without transferring video bytes."""
        return await self.get(request, entry_id, serial, record_id)
