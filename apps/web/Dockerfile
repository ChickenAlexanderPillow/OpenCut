FROM oven/bun:alpine AS base

RUN apk add --no-cache \
	libc6-compat \
	libstdc++

FROM base AS builder

WORKDIR /app

ARG WEB_BUILD_NODE_OPTIONS="--max-old-space-size=1536"
ARG FREESOUND_CLIENT_ID
ARG FREESOUND_API_KEY

COPY package.json package.json
COPY bun.lock bun.lock
COPY turbo.json turbo.json

COPY apps/web/package.json apps/web/package.json
COPY packages/env/package.json packages/env/package.json
COPY packages/ui/package.json packages/ui/package.json

RUN bun install --frozen-lockfile

COPY apps/web/ apps/web/
COPY packages/env/ packages/env/
COPY packages/ui/ packages/ui/

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=$WEB_BUILD_NODE_OPTIONS

# Build-time env stubs to pass zod validation
ENV BETTER_AUTH_SECRET="build-time-secret"
ENV UPSTASH_REDIS_REST_URL="http://localhost:8079"
ENV UPSTASH_REDIS_REST_TOKEN="example_token"
ENV NEXT_PUBLIC_SITE_URL="http://localhost:3000"
ENV NEXT_PUBLIC_MARBLE_API_URL="https://api.marblecms.com"
ENV MARBLE_WORKSPACE_KEY="build-placeholder"
ENV CLOUDFLARE_ACCOUNT_ID="build-placeholder"
ENV R2_ACCESS_KEY_ID="build-placeholder"
ENV R2_SECRET_ACCESS_KEY="build-placeholder"
ENV R2_BUCKET_NAME="build-placeholder"
ENV MODAL_TRANSCRIPTION_URL="http://localhost:0"

ENV FREESOUND_CLIENT_ID=$FREESOUND_CLIENT_ID
ENV FREESOUND_API_KEY=$FREESOUND_API_KEY

WORKDIR /app/apps/web
RUN bun run build:docker

# Production image
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS="--max-old-space-size=1024"

RUN apk add --no-cache \
	libc6-compat \
	libstdc++

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

RUN chown nextjs:nodejs apps

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/web/server.js"]
