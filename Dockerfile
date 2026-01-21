FROM node:20-alpine

# Install dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p /app/config \
    /app/logs \
    /app/transaction-data \
    /app/static \
    /app/certs

# Set permissions
RUN chmod -R 755 /app

# Expose port
EXPOSE 8001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8001/ping', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "teller.js"]