# Remote MCP server (Streamable HTTP) for online agents.
#   docker run -p 8080:8080 -e MCP_AUTH_TOKEN=... -e LENDLORD_EMAIL=... -e LENDLORD_PASSWORD=... lendlord-mcp
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production MCP_TRANSPORT=http MCP_HTTP_PORT=8080
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "dist/index.js"]
