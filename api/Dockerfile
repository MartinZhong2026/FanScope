FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/app/data/fanscope.sqlite
WORKDIR /app
# DOCX -> unzip (XML text); searchable PDF -> poppler pdftotext. No OCR/audio service.
RUN apt-get update && apt-get install -y --no-install-recommends unzip poppler-utils \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --ignore-scripts
COPY config ./config
COPY src ./src
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8787
CMD ["node","--experimental-sqlite","src/server.mjs"]
