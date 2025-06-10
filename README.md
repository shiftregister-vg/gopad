# GoPad

GoPad is a collaborative text editor built with Go and React. It allows multiple users to edit the same document in real-time using operational transformation.

## Features

- Real-time collaborative editing
- Monaco editor integration (same editor as VS Code)
- WebSocket-based communication
- Operational transformation for conflict resolution
- Redis-based distributed state management
- Multi-server support with consistent state

## Prerequisites

- [devbox](https://www.jetify.com/devbox) for development environment management
- Docker (optional, for production deployment)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/shiftregister-vg/gopad.git
cd gopad
```

2. Install devbox:
```bash
# On macOS:
curl -fsSL https://get.jetify.com/devbox | bash

# On Linux:
curl -fsSL https://get.jetify.com/devbox | bash
```

3. Start the development environment:
```bash
devbox shell
```

4. Install dependencies:
```bash
# Install Go dependencies
go mod download

# Install frontend dependencies
cd web
npm install
cd ..
```

## Development

The project uses devbox to manage development dependencies and services. When you enter the devbox shell, it automatically:
- Installs Go, Node.js, and Redis
- Starts Redis in the background
- Sets up the development environment

Available devbox scripts:
```bash
# Start both frontend and backend in development mode
devbox services up
```

## Configuration

The server can be configured using environment variables:

- `REDIS_URL`: Redis connection URL (default: "redis://localhost:6379/0")
- `GO_ENV`: Set to "development" for development mode

## Multi-Server Deployment

GoPad supports running multiple server instances behind a load balancer. Each instance will:
- Share state through Redis
- Automatically sync updates between instances
- Maintain consistency across all clients

To deploy multiple instances:
1. Set up a Redis server
2. Configure each GoPad instance with the same Redis URL
3. Set up a load balancer (e.g., Nginx) to distribute traffic

## Docker Deployment

GoPad can be deployed using Docker. The application is containerized with both frontend and backend services, while Redis should be run separately.

### Building the Docker Image

```bash
# Build the Docker image
docker build -t gopad .
```

### Running the Container

```bash
# Basic run with default settings
docker run -p 8080:8080 gopad

# Run with custom Redis configuration
docker run -p 8080:8080 \
  -e REDIS_URL="redis://your-redis-host:6379/0" \
  -e PORT="8080" \
  gopad
```

### Environment Variables

The following environment variables can be configured:

- `REDIS_URL`: Redis connection URL (default: "redis://localhost:6379/0")
- `PORT`: Port to expose the application on (default: "8080")
- `GO_ENV`: Environment mode (default: "production")

### Production Deployment

For production deployment, it's recommended to:
1. Use a managed Redis service or run Redis in a separate container
2. Set up a reverse proxy (e.g., Nginx) in front of the container
3. Use Docker Compose or Kubernetes for orchestration
4. Configure proper SSL/TLS termination

## How It Works

GoPad uses operational transformation to handle concurrent edits. When multiple users edit the same document:

1. Each edit is converted into an operation (insert or delete)
2. Operations are transformed against each other to maintain consistency
3. The transformed operations are applied to each client's document
4. State is persisted in Redis and synchronized across all server instances

## License

MIT 