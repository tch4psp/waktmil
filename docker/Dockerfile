FROM node:24-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY public ./public
RUN useradd --system --uid 10001 --create-home appuser && mkdir -p /data/attachments /data/tmp && chown -R appuser:appuser /app /data
USER appuser
EXPOSE 3000
CMD ["node", "src/web/server.js"]
