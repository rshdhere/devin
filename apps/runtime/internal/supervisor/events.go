package supervisor

import (
	"net/http"
	"time"

	"github.com/rshdhere/devin/apps/runtime/internal/events"
)

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	taskID := r.URL.Query().Get("taskId")

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	if taskID == "" {
		_, _ = w.Write(events.FormatSSE(events.Event{
			Type:      "runtime.ready",
			Message:   "supervisor online",
			Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		}))
		flusher.Flush()
		return
	}

	for _, event := range s.eventBus.History(taskID) {
		_, _ = w.Write(events.FormatSSE(event))
	}
	flusher.Flush()

	ctx := r.Context()
	updates, unsubscribe := s.eventBus.Subscribe(taskID)
	defer unsubscribe()

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			_, _ = w.Write([]byte(": keepalive\n\n"))
			flusher.Flush()
		case event, ok := <-updates:
			if !ok {
				return
			}
			_, _ = w.Write(events.FormatSSE(event))
			flusher.Flush()
		}
	}
}
