# Tudoholic Size Charts — same recipe as Tudoholic Logistics.
FROM public.ecr.aws/docker/library/node:22-alpine AS base
RUN corepack enable pnpm
ENV PNPM_HOME="/pnpm-global"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app

# ---- Build ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- Run ----
FROM base
# better-sqlite3 is a native module; these build it if no prebuilt one fits.
RUN apk add --no-cache python3 make g++ sqlite-dev
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/.output /app/.output
COPY entrypoint.sh drizzle.config.ts ./
COPY server/db/migrations ./server/db/migrations
COPY server/db/schema.ts ./server/db/schema.ts
RUN chmod +x entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]
