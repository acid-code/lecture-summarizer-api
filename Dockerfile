FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV CHROME_PATH=/usr/bin/chromium
ENV SOFFICE_PATH=/usr/bin/soffice
ENV PDFTOPPM_PATH=/usr/bin/pdftoppm

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium chromium-sandbox poppler-utils libreoffice-calc libreoffice-core libreoffice-impress libreoffice-writer fonts-noto-core fonts-noto-cjk ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --home /home/nextjs nextjs \
  && mkdir -p /home/nextjs/.config /home/nextjs/.cache \
  && chown -R nextjs:nodejs /home/nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/fonts ./fonts
COPY --from=builder --chown=nextjs:nodejs /app/templates ./templates
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

RUN mkdir -p /app/data/uploads /app/data/artifacts \
  && chown -R nextjs:nodejs /app/data

USER nextjs
ENV HOME=/home/nextjs
ENV XDG_CONFIG_HOME=/home/nextjs/.config
ENV XDG_CACHE_HOME=/home/nextjs/.cache
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
CMD ["node", "server.js"]
