# Build frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Build backend
FROM golang:1.23-alpine AS backend-builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o gopad ./cmd/gopad

# Final stage
FROM alpine:3.19
WORKDIR /app

# Install necessary runtime dependencies
RUN apk add --no-cache ca-certificates tzdata

# Copy built frontend
COPY --from=frontend-builder /app/web/dist ./web/dist

# Copy built backend
COPY --from=backend-builder /app/gopad .

# Set environment variables with defaults
ENV REDIS_URL="redis://localhost:6379/0" \
    REDIS_CLUSTER_MODE="false" \
    PORT="8080" \
    GO_ENV="production"

# Expose the port
EXPOSE ${PORT}

# Run the application
CMD ["./gopad"] 
