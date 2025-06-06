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

- [devbox](https://www.jetpack.io/devbox) for development environment management
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
brew install jetpack-io/devbox/devbox

# On Linux:
curl -fsSL https://get.jetpack.io/devbox | bash
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
devbox run dev

# Start only the frontend
devbox run start:frontend

# Start only the backend
devbox run start:backend

# Build the frontend
devbox run build

# Run tests
devbox run test

# Clean build artifacts
devbox run clean
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

## How It Works

GoPad uses operational transformation to handle concurrent edits. When multiple users edit the same document:

1. Each edit is converted into an operation (insert or delete)
2. Operations are transformed against each other to maintain consistency
3. The transformed operations are applied to each client's document
4. State is persisted in Redis and synchronized across all server instances

## License

MIT 