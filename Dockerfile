# Production Multi-Stage Dockerfile for DeployMate (Full-Stack Monorepo)
FROM --platform=linux/amd64 node:20.15.1-alpine3.20 AS builder
WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
RUN npm ci

COPY . .
RUN npm run build --workspace=backend
RUN npm run build --workspace=frontend

FROM --platform=linux/amd64 node:20.15.1-alpine3.20 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

COPY package*.json ./
COPY backend/package*.json ./backend/
RUN npm ci --omit=dev --workspace=backend

COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/out ./frontend/out
COPY --from=builder /app/backend/src/store/seedDeployments.json ./backend/dist/store/seedDeployments.json

EXPOSE 4000

CMD ["node", "backend/dist/server.js"]
