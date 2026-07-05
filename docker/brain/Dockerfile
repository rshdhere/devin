FROM oven/bun:1.2-alpine AS base
WORKDIR /app
ENV HUSKY=0
RUN apk add --no-cache libc6-compat

FROM base AS pruner
COPY . .
RUN bunx turbo prune @devin/brain --docker

FROM base AS prod
COPY --from=pruner /app/out/json/ .
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --from=pruner /app/out/full/ .
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.2-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 app && adduser --system --uid 1001 --ingroup app app
COPY --from=prod --chown=app:app /app .
USER app
EXPOSE 9092
ENV BRAIN_PORT=9092
ENV SERVICE_MODE=brain
CMD ["bun", "run", "apps/brain/src/main.ts"]
