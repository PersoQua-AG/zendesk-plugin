# M9 remote Zendesk MCP connector. Multi-stage, non-root, Node 20 slim.
# REQUIRES: EU VM + TLS termination (reverse proxy) + secrets injected at runtime (ops-gated).
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./
USER node
EXPOSE 8080
# The connector self-reports health on /health while the MCP server is serving (REQ-9).
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/bin/remote.js"]
