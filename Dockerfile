# Stage 1: builder — install dependencies
FROM node:24-alpine AS builder
WORKDIR /app

# Copy manifest files first for better layer caching
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

# No build step needed for pure JS, but keep placeholder
# RUN npm run build 2>/dev/null || true

# Stage 2: runtime — minimal image, non-root user
FROM node:24-alpine
RUN apk add --no-cache ca-certificates wget && \
    addgroup -g 1001 -S nodejs && \
    adduser -S modelrelay -u 1001 -G nodejs

WORKDIR /app

# Copy runtime files from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/public ./public
COPY --from=builder /app/scores.js ./
COPY --from=builder /app/sources.js ./

# Drop privileges
USER modelrelay

# Expose router port
EXPOSE 7352

# Health check — probe API meta endpoint; it's cheap and indicates router is up
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:7352/api/meta > /dev/null 2>&1 || exit 1

# Entrypoint
ENTRYPOINT ["node", "bin/modelrelay.js"]
CMD ["start"]
