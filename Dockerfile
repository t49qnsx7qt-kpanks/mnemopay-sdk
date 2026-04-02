FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ dist/

EXPOSE 3200

ENV PORT=3200
ENV MNEMOPAY_MODE=quick
ENV NODE_ENV=production

CMD ["node", "dist/mcp/server.js", "--start", "--http"]
