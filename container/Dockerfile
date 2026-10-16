# Proof-of-concept only. Pin Orca release and image digest after compatibility is proven.
FROM node:24-bookworm-slim

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl file jq xvfb zlib1g git openssh-client tini \
  libgtk-3-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 \
  libxtst6 libcups2 libdrm2 libxkbcommon0 libpango-1.0-0 libcairo2 \
  libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libxrender1 libx11-xcb1 libxcb-dri3-0 libxss1 \
  && rm -rf /var/lib/apt/lists/*

ARG ORCA_APPIMAGE_URL=https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage
RUN mkdir -p /opt/orca && curl -fsSL --retry 3 "$ORCA_APPIMAGE_URL" -o /opt/orca/orca-linux.AppImage \
  && chmod 755 /opt/orca/orca-linux.AppImage \
  && cd /opt/orca && ./orca-linux.AppImage --appimage-extract >/dev/null \
  && chmod -R a+rX /opt/orca/squashfs-root \
  && rm /opt/orca/orca-linux.AppImage

# Agent binary is installed, but authentication is intentionally never baked into an image.
RUN npm install -g @openai/codex \
  && useradd -m -s /bin/bash agent \
  && mkdir -p /workspace /app && chown -R agent:agent /workspace /app

COPY --chown=agent:agent container/supervisor.mjs /app/supervisor.mjs
COPY --chown=agent:agent container/identity.mjs /app/identity.mjs
COPY --chown=agent:agent container/pairing.mjs /app/pairing.mjs
WORKDIR /workspace
USER agent
ENV HOME=/home/agent \
    ORCA_PORT=6768 \
    ORCA_PROJECT_ROOT=/workspace \
    LIBGL_ALWAYS_SOFTWARE=1
EXPOSE 6768 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/supervisor.mjs"]
