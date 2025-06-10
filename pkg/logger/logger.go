package logger

import (
	"log/slog"
	"os"
	"strings"
)

var (
	// Logger is the global slog logger instance
	Logger *slog.Logger
)

// Init initializes the logger with the specified level
func Init(level string) {
	// Parse log level
	var logLevel slog.Level
	switch strings.ToUpper(level) {
	case "DEBUG":
		logLevel = slog.LevelDebug
	case "INFO":
		logLevel = slog.LevelInfo
	case "WARN", "WARNING":
		logLevel = slog.LevelWarn
	case "ERROR":
		logLevel = slog.LevelError
	default:
		logLevel = slog.LevelInfo
	}

	// Create a handler with the specified level
	handler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: logLevel,
	})

	// Create the logger
	Logger = slog.New(handler)
}

// SetOutput sets the output destination for the logger
func SetOutput(w *os.File) {
	// Create a new handler with the same level as the current logger
	handler := slog.NewTextHandler(w, &slog.HandlerOptions{
		Level: slog.LevelInfo, // Default to INFO level
	})
	Logger = slog.New(handler)
}

// Debug logs a debug message
func Debug(msg string, args ...any) {
	Logger.Debug(msg, args...)
}

// Info logs an info message
func Info(msg string, args ...any) {
	Logger.Info(msg, args...)
}

// Warn logs a warning message
func Warn(msg string, args ...any) {
	Logger.Warn(msg, args...)
}

// Error logs an error message
func Error(msg string, args ...any) {
	Logger.Error(msg, args...)
}

// Fatal logs a fatal message and exits
func Fatal(msg string, args ...any) {
	Logger.Error(msg, args...)
	os.Exit(1)
}
