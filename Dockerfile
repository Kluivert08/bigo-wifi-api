# Use a slim image to keep things fast
FROM node:20-bookworm-slim as base

# Set production environment
ENV NODE_ENV="production"
WORKDIR /app

# --- Build Stage ---
FROM base as build

# Install packages needed to build node modules
# 1. DEBIAN_FRONTEND ensures no prompts hang the build
# 2. We combine update, install, and cache cleanup in one layer
RUN apt-get update -qq && \
    export DEBIAN_FRONTEND=noninteractive && \
    apt-get install --no-install-recommends -y \
    build-essential \
    node-gyp \
    pkg-config \
    python-is-python3 \
    python3-dev && \
    rm -rf /var/lib/apt/lists/*

# Install application dependencies
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy application code
COPY . .

# Build application (if applicable, e.g., for Next.js/Prisma)
# RUN npm run build

# --- Final Stage ---
FROM base

# Copy built application
COPY --from=build /app /app

# Expose port and start
EXPOSE 8080
CMD [ "npm", "run", "start" ]