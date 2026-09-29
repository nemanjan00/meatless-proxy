# syntax=docker/dockerfile:1
# The code.run sandbox: Python 3 (numpy, pandas, sympy, matplotlib) and Node, run as a non-root user.
# The harness starts one container per employee from it, with a read-only root filesystem, no network
# (unless the employee's network setting or DEFAULT_EGRESS allows hosts through the egress proxy) and the employee's files at /work/files.
# Build: docker build -t mp-sandbox docker/sandbox  (or `docker compose --profile build build sandbox`)

FROM node:26-slim AS node

FROM python:3.13-slim
# Node: the binary and npm from the official image, plus the two libraries it links against.
# Versions come from the pinned base image's Debian release.
# hadolint ignore=DL3008
RUN apt-get update \
  && apt-get install -y --no-install-recommends libatomic1 libstdc++6 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && node --version

# hadolint ignore=DL3013
RUN pip install --no-cache-dir numpy pandas sympy matplotlib \
  && python3 -c "import numpy, pandas, sympy, matplotlib"

# uid 1000, the same as the harness's own user, so files it writes on the shared files volume stay its own.
# /work is the sandbox's scratch space; /work/files and /work/shared are where the employee's own and
# shared files appear (mounted over these directories, or copied into them).
RUN groupadd -g 1000 sandbox \
  && useradd -u 1000 -g 1000 -d /tmp -M -s /usr/sbin/nologin sandbox \
  && mkdir -p /work/files /work/shared \
  && chown 1000:1000 /work /work/files \
  && chmod 0555 /work/shared

ENV HOME=/tmp \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/.matplotlib \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUSERBASE=/work/.local \
    PIP_NO_CACHE_DIR=1 \
    NPM_CONFIG_PREFIX=/work/.npm \
    NPM_CONFIG_CACHE=/tmp/.npm \
    NODE_PATH=/work/node_modules:/work/.npm/lib/node_modules

USER 1000:1000
WORKDIR /work/files
CMD ["sleep", "infinity"]
