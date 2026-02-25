FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .

FROM oven/bun:1-slim
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    ruby-full build-essential libffi-dev \
    openssh-client python3-pip curl && \
    gem install kamal --no-document && \
    pip3 install --break-system-packages awscli && \
    apt-get purge -y build-essential libffi-dev && \
    apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app .
EXPOSE 8000
CMD ["bun", "src/server.ts"]
