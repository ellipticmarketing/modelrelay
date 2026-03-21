FROM node:24-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

EXPOSE 7352

ENV NODE_ENV=production

ENTRYPOINT ["node", "bin/modelrelay.js"]
CMD ["start"]
