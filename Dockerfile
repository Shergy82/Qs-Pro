FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY server/package*.json ./server/

RUN cd server && npm ci --omit=dev --build-from-source

COPY . .

RUN rm -rf server/node_modules && cd server && npm ci --omit=dev --build-from-source

EXPOSE 3001

CMD ["node", "server/index.js"]