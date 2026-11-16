# E340 main-lens trial

The optional Main lens (Experimental) camera is available for T8214/type 94 through HomeBase 3 T8030/type 18. It starts disabled in the HA device entity list. The normal combined camera stays available.

The trial crops only the reported 1600×2200 stacked layout, retaining the upper 1600×1100 main picture. A different image layout returns a waiting image. A different video layout stops the derived view. It never substitutes the combined picture under the main-lens name. Hardware results remain unconfirmed.

Enable the optional entity if you want to try its retained snapshot or expose that camera through HomeKit Bridge. Snapshot reads use the retained image and do not start a new camera session. Live viewing shares the normal source and uses a video-only H.264 crop, which costs more gateway CPU than native video. Existing source-duration and recording protections still apply. No lens-selection or camera setting is changed.

Just whether the main picture and an ordinary short view work is useful. If the layout is unavailable, keep the combined camera and stop there. No private picture, longer view or camera setting change is needed. The combined gateway clip service stays on the combined camera. HA camera.record can record the derived main view.
