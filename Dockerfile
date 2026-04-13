# Node + LibreOffice (soffice) for DOC/DOCX → PDF conversion used by libreoffice-convert
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

ENV NODE_ENV=production

# Default for local runs; Render/cloud set PORT at runtime
EXPOSE 10000

USER node

CMD ["node", "server.js"]
