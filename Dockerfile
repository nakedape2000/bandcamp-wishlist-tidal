FROM oven/bun:1.3-slim

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN groupadd --system app && useradd --system --gid app app \
  && mkdir -p /data \
  && chown -R app:app /app /data

ENV BCTS_CONFIG=/data/config.json
ENV BCTS_DATABASE=/data/data.sqlite
EXPOSE 4173
USER app

CMD ["bun", "run", "scripts/review-server.ts", "--host", "0.0.0.0"]
