FROM node:24-alpine

RUN apk add --no-cache ca-certificates git

WORKDIR /app

COPY package*.json ./
COPY pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile

COPY . .

EXPOSE 7352

ENV NODE_ENV=production

ENTRYPOINT ["pnpm", "start"]
CMD ["start"]
