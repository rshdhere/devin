package supervisor

import (
	"context"
	"sync"

	"github.com/rshdhere/devin/apps/runtime/internal/agent"
	"github.com/rshdhere/devin/apps/runtime/internal/events"
)

type runRecord struct {
	mu           sync.RWMutex
	Status       string
	Message      string
	Output       string
	Agent        string
	cancel       context.CancelFunc
	cancelReason string
}

func (r *runRecord) snapshot() map[string]any {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return map[string]any{
		"status":  r.Status,
		"message": r.Message,
		"output":  r.Output,
		"agent":   r.Agent,
	}
}

func (r *runRecord) set(status, message, output, agentName string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Status = status
	r.Message = message
	r.Output = output
	r.Agent = agentName
}

func (r *runRecord) setCancel(cancel context.CancelFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cancel = cancel
}

func (r *runRecord) requestCancel(reason string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.Status != "running" && r.Status != "accepted" {
		return false
	}
	if reason == "" {
		reason = "agent run cancelled"
	}
	r.cancelReason = reason
	if r.cancel != nil {
		r.cancel()
	}
	return true
}

func (r *runRecord) takeCancelReason() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	reason := r.cancelReason
	r.cancelReason = ""
	r.cancel = nil
	return reason
}

type runManager struct {
	mu     sync.Mutex
	runs   map[string]*runRecord
	agents *agent.Service
	bus    *events.Bus
}

func newRunManager(agents *agent.Service, bus *events.Bus) *runManager {
	return &runManager{
		runs:   make(map[string]*runRecord),
		agents: agents,
		bus:    bus,
	}
}

func (m *runManager) start(req agent.RunRequest) (map[string]any, bool) {
	m.mu.Lock()
	if existing, ok := m.runs[req.TaskID]; ok {
		m.mu.Unlock()
		snapshot := existing.snapshot()
		status, _ := snapshot["status"].(string)
		if status == "running" || status == "accepted" {
			return snapshot, false
		}
	}
	record := &runRecord{Status: "accepted", Message: "agent run accepted"}
	m.runs[req.TaskID] = record
	m.mu.Unlock()

	go m.execute(req, record)
	return record.snapshot(), true
}

func (m *runManager) execute(req agent.RunRequest, record *runRecord) {
	record.set("running", "agent executing", "", firstNonEmpty(req.Agent, "default"))

	ctx, cancel := context.WithTimeout(context.Background(), m.agents.RunTimeout(req))
	record.setCancel(cancel)
	defer cancel()

	result, err := m.agents.Run(ctx, req, m.bus)
	reason := record.takeCancelReason()
	if err != nil {
		message := reason
		if message == "" {
			message = err.Error()
		}
		record.set("failed", message, "", firstNonEmpty(req.Agent, "default"))
		return
	}

	record.set(result.Status, result.Message, result.Output, result.Agent)
}

func (m *runManager) cancel(taskID, reason string) (map[string]any, bool) {
	m.mu.Lock()
	record, ok := m.runs[taskID]
	m.mu.Unlock()
	if !ok {
		return nil, false
	}
	if !record.requestCancel(reason) {
		return record.snapshot(), true
	}
	return record.snapshot(), true
}

func (m *runManager) status(taskID string) (map[string]any, bool) {
	m.mu.Lock()
	record, ok := m.runs[taskID]
	m.mu.Unlock()
	if !ok {
		return nil, false
	}
	return record.snapshot(), true
}
