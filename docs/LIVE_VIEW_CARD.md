# Eufy live view card

The integration includes a dashboard card that shows a camera's live video with its controls on top: pan and tilt, lens and zoom, and a menu for night vision, quality, AI tracking, presets and the light. It comes with the integration. There is nothing else to install and no dashboard resource to add.

## Adding the card

Edit a dashboard, add a card and choose **Eufy live view**, or add it in YAML:

```yaml
type: custom:eufy-live-card
entity: camera.driveway
```

| Option | Default | Meaning |
| --- | --- | --- |
| `entity` | first Eufy camera | The camera shown when the card opens. |
| `entities` | all Eufy cameras | Cameras offered by the picker on the camera name. |
| `autoplay` | `true` | Start live video when the card opens. With `false` the card shows the retained picture and a play button. |
| `aspect_ratio` | `16:9` | Shape of the picture, as for Home Assistant's picture cards. |

Video plays through Home Assistant's own picture card in live mode, so it uses the same WebRTC or HLS route as any other camera card. An NVR carries one live call at a time, so use one live card per NVR and switch cameras with the picker rather than placing several live cards side by side.

## Controls

The card shows only the controls a camera already has as entities. If a control is not offered here, it is not offered by the integration for that camera either. Behind an NVR, the controls need the options described in [Experimental NVR live controls](NVR_LIVE_CONTROLS.md).

| Control | Where | Entities used |
| --- | --- | --- |
| Pan and tilt pad | Over the bottom-left of the picture, shown or hidden by **Pan/tilt** | The four direction buttons |
| Lens: Fixed or Movable | Bottom of the picture (T8E00 behind the NVR) | The Camera view select |
| Lens 1x and 3x (T8416, T8E00), or the zoom steps a camera offers | Bottom of the picture | The zoom buttons: on T8416 and T8E00, 1x sends optical step 1 (wide lens) and 3x sends step 2 (telephoto) |
| Night vision, Quality | **More** menu | Their selects |
| AI tracking, Auto cruise | **More** menu | Their switch, or their on and off buttons |
| Presets | **More** menu | The preset buttons |
| Light on, Light off | **More** menu | The light buttons |
| Siren | Top right, after a confirmation | The camera siren |
| Settings | Top right | Opens the camera's normal Home Assistant dialog |

Tap an empty part of the picture, or the eye button at the top right, to hide the controls and see the whole picture. Tap the picture again to bring them back. Results of a request stay visible while the controls are hidden.

The T8416 and T8E00 each have two lenses, a wide one and a 3x telephoto. Step 2 selects the telephoto, and on hardware step 3 after step 2 changed nothing, so the card shows 1x and 3x for these models rather than the three zoom buttons.

Pan, tilt and zoom stay unavailable until the camera reports live video, because the gateway accepts them only while a viewer is attached. One request runs at a time, and the next waits at least one second.

## What the results mean

- **Request sent. Check the picture to confirm.** The gateway accepted a movement or zoom (`request_accepted`). This does not establish that the camera moved or which lens is in use. The zoom chip keeps a marked outline on the level last requested, never a confirmed state.
- **A confirmed value**, such as "Night vision: Infrared on". Night vision, quality, the lens and switches such as AI tracking report back before the integration returns, so the card names the value. On and off buttons, presets, the light and the siren have no read-back, so they report "Request sent" like a movement.
- **No confirmation came back.** The outcome is unknown (`outcome_unknown`). The camera may still have moved. Check the picture before pressing again. The card never repeats a request for you.
- **Busy, too soon, or turned off.** The gateway refused the request.
- **Could not be completed** (`unavailable`). The gateway gives this when a control is withdrawn and also when the live source drops during a request, so check the picture before trying again.

## Changing the T8E00 lens

The gateway changes the Camera view only while the camera has no open session. The card therefore closes its own video, waits for the camera to report idle (up to 90 seconds; Home Assistant usually keeps the last session for about half a minute), sends the change, and starts video again. If the gateway still answers busy, the card waits and sends again, because a busy answer changes nothing. If another view or a recording keeps the camera in use, the card says so and restarts video on the old lens.

## Limits

The card's own wording is English for now. Entity names and option labels follow Home Assistant's language. Screenshot, recording and two-way talk are not on the card. Movement is single clicks only: holding a direction does not keep the camera moving.

## For developers

The card is `custom_components/eufy_event_gateway/frontend/eufy-live-card.js`, plain JavaScript with no build step. `live_card.py` serves it and registers it with the frontend once per Home Assistant run, with a hash of the file in its URL so browsers fetch a fresh copy after an update. The card finds controls by translation key on the camera's device; `tests/test_live_card.py` checks those keys and the client's failure codes still match, and runs the card's request-flow tests in `tests/eufy_live_card.test.mjs` with Node.js.
