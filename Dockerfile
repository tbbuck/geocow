# syntax=docker/dockerfile:1
#
# Multi-stage build: frontend (node) -> geocow (rust) -> slim runtime.
# The one OSTN15 .gsb grid geocow uses (15 MB) IS baked into the runtime stage,
# so there is no volume to wrangle and no host provisioning. The obsolete grid
# and the huge .asc equivalents are excluded by .dockerignore.
#
# Uses Debian trixie because the `proj` crate (proj-sys) requires PROJ >= 9.4;
# trixie ships PROJ 9.6, so proj-sys links the system library instead of
# compiling PROJ from source (faster, far less fragile). bookworm's 9.1 forces
# a brittle from-source build — don't downgrade the base.

# --- Stage 1: build the Vite/Lit frontend -------------------------------
FROM node:22-trixie AS web
WORKDIR /web
COPY web/package.json web/yarn.lock web/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable
COPY web/ ./
RUN yarn build

# --- Stage 2: build geocow (just the `serve` subcommand) ----------------
FROM rust:1-trixie AS server
# proj-sys links system PROJ via pkg-config and ships pre-generated bindings,
# so no clang/bindgen is needed.
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libproj-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked --no-default-features --features serve

# --- Stage 3: runtime ----------------------------------------------------
FROM debian:trixie-slim AS runtime
# libproj25 pulls its own runtime deps (sqlite3, tiff, curl); curl is for the
# container healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libproj25 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /app/target/release/geocow /usr/local/bin/geocow
COPY --from=web /web/dist ./web/dist
# Bake in the OSTN15 grid (15 MB) — no runtime volume needed — with the
# licences: OS's BSD terms for the grid, MIT for geocow.
COPY OSTN15_NTv2/OSTN15_NTv2_OSGBtoETRS.gsb OSTN15_NTv2/LICENCE.md /grids/
COPY LICENSE /usr/share/doc/geocow/LICENSE

ENV GEOCOW_WEB_DIR=/app/web/dist \
    GEOCOW_GRID_DIR=/grids \
    GEOCOW_BIND=0.0.0.0:8787

# Map tiles and ingest are configured at run time, never baked in:
#   GEOCOW_MAPTILER_KEY, GEOCOW_AERIAL_TILE_URL, GEOCOW_AERIAL_ATTRIBUTION,
#   GEOCOW_API_KEY, GEOCOW_PUBLIC_URL
EXPOSE 8787
ENTRYPOINT ["geocow"]
CMD ["serve"]
