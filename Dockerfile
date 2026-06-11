# Use official Node.js LTS runtime
FROM node:20-bookworm-slim

# Install system dependencies required for SQLite3 and Puppeteer
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Set application directory
WORKDIR /app

# Copy server package configuration files
COPY server/package*.json ./server/

# Install production dependencies for server
RUN cd server && npm ci --omit=dev

# Copy the rest of the workspace files
COPY . .

# Expose Express server port
EXPOSE 3001

# Run the backend express server
CMD ["node", "server/index.js"]
