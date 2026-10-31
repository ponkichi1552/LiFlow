FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER node
ENV NODE_ENV=production APPLIANCE_CARE_MODE=public HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "src/public-index.mjs"]
