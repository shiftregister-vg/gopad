package ot

import (
	"encoding/json"
	"errors"
)

// Operation represents a single edit operation
type Operation struct {
	Type     string `json:"type"` // "insert" or "delete"
	Position int    `json:"position"`
	Text     string `json:"text,omitempty"`
	Length   int    `json:"length,omitempty"`
}

// Document represents a document with its operations history
type Document struct {
	Content    string      `json:"content"`
	Operations []Operation `json:"operations"`
}

// NewDocument creates a new empty document
func NewDocument() *Document {
	return &Document{
		Content:    "",
		Operations: make([]Operation, 0),
	}
}

// Apply applies an operation to the document
func (d *Document) Apply(op Operation) error {
	switch op.Type {
	case "insert":
		if op.Position < 0 || op.Position > len(d.Content) {
			return errors.New("invalid position for insert")
		}
		d.Content = d.Content[:op.Position] + op.Text + d.Content[op.Position:]
	case "delete":
		if op.Position < 0 || op.Position+op.Length > len(d.Content) {
			return errors.New("invalid position or length for delete")
		}
		d.Content = d.Content[:op.Position] + d.Content[op.Position+op.Length:]
	default:
		return errors.New("unknown operation type")
	}
	d.Operations = append(d.Operations, op)
	return nil
}

// Transform transforms an operation against another operation
func Transform(op1, op2 Operation) (Operation, Operation, error) {
	if op1.Position > op2.Position {
		// Swap operations to handle them in order
		op1, op2 = op2, op1
	}

	switch {
	case op1.Type == "insert" && op2.Type == "insert":
		if op1.Position <= op2.Position {
			op2.Position += len(op1.Text)
		}
	case op1.Type == "insert" && op2.Type == "delete":
		if op1.Position <= op2.Position {
			op2.Position += len(op1.Text)
		}
	case op1.Type == "delete" && op2.Type == "insert":
		if op1.Position+op1.Length > op2.Position {
			op2.Position = op1.Position
		}
	case op1.Type == "delete" && op2.Type == "delete":
		if op1.Position+op1.Length > op2.Position {
			op2.Length -= op1.Length
			if op2.Length < 0 {
				op2.Length = 0
			}
		}
	}

	return op1, op2, nil
}

// SerializeOperation converts an operation to JSON
func SerializeOperation(op Operation) ([]byte, error) {
	return json.Marshal(op)
}

// DeserializeOperation converts JSON to an operation
func DeserializeOperation(data []byte) (Operation, error) {
	var op Operation
	err := json.Unmarshal(data, &op)
	return op, err
}
