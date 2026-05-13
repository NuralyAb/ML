# --- Frontend image: Next.js 14 (standalone production build) ---
# Multi-stage: install + build in one stage, then ship a slim runtime.
FROM node:20-alpine AS deps
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY frontend/. .
# Next.js evaluates `rewrites()` from next.config.js **at build time** and
# bakes the result into .next/. We therefore need BACKEND_URL during
# `next build`, not just at runtime. Compose passes the same value as both
# a build-arg (here) and an env (for the runner) — the build-time copy is
# the one that drives proxy routing for the lifetime of the image.
ARG BACKEND_URL=http://localhost:8000
ENV BACKEND_URL=$BACKEND_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Copy build output + the public folder (geojson assets).
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
# next.config.js holds the runtime API rewrite — without it `/api/*` proxy
# from the browser falls through and the dashboard returns 500.
COPY --from=builder /app/next.config.js ./next.config.js

USER nextjs
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
