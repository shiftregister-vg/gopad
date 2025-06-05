# GoPad

GoPad is a collaborative text editor built with Go and React. It allows multiple users to edit the same document in real-time using operational transformation.

## Features

- Real-time collaborative editing
- Monaco editor integration (same editor as VS Code)
- WebSocket-based communication
- Operational transformation for conflict resolution
- No database required (in-memory storage)

## Prerequisites

- Go 1.16 or later
- Node.js 14 or later
- npm or yarn

## Installation

1. Clone the repository:
```bash
git clone https://github.com/shiftregister-vg/gopad.git
cd gopad
```

2. Install Go dependencies:
```bash
go mod download
```

3. Install frontend dependencies:
```bash
cd web
npm install
```

## Running the Application

1. Build the frontend:
```bash
cd web
npm run build
```

2. Start the Go server:
```bash
cd ..
go run cmd/server/main.go
```

The application will be available at http://localhost:3030

## Development

To run the frontend in development mode with hot reloading:

```bash
cd web
npm start
```

## How It Works

GoPad uses operational transformation to handle concurrent edits. When multiple users edit the same document:

1. Each edit is converted into an operation (insert or delete)
2. Operations are transformed against each other to maintain consistency
3. The transformed operations are applied to each client's document

## License

MIT 