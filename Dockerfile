FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY frontend/ /app/frontend/

ENV NODE_ENV=production

EXPOSE 5000

CMD ["node", "server.js"]
