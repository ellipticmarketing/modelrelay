# Multi-stage Dockerfile for modelrelay with unmerged PRs
# Base: Latest official release from npm
# Patch: Cherry-picked unmerged PRs

FROM node:20-alpine AS base

# Install official release
RUN npm install -g modelrelay

# Get source from official package for reference
WORKDIR /app
RUN npm pack modelrelay && tar -xzf modelrelay-*.tgz --strip-components=1

# Start fresh for cherry-picking
FROM node:20-alpine AS builder

WORKDIR /repo

# Clone official upstream
RUN git init && \
    git fetch --depth=1 https://github.com/ellipticmarketing/modelrelay.git master && \
    git checkout FETCH_HEAD

# Cherry-pick unmerged PRs (add PRs here as needed)
# PR #50: AiHubMix Provider
# PR #51: Vision Routing
# PR #48: Multiple OpenAI-compatible endpoints
# PR #47: Prompt Caching

# Example cherry-pick (uncomment and add commit hashes):
# RUN git cherry-pick <commit-hash>

# Install dependencies
RUN npm install

# Run tests
RUN npm test

# Production stage
FROM alpine:3.19 AS production

RUN apk add --no-cache nodejs npm

WORKDIR /app

# Copy built application
COPY --from=builder /repo/package.json ./
COPY --from=builder /repo/package-lock.json ./
COPY --from=builder /repo/bin ./bin
COPY --from=builder /repo/lib ./lib
COPY --from=builder /repo/public ./public
COPY --from=builder /repo/sources.js ./
COPY --from=builder /repo/scores.js ./
COPY --from=builder /repo/README.md ./
COPY --from=builder /repo/LICENSE ./

# Install production deps only
RUN npm ci --omit=dev

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

CMD ["node", "bin/modelrelay.js"]