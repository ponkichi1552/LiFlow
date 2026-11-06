# Build context is the canonical repository root. Use the same portable contracts as the phones.
FROM node:24-bookworm-slim
WORKDIR /app
COPY server/account-device-api/package.json server/account-device-api/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY server/account-device-api/src ./server/account-device-api/src
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "server/account-device-api/src/index.mjs"]
