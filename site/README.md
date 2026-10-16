# Public device catalogue

The GitHub Pages website is generated from the maintained YAML records in
`eufy_event_gateway/device_catalogue/devices/`. There is no second device list to
update. The support run updates and validates those records as usual. After its
changes merge into `main`, the Catalogue website workflow rebuilds, checks and
publishes the site automatically. A failed check leaves the last published site
in place.

## Build and check

Use Node.js 24. From the repository root:

```sh
npm ci --prefix eufy_event_gateway
npm ci --prefix site
npm run site:test --prefix eufy_event_gateway
npm run site:build --prefix eufy_event_gateway
npx --prefix site playwright install chromium
npm run test:browser --prefix site
```

Serve `site/dist` under `/eufy-mega-security/` for local preview. The browser
checks start and stop their own local server. Screenshots normally go to ignored
`site/test-results/`. Set `SITE_SCREENSHOT_DIR` to another local directory to keep
them for review.

The default production base is `/eufy-mega-security/` and the origin is
`https://mscodemonkey.github.io`. `SITE_BASE=/` builds for a root-hosted preview.
The build accepts only an HTTPS origin and a safe slash-terminated base path.
It creates static HTML for every device, so direct links and the catalogue work
without JavaScript. JavaScript adds filtering, connection changes and guided
support reports.

## Evidence and images

Admission and feature evidence are separate. Integrated devices are admitted by
the integration, but that does not establish every feature works. Catalogue-only
devices do not create Home Assistant entities. Filters match evidence for the
same feature and connection. An absent connection result is unconfirmed, not
unavailable.

The public model excludes protocol commands, parameters, contributor names,
source references and raw notes. It preserves the seven evidence levels and
recorded test dates. A new source category or evidence status must be mapped
explicitly before it can be published.

Product photos are local files with exact model mappings and source attribution
in `assets/images.json`. That manifest records the source, image hash, byte size
and alternative text. It does not grant a licence to the images. Unmapped
devices use a labelled category image. Do not substitute generated concept art
for real model photography. To add an image, verify the product identity,
record its original source and integrity data, and run the build checks.

## Guided help

`help/?device=<catalogue-id>&connection=<catalogue-connection>` preselects a
known setup. Other parameters are ignored. Draft answers live only in page
memory. They are not sent to a server or saved to browser storage. The website
uses no analytics or telemetry, though GitHub handles hosting requests.

Visitors review the exact report and confirm it contains no private information
before opening GitHub. They sign in and submit the issue themselves. The site
does not POST issues, collect credentials or upload diagnostic files. Large
reports use complete copy/download output rather than a truncated URL. Every
outgoing action uses the same best-effort privacy checks. Those checks cannot
guarantee full redaction.

## Publication and recovery

Pages uses the GitHub Actions publishing source. Pull requests build and check
the site without deployment permissions. Only trusted `main` runs can deploy to
the `github-pages` environment. The artifact contains only `site/dist`, never
the repository, local notes, test output or private diagnostics.

To undo a website change, revert its source commit and let `main` rebuild and
publish. A prior workflow can be rerun while its artifact is still available.
Disabling Pages is the fallback if the site must be taken offline. Website
updates do not require a gateway release or a Home Assistant deployment.
