# HomeBase 2 camera sensitivity trial

The exact eufyCam 2C T8113-Z, device type 8, has an optional motion-sensitivity control through HomeBase 2 T8010. It uses the existing seven-step scale, where a higher Home Assistant value means more sensitive.

Enable experimental model controls in the app options to make the control available. API authentication, the current owner account and a reported sensitivity value are required. Home Assistant shows **Motion sensitivity (experimental)** on the camera's existing device. The entity keeps its existing identity, so a trial does not create a second sensitivity control.

This route is implemented and software-tested. Physical behaviour has not yet been confirmed. HomeBase 3 support and other HomeBase 2 controls are unchanged. The trial does not cover other 2C model strings, stations or sensitivity schemes.

For a voluntary test, first note the sensitivity in the Eufy app. Change the Home Assistant value by one step, check the result in the Eufy app, then restore the original value and check it again. Only test when a temporary sensitivity change is appropriate. If the outcome is unknown, check the Eufy app before trying another change. A successful request alone does not establish that the camera applied it.

The gateway sends the absolute setting once. It reports success only after fresh inventory confirms the requested value. If confirmation is lost, it removes the uncertain reading rather than keeping an optimistic value or repeatedly sending the command.
