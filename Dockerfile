# --- Build ------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# --- Stimme -----------------------------------------------------------------
# Neuronale Sprachausgabe ueber sherpa-onnx: klingt wie Piper, kostet aber nur
# ein 2,4-MB-Binary plus onnxruntime statt eines Python-Stapels mit numpy
# (rund 190 MB gespart). Eigene Stufe, damit ein Code-Neubau nichts neu laedt.
FROM debian:12-slim AS voice
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 \
 && rm -rf /var/lib/apt/lists/*

ARG SHERPA_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.6/sherpa-onnx-v1.13.6-linux-x64-shared.tar.bz2
RUN curl -fsSL "$SHERPA_URL" -o /tmp/s.tar.bz2 \
 && mkdir -p /tmp/x && tar xjf /tmp/s.tar.bz2 -C /tmp/x --strip-components=1 \
 && mkdir -p /opt/tts/bin /opt/tts/lib \
 # Nur die Sprachsynthese - der Rest des Pakets ist Spracherkennung.
 && cp /tmp/x/bin/sherpa-onnx-offline-tts /opt/tts/bin/ \
 && cp /tmp/x/lib/libonnxruntime.so /opt/tts/lib/ \
 && rm -rf /tmp/x /tmp/s.tar.bz2

ARG VOICE_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-de_DE-thorsten-medium.tar.bz2
RUN curl -fsSL "$VOICE_URL" -o /tmp/m.tar.bz2 \
 && mkdir -p /opt/tts/voice \
 && tar xjf /tmp/m.tar.bz2 -C /opt/tts/voice --strip-components=1 \
 && rm /tmp/m.tar.bz2

# --- Laufzeit ---------------------------------------------------------------
# Debian statt Alpine: sherpa-onnx gibt es nur fuer glibc, nicht fuer musl.
FROM node:20-slim AS runtime
WORKDIR /app

COPY --from=voice /opt/tts /opt/tts
ENV LD_LIBRARY_PATH=/opt/tts/lib \
    TTS_DIR=/opt/tts

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
