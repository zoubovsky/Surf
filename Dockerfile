# syntax=docker/dockerfile:1
# =============================================================================
# Surf daemon image (apps/daemon) — multi-stage.
#
#   base      node:22-bookworm-slim + pnpm. pnpm is activated through corepack and
#             pinned by the `packageManager` field in package.json (pnpm@10.33.0).
#   manifests only the package.json files of every workspace package, so the
#             dependency layer is cached until a manifest or the lockfile changes.
#   build     full install (dev deps + native toolchain for better-sqlite3),
#             `tsc -b`, then an in-place `pnpm install --prod --frozen-lockfile`
#             that removes devDependencies from node_modules. Sources are stripped.
#   runtime   slim image, non-root `node` user, tzdata, ffmpeg + yt-dlp.
#
# Why not `pnpm deploy`? On pnpm 10 `deploy` requires `inject-workspace-packages=true`
# (or `--legacy`) and it copies package files following .gitignore, which excludes
# `dist/`. With `node-linker=hoisted` (see .npmrc) a plain workspace install already
# yields one hoisted node_modules at the root plus tiny per-package node_modules that
# only hold the @surf/* workspace symlinks, so the pruned /app tree is directly
# runnable and is copied as a whole into the runtime stage. Validated in the sandbox:
# after the prod re-install typescript/vitest/eslint/tsx/drizzle-kit are gone and
# better-sqlite3's compiled binary is kept.
#
# Runtime contract with the daemon:
#   - entrypoint: apps/daemon/dist/main.js (built by `tsc -b`)
#   - DATA_DIR=/data (bind-mounted from the host, see infra/docker-compose.yml)
#   - health: GET http://127.0.0.1:8787/health -> 200 inside the container.
#     Nothing is published to the host; the daemon must bind 8787 on 127.0.0.1 or
#     0.0.0.0 inside the container. The HEALTHCHECK below is what deploy.yml waits for.
#   - runs as uid/gid 1000 (`node`), so /var/lib/surf/data on the host is chowned
#     to 1000:1000 by infra/cloud-init.yaml.
#   - yt-dlp and ffmpeg are on PATH as the transcript last resort.
# =============================================================================
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
WORKDIR /app
COPY package.json ./
# corepack ships with Node 22; `corepack install` reads packageManager from package.json.
RUN corepack enable && corepack install && pnpm --version

# ---------------------------------------------------------------------------
FROM base AS manifests
COPY apps ./apps
COPY packages ./packages
# Keep only package.json files (and the directories that hold them).
RUN find apps packages -type f ! -name package.json -delete \
 && find apps packages -type d -empty -delete

# ---------------------------------------------------------------------------
FROM base AS build
# Native toolchain: better-sqlite3 runs `prebuild-install || node-gyp rebuild`.
# The prebuilt binary is normally downloaded; the toolchain is the fallback.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --from=manifests /app/apps ./apps
COPY --from=manifests /app/packages ./packages
RUN --mount=type=cache,id=surf-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
# `pnpm run build` is the root `tsc -b` over tsconfig.json references, i.e. the same
# thing `pnpm -r build` does per package, in one compiler invocation.
RUN --mount=type=cache,id=surf-pnpm-store,target=/pnpm/store \
    pnpm run build \
 && test -f apps/daemon/dist/main.js \
 && pnpm install --prod --frozen-lockfile \
 && find apps packages -type d -name src -prune -exec rm -rf {} + \
 && find apps packages -type f \( -name 'tsconfig*.json' -o -name '*.tsbuildinfo' \) -delete \
 && rm -f tsconfig.json tsconfig.base.json

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG YT_DLP_VERSION=2026.08.19
ENV NODE_ENV=production \
    TZ=Europe/London \
    DATA_DIR=/data

# tzdata: TZ support. ffmpeg from Debian (security-maintained; ~250 MB with
# --no-install-recommends — a static build would be smaller but unofficial).
# curl: HEALTHCHECK + fetching yt-dlp. yt-dlp_linux is the standalone build
# (no Python needed), ~39 MB.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata curl ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_linux" \
 && chmod 0755 /usr/local/bin/yt-dlp \
 && yt-dlp --version \
 && ffmpeg -version | head -n1 \
 && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY --from=build --chown=node:node /app /app

USER node
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/health >/dev/null || exit 1

CMD ["node", "apps/daemon/dist/main.js"]
