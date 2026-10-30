# Production Dockerfile for DeployMate (Full-Stack Monorepo)
FROM --platform=linux/amd64 node:20.15.1-alpine3.20
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

COPY package*.json ./
COPY backend/package*.json ./backend/
RUN npm ci --omit=dev --workspace=backend

COPY backend/dist ./backend/dist
COPY frontend/out ./frontend/out

EXPOSE 4000

CMD ["node", "backend/dist/server.js"]
