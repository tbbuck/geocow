# Self-hosting geocow

One container serves the built map and the `/api` endpoints. The OSTN15 grid
is baked into the image and validated at startup, so there is nothing to
provision but the container itself.

## Run it

```sh
docker compose up -d --build
curl -fsS http://127.0.0.1:8787/api/health   # -> ok
```

`compose.yaml` publishes on `127.0.0.1:8787` only — Docker's own iptables
rules bypass host firewalls, so a bare `8787:8787` would expose the service on
every interface. Put a reverse proxy in front.

## Configure it

Everything is optional and read at run time. Put values in a `.env` file next
to `compose.yaml` (gitignored) or export them before `docker compose up`:

| Variable | Effect when set |
|---|---|
| `GEOCOW_MAPTILER_KEY` | MapTiler dataviz styles and the satellite basemap. Unset: keyless [OpenFreeMap](https://openfreemap.org) styles, no satellite. The key reaches every browser, so restrict it to your origin in MapTiler. |
| `GEOCOW_AERIAL_TILE_URL` | An XYZ raster template (e.g. `https://tiles.example.com/{z}/{x}/{y}.jpg`) drawn as a hi-res aerial overlay in satellite mode. The tile server must allow your origin via CORS. |
| `GEOCOW_AERIAL_ATTRIBUTION` | Attribution shown for that overlay. |
| `GEOCOW_API_KEY` | Enables `POST /api/geometry` with this shared key. Unset: the endpoint answers 503. |
| `GEOCOW_PUBLIC_URL` | Origin used in links returned by `/api/geometry`. Unset: derived from `Host` and `X-Forwarded-Proto`. |

## Put a proxy in front

[`nginx.conf.example`](nginx.conf.example) is a working nginx site: keepalive
upstream, gzip, immutable caching for hashed assets, `no-store` for the API,
and the forwarded headers `/api/geometry` needs to build correct links.

Behind Cloudflare, include [`cloudflare-realip.conf`](cloudflare-realip.conf)
in the server block to log real client IPs.

## Deploy continuously

The public CI has an optional last step: once `main` is green it sends a
`repository_dispatch` (`deploy`, with the commit SHA) to the repository named
by the `DEPLOY_REPO` Actions variable, authenticated by the
`DEPLOY_DISPATCH_TOKEN` secret. A workflow there — on a self-hosted runner on
your server, kept out of this public repo — can check out that SHA and run
`docker compose up -d --build`. Leave the variable unset and the step is
skipped.
