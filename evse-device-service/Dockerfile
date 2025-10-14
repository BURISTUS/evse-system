# Multi-stage build for NestJS EVSE Device Service
# Optimized for production deployment

# ========================================
# Stage 1: Dependencies
# ========================================
FROM node:20-alpine AS deps

WORKDIR /app

# Install dependencies for native modules
RUN apk add --no-cache libc6-compat python3 make g++

# Copy package files
COPY package.json yarn.lock ./

# Install all dependencies (including devDependencies for build)
RUN yarn install --frozen-lockfile --production=false

# ========================================
# Stage 2: Builder
# ========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Build application
RUN yarn build

# Remove devDependencies
RUN yarn install --frozen-lockfile --production=true && \
    yarn cache clean

# ========================================
# Stage 3: Runner
# ========================================
FROM node:20-alpine AS runner

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    curl \
    tini

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001

# Copy built application
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./
COPY --from=builder --chown=nestjs:nodejs /app/proto ./proto

# Create logs directory
RUN mkdir -p /app/logs && \
    chown nestjs:nodejs /app/logs

USER nestjs

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

# Set environment variables
ENV NODE_ENV=production \
    PORT=3001

# Use tini for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Run application
CMD ["node", "dist/main.js"]