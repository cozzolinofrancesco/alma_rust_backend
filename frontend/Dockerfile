# syntax=docker/dockerfile:1.7
#
# Multi-stage Next.js production image.
#
# Goals:
#   - Same behavior as the previous single-stage image (every endpoint and
#     every dependency that the app actually imports keeps working).
#   - Drop the Debian build toolchain from the final image.
#   - Slim base instead of full Debian.
#
# What is preserved (used at runtime by app code):
#   - pandoc          → app/api/export/docx/route.ts (spawn 'pandoc')
#   - graphicsmagick  → pdf2pic in app/api/ocr*/route.ts (spawns 'gm')
#   - ghostscript     → pdf2pic uses 'gs' to rasterise PDFs
#   - sharp           → app/api/ocr-stream/route.ts (linux/amd64 prebuild)
#
# What is intentionally NOT compiled:
#   - The `canvas` npm package. It is listed as an optional peer of a few
#     PDF/jsdom packages but it is NOT imported anywhere in `app/`. We keep
#     it in package.json (no source change) and simply skip it via
#     `--omit=optional`, which means we no longer need libcairo2-dev,
#     libpango1.0-dev, libjpeg-dev, libgif-dev, build-essential or
#     libicu-dev in the final image.

ARG NODE_IMAGE=node:20-bookworm-slim

# =============================================================================
# Stage 1: deps — production-only node_modules
# =============================================================================
FROM --platform=linux/amd64 ${NODE_IMAGE} AS deps
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      build-essential \
      python3 \
      pkg-config \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

ARG ARCH=amd64
ENV ARCH=${ARCH}

# Resilience against transient registry ECONNRESET during large no-cache
# installs (retry behavior only; does not change installed package contents).
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000

RUN npm ci --omit=dev --omit=optional --legacy-peer-deps \
 && if [ "$ARCH" = "arm64" ]; then \
           npm install --os=linux --cpu=arm64 @img/sharp-linux-arm64@0.33.5 @img/sharp-libvips-linux-arm64@1.0.4 --legacy-peer-deps --omit=dev --omit=optional; \
    else \
           npm install --os=linux --cpu=x64 @img/sharp-linux-x64@0.33.5 @img/sharp-libvips-linux-x64@1.0.4 --legacy-peer-deps --omit=dev --omit=optional; \
    fi

# =============================================================================
# Stage 2: builder — full deps + Next build
# =============================================================================
FROM --platform=linux/amd64 ${NODE_IMAGE} AS builder
WORKDIR /app

# Resilience against transient registry ECONNRESET during large no-cache
# installs (retry behavior only; does not change installed package contents).
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      build-essential \
      python3 \
      pkg-config \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# npm ci --omit=optional skips sharp's platform binaries; install linux-x64
# packages explicitly (versions must match sharp@0.33.5 optionalDependencies in package-lock).
RUN npm ci --legacy-peer-deps --omit=optional --no-audit --no-fund \
 && npm install @img/sharp-linux-x64@0.33.5 @img/sharp-libvips-linux-x64@1.0.4 \
      --legacy-peer-deps --no-audit --no-fund

COPY . .

# Cap Node heap so Next's static-page generation GCs instead of getting
# OOM-killed by the cgroup (exit 137 on ~140-page builds).
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=4096
RUN npm run build

# =============================================================================
# Stage 3: runner — minimal runtime
# =============================================================================
FROM --platform=linux/amd64 ${NODE_IMAGE} AS runner
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      pandoc \
      graphicsmagick \
      ghostscript \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs nextjs

COPY --from=deps    --chown=nextjs:nodejs /app/node_modules    ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next           ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public          ./public
COPY --from=builder --chown=nextjs:nodejs /app/package.json    ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.mjs ./next.config.mjs
# Server-side env vars (NEXTAUTH_URL, NEXTAUTH_SECRET, GOOGLE_CLIENT_ID, etc.)
# are read at runtime from process.env.
#
# FE-SECRET-001: .env.production is intentionally NOT baked into the image —
# doing so shipped NEXTAUTH_SECRET / GOOGLE_CLIENT_SECRET inside the artifact
# (anyone with the image could forge sessions). Secrets are injected at runtime
# instead (Cloud Run env / secret manager, or `docker run --env-file`). Provide
# NEXTAUTH_URL, NEXTAUTH_SECRET, GOOGLE_CLIENT_ID/SECRET as runtime env; without
# NEXTAUTH_SECRET /api/auth/session will 500, which is the intended fail-closed
# signal that runtime secrets were not supplied.

RUN mkdir -p /app/tmp_uploads_ocr && chown -R nextjs:nodejs /app/tmp_uploads_ocr

USER nextjs

EXPOSE 8080

# tini reaps zombie processes from the pandoc / gm / gs child spawns
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
