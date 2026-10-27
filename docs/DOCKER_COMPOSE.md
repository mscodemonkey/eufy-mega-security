# Docker Compose with Home Assistant Container

Run the gateway as a separate container, then connect the Eufy Mega Security
integration to it manually. A Supervisor installation is not required. The
container includes FFmpeg and uses the same gateway as the Home Assistant app.

## Start the gateway

Install Docker Engine and the Docker Compose plugin, then clone this repository
or extract a published release. Run these commands in the repository directory:

```sh
cp docker/options.example.json docker/options.json
chmod 600 docker/options.json
```

Edit `docker/options.json` with your Eufy account email, password and two-letter
country code. Preserve the password exactly. Keep this file private. It is
ignored by Git and mounted read-only into the container. Optional gateway app
settings use the same names as the Home Assistant app options and default off
when omitted, including experimental controls.

```sh
docker compose up -d --build
docker compose ps
```

The first build downloads the base image and installs dependencies. The gateway
listens on port 3218 of the Docker host. Open `http://YOUR_DOCKER_HOST:3218` to
complete a login challenge if Eufy requests one. Use the gateway page, and avoid
repeated sign-in attempts if Eufy rejects the account.

## Connect Home Assistant

Install the Eufy Mega Security custom integration using the existing
[HACS instructions](../README.md#install-the-integration-with-hacs), then restart Home
Assistant if the integration was newly installed. Home Assistant Container can
load custom integrations from its persistent `/config/custom_components` folder.

Retrieve the gateway API token locally:

```sh
docker compose exec -T gateway cat /data/api_token
```

In Home Assistant, choose **Settings > Devices & services > Add integration >
Eufy Mega Security**. Enter the gateway URL `http://YOUR_DOCKER_HOST:3218` and the
token. Keep the token private. Supervisor discovery is not used for this setup.

`localhost` inside the Home Assistant container means that container, so use an
address reachable from Home Assistant. If both services share a Docker network,
the gateway service name can be used as `http://gateway:3218`. Otherwise use the
Docker host's LAN address. Make the gateway reachable from browsers and Home
Assistant clients that need its media. Do not publish this port to the internet.

If port 3218 is already in use, set `EUFY_GATEWAY_PUBLISHED_PORT` before starting
Compose and use that host port in the integration URL. To publish on a specific
host interface, set `EUFY_GATEWAY_BIND_ADDRESS` as well. Keep the port reachable
from the Home Assistant container.

## Updates, restart and data

The `gateway-data` named volume holds the reusable login session, gateway API
token and runtime data. Keep this volume when updating. Keep `docker/options.json`
as well. To update, check out or extract the next release into this directory,
then run:

```sh
docker compose up -d --build
```

A plain `docker compose down` removes the container and network while preserving
the named volume. Do not add `--volumes` or remove `gateway-data` during an update.
Back up the volume and private options file before moving to another Docker host.

Use `docker compose logs --tail=100 gateway` for local troubleshooting. Logs can
contain private details, so send only the specific safe line requested in an
issue. The `/live` health check proves the process is running. It does not prove
Eufy authentication, camera compatibility or playable video.
