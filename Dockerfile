# --- Build ------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# --- Laufzeit ---------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# Sprachausgabe fuer die Ansage auf Cast-Geraeten (~19 MB). Die Sprachausgabe
# des Browsers kaeme aus dem Telefon, nicht aus dem Lautsprecher.
RUN apk add --no-cache espeak-ng

ENV NODE_ENV=production \
    PORT=5174 \
    HOST=0.0.0.0

# server/ hat keine Abhaengigkeiten - es wandert kein node_modules ins Image.
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json

USER node
EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5174)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
