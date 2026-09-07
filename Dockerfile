# syntax=docker/dockerfile:1

# ---------- Stage 1: build the SPA ----------
FROM node:22-alpine AS frontend-build
WORKDIR /app
ENV CI=true
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts tailwind.config.js postcss.config.js index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---------- Stage 2: frontend runtime (nginx) ----------
FROM nginx:1.27-alpine AS frontend
LABEL org.opencontainers.image.title="Paqt frontend" \
      org.opencontainers.image.description="Serves the built SPA and proxies /api to the backend"
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/dist /usr/share/nginx/html
EXPOSE 80

# ---------- Stage 3: backend runtime (Express API) ----------
FROM node:22-alpine AS backend
LABEL org.opencontainers.image.title="Paqt backend" \
      org.opencontainers.image.description="Groq proxy + health API (API only; static is served by nginx)"
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
USER app
EXPOSE 3001
CMD ["node", "server/index.mjs"]