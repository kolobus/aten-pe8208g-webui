FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
