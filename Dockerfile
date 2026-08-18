# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14-slim AS base

FROM base AS build
WORKDIR /usr/src/app

# Build toolchain for the remaining native dependencies: ssh2's optional crypto
# binding and cpu-features. node-pty and bcrypt are gone - replaced by
# Bun.Terminal and Bun.password.
#
# Node is required here even though nothing runs on it: node-gyp is a Node
# program and the oven/bun image ships no node binary. Build stage only; it
# never reaches the runtime image.
RUN apt-get update && apt-get install -y python3 make g++ git pkg-config libsecret-1-dev curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y nodejs \
 && npm install -g node-gyp \
 && rm -rf /var/lib/apt/lists/*

COPY . .
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile

ENV NODE_ENV=production
# `.next/cache` is webpack's build cache - 720MB in this image, and useless at
# runtime. It has to go before the COPY below: deleting it in the runtime stage
# would leave the bytes sitting in the copied layer. `trace` is a build artefact
# for the same reason.
RUN bun run --filter dokploy build \
    && rm -rf apps/dokploy/.next/cache apps/dokploy/.next/trace

# node_modules is 71% of this image, and a good slice of it cannot run here.
# Pruned after the build, so nothing above is affected:
#   - devDependencies (biome ~114MB, typescript, simple-icons, vitest, drizzle-kit)
#   - musl builds of swc and biome: this image is Debian/glibc, so they are dead
#     weight that will never be loaded
#   - the prisma/effect chain, pulled in as optionalDependencies of
#     @better-auth/prisma-adapter. This fork uses drizzle; prisma is imported
#     nowhere.
RUN bun install --production \
    && find node_modules/.bun -maxdepth 1 \( \
         -name '*musl*' -o -name 'prisma@*' -o -name '@prisma*' \
         -o -name 'effect@*' \) -exec rm -rf {} + 2>/dev/null || true

FROM base AS dokploy
# The workspace layout is preserved because node_modules uses relative symlinks
# into ../../node_modules/.bun/*; flattening the app into /app would break every
# one of them. /app is a symlink so existing paths keep working.
WORKDIR /usr/src/app/apps/dokploy
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y tini curl unzip zip apache2-utils iproute2 rsync git git-lfs \
 && git lfs install && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/src/app/node_modules /usr/src/app/node_modules
COPY --from=build /usr/src/app/package.json /usr/src/app/package.json
COPY --from=build /usr/src/app/packages/server /usr/src/app/packages/server
COPY --from=build /usr/src/app/apps/dokploy/node_modules ./node_modules
COPY --from=build /usr/src/app/apps/dokploy/.next ./.next
COPY --from=build /usr/src/app/apps/dokploy/dist ./dist
COPY --from=build /usr/src/app/apps/dokploy/public ./public
COPY --from=build /usr/src/app/apps/dokploy/drizzle ./drizzle
COPY --from=build /usr/src/app/apps/dokploy/package.json ./package.json
COPY --from=build /usr/src/app/apps/dokploy/next.config.mjs ./next.config.mjs
COPY --from=build /usr/src/app/apps/dokploy/components.json ./components.json
COPY .env.production ./.env
RUN ln -s /usr/src/app/apps/dokploy /app

# Install docker
RUN curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh --version 28.5.2 && rm get-docker.sh && curl https://rclone.org/install.sh | bash

# Install Nixpacks
ARG NIXPACKS_VERSION=1.41.0
RUN curl -sSL https://nixpacks.com/install.sh -o install.sh \
    && chmod +x install.sh \
    && ./install.sh

# Install Railpack
ARG RAILPACK_VERSION=0.15.4
RUN curl -sSL https://railpack.com/install.sh | bash

# Install buildpacks
COPY --from=buildpacksio/pack:0.39.1 /usr/local/bin/pack /usr/local/bin/pack

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:3000/api/trpc/settings.health || exit 1

# tini reaps HEALTHCHECK child processes that the server (as PID 1) leaves defunct.
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["sh", "-c", "bun dist/wait-for-postgres.mjs && bun dist/migration.mjs && exec bun dist/server.mjs"]
