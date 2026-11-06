FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src/weather ./src/weather
COPY src/rate-limit.mjs src/weather-http-server.mjs src/weather-index.mjs src/weather-worker.mjs src/weather-worker-http.mjs ./src/
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "src/weather-index.mjs"]
