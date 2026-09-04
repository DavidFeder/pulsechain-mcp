# Multi-stage production image for pulsechain-mcp
# - Builds TypeScript → dist/
# - Runtime: production deps only, non-root, no secrets
# - Image ENV: AGENT_WALLET_ENABLED=false (secretless container; runtime
#   default is also research-only — wallets-on must opt in with a master key)
# - Primary production path remains host stdio (Cursor/Grok/Claude);
#   this image is for local/co-located testing and optional HTTP smoke.

# -----------------------------------------------------------------------------
# Builder
# -----------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src

RUN npm ci && npm run build

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app

# Production defaults — override via compose/env_file only (never bake secrets)
ENV NODE_ENV=production \
    AGENT_WALLET_ENABLED=false \
    LOG_LEVEL=info

# Create a dedicated data path owned by the non-root user (wallet volume mount point)
RUN mkdir -p /app/data/wallets && chown -R node:node /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist

# Drop privileges: image USER is non-root; do not run as root in compose either
USER node

# No ports published by default (stdio). Optional HTTP binds 127.0.0.1 only when
# HTTP_TRANSPORT_PORT is set — use host network (Linux) or documented patterns.
# EXPOSE is intentionally omitted.

ENTRYPOINT ["node", "dist/index.js"]
