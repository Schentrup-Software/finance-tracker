FROM node:20-alpine AS build-env
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM alpine:latest
ARG PB_VERSION=0.40.6
ARG TARGETARCH=amd64

RUN apk add --no-cache unzip ca-certificates su-exec

ADD https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip /tmp/pb.zip
RUN unzip /tmp/pb.zip -d /pb/ && rm /tmp/pb.zip

# React SPA, served by PocketBase from pb_public
COPY --from=build-env /app/build/client /pb/pb_public
# Schema (applied automatically on start) and server-side hooks
COPY pb_migrations /pb/pb_migrations
COPY pb_hooks /pb/pb_hooks

# Fixes the data folder's owner, then runs PocketBase as the apps user (PUID/PGID, default 568)
COPY scripts/docker-entrypoint.sh /pb/entrypoint.sh
RUN chmod 755 /pb/entrypoint.sh /pb/pocketbase

EXPOSE 8080
# Keep your data: mount a volume at /pb/pb_data
VOLUME /pb/pb_data

ENTRYPOINT ["/pb/entrypoint.sh"]
CMD ["/pb/pocketbase", "serve", "--http=0.0.0.0:8080", "--dir=/pb/pb_data"]
