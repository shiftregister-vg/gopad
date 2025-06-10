package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// DocumentState represents the persistent state of a document
type DocumentState struct {
	Content      string            `json:"content"`
	Language     string            `json:"language"`
	LastModified int64             `json:"lastModified"`
	Users        map[string]string `json:"users"`   // uuid -> name
	Version      int64             `json:"version"` // Added for conflict detection
	Tabs         []Tab             `json:"tabs"`    // Added for tab support
	ActiveTabId  string            `json:"activeTabId"`
}

type Tab struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Notes   string `json:"notes"` // Added for storing markdown notes
}

// redisClient is an interface that abstracts Redis operations
type redisClient interface {
	Ping(ctx context.Context) *redis.StatusCmd
	HGet(ctx context.Context, key, field string) *redis.StringCmd
	HSet(ctx context.Context, key string, values ...interface{}) *redis.IntCmd
	Del(ctx context.Context, keys ...string) *redis.IntCmd
	Expire(ctx context.Context, key string, expiration time.Duration) *redis.BoolCmd
	Publish(ctx context.Context, channel string, message interface{}) *redis.IntCmd
	Subscribe(ctx context.Context, channels ...string) *redis.PubSub
	Pipeline() redis.Pipeliner
	Close() error
}

// Storage handles persistent document state using Redis
type Storage struct {
	client redisClient
	mu     sync.RWMutex
	ctx    context.Context
}

// New creates a new storage instance
func New(redisURL string) (*Storage, error) {
	ctx := context.Background()
	var client redisClient

	// Check if cluster mode is enabled
	if os.Getenv("REDIS_CLUSTER_MODE") == "true" {
		// Parse URL for cluster mode
		opts, err := redis.ParseURL(redisURL)
		if err != nil {
			return nil, fmt.Errorf("failed to parse Redis URL: %w", err)
		}

		// Create cluster client
		clusterClient := redis.NewClusterClient(&redis.ClusterOptions{
			Addrs:    []string{opts.Addr},
			Username: opts.Username,
			Password: opts.Password,
			// Enable cluster mode
			ClusterSlots: func(ctx context.Context) ([]redis.ClusterSlot, error) {
				return nil, nil // Let the client discover slots automatically
			},
		})

		// Test connection
		if err := clusterClient.Ping(ctx).Err(); err != nil {
			return nil, fmt.Errorf("failed to connect to Redis cluster: %w", err)
		}

		client = clusterClient
	} else {
		// Parse URL for single instance mode
		opts, err := redis.ParseURL(redisURL)
		if err != nil {
			return nil, fmt.Errorf("failed to parse Redis URL: %w", err)
		}

		// Create single instance client
		singleClient := redis.NewClient(opts)

		// Test connection
		if err := singleClient.Ping(ctx).Err(); err != nil {
			return nil, fmt.Errorf("failed to connect to Redis: %w", err)
		}

		client = singleClient
	}

	return &Storage{
		client: client,
		ctx:    ctx,
	}, nil
}

// SaveDocument saves the document state to Redis
func (s *Storage) SaveDocument(docID string, state *DocumentState) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Get current version
	currentVersion, err := s.client.HGet(s.ctx, fmt.Sprintf("doc:%s", docID), "version").Int64()
	if err != nil && err != redis.Nil {
		return fmt.Errorf("failed to get current version: %w", err)
	}

	// Increment version
	state.Version = currentVersion + 1
	state.LastModified = time.Now().UnixMilli()

	// Marshal state
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("failed to marshal document state: %w", err)
	}

	// Save to Redis using pipeline for atomic operation
	pipe := s.client.Pipeline()
	pipe.HSet(s.ctx, fmt.Sprintf("doc:%s", docID), "data", data)
	pipe.Publish(s.ctx, fmt.Sprintf("doc:%s:updates", docID), data)
	// Set 7-day expiration
	pipe.Expire(s.ctx, fmt.Sprintf("doc:%s", docID), 7*24*time.Hour)
	_, err = pipe.Exec(s.ctx)
	if err != nil {
		return fmt.Errorf("failed to save document state: %w", err)
	}

	return nil
}

// LoadDocument loads the document state from Redis
func (s *Storage) LoadDocument(docID string) (*DocumentState, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	data, err := s.client.HGet(s.ctx, fmt.Sprintf("doc:%s", docID), "data").Bytes()
	if err != nil {
		if err == redis.Nil {
			return &DocumentState{
				Content:      "",
				Language:     "plaintext",
				LastModified: 0,
				Users:        make(map[string]string),
				Version:      0,
			}, nil
		}
		return nil, fmt.Errorf("failed to load document state: %w", err)
	}

	var state DocumentState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("failed to unmarshal document state: %w", err)
	}

	return &state, nil
}

// DeleteDocument removes a document's state from Redis
func (s *Storage) DeleteDocument(docID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	pipe := s.client.Pipeline()
	pipe.Del(s.ctx, fmt.Sprintf("doc:%s", docID))
	pipe.Publish(s.ctx, fmt.Sprintf("doc:%s:deleted", docID), "")
	_, err := pipe.Exec(s.ctx)
	if err != nil {
		return fmt.Errorf("failed to delete document: %w", err)
	}

	return nil
}

// SubscribeToUpdates subscribes to document updates
func (s *Storage) SubscribeToUpdates(docID string, handler func(*DocumentState)) error {
	pubsub := s.client.Subscribe(s.ctx, fmt.Sprintf("doc:%s:updates", docID))
	defer pubsub.Close()

	ch := pubsub.Channel()
	for msg := range ch {
		var state DocumentState
		if err := json.Unmarshal([]byte(msg.Payload), &state); err != nil {
			return fmt.Errorf("failed to unmarshal update: %w", err)
		}
		handler(&state)
	}

	return nil
}

// Close closes the Redis connection
func (s *Storage) Close() error {
	return s.client.Close()
}
