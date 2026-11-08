# syntax=docker/dockerfile:1.7
# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
# Only Chromium (no Firefox/WebKit/headless shell) plus its system libraries, Xvfb for
# headful mode and a small font set. Keeps the image small enough for registries and
# gateways with short pull timeouts.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/data \
    PORT=8099 \
    HOST=0.0.0.0 \
    MCP_PATH=/mcp \
    HEADLESS=false \
    DISPLAY=:99

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb tini fonts-liberation fonts-noto-color-emoji \
 && node node_modules/playwright-core/cli.js install --with-deps --no-shell chromium \
 && apt-get clean && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/* \
 && mkdir -p /data && chown -R node:node /data /ms-playwright

USER node
VOLUME ["/data"]
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8099)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
