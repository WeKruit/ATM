# Stage 1: Build the Vite dashboard
FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Build with base=/ for standalone Fly.io serving (not /dashboard/)
ENV VITE_BASE=/
RUN bunx vite build

# Stage 2: Serve with Caddy
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /app/dist /srv

EXPOSE 8080
