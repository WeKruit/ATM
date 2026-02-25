FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .

FROM oven/bun:1-slim
WORKDIR /app
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    ruby-full build-essential libffi-dev \
    openssh-client python3-pip curl git && \
    gem install kamal --no-document && \
    pip3 install --break-system-packages awscli && \
    apt-get purge -y build-essential libffi-dev && \
    apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app .
# Kamal requires a git repo for version resolution
RUN git init -q && git add -A && git -c user.email=atm -c user.name=atm commit -qm "init" --allow-empty
EXPOSE 8000
CMD ["bun", "src/server.ts"]
