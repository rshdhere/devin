package events

import (
	"encoding/json"
	"sync"
	"time"
)

type Event struct {
	ID        string         `json:"id"`
	TaskID    string         `json:"taskId"`
	Type      string         `json:"type"`
	Message   string         `json:"message"`
	Timestamp string         `json:"timestamp"`
	Data      map[string]any `json:"data,omitempty"`
}

type Bus struct {
	mu        sync.RWMutex
	history   map[string][]Event
 listeners map[string]map[chan Event]struct{}
}

func NewBus() *Bus {
	return &Bus{
		history:   make(map[string][]Event),
		listeners: make(map[string]map[chan Event]struct{}),
	}
}

func (b *Bus) Publish(taskID, eventType, message string, data map[string]any) Event {
	event := Event{
		ID:        newID(),
		TaskID:    taskID,
		Type:      eventType,
		Message:   message,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Data:      data,
	}

	b.mu.Lock()
	b.history[taskID] = append(b.history[taskID], event)
	for ch := range b.listeners[taskID] {
		select {
		case ch <- event:
		default:
		}
	}
	b.mu.Unlock()

	return event
}

func (b *Bus) History(taskID string) []Event {
	b.mu.RLock()
	defer b.mu.RUnlock()
	items := b.history[taskID]
	out := make([]Event, len(items))
	copy(out, items)
	return out
}

func (b *Bus) Subscribe(taskID string) (<-chan Event, func()) {
	ch := make(chan Event, 32)

	b.mu.Lock()
	if b.listeners[taskID] == nil {
		b.listeners[taskID] = make(map[chan Event]struct{})
	}
	b.listeners[taskID][ch] = struct{}{}
	b.mu.Unlock()

	unsubscribe := func() {
		b.mu.Lock()
		delete(b.listeners[taskID], ch)
		close(ch)
		b.mu.Unlock()
	}

	return ch, unsubscribe
}

func FormatSSE(event Event) []byte {
	payload, _ := json.Marshal(event)
	return []byte("event: " + event.Type + "\ndata: " + string(payload) + "\n\n")
}

func newID() string {
	return time.Now().UTC().Format("20060102150405.000000000")
}
