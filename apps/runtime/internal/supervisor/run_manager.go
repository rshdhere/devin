package supervisor

import (
	"context"
	"sync"

	"github.com/rshdhere/devin/apps/runtime/internal/agent"
	"github.com/rshdhere/devin/apps/runtime/internal/events"
)

type runRecord struct {
	mu      sync.RWMutex
	Status  string
	Message string
	Output  string
	Agent   string
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

type runManager struct {
	mu    sync.Mutex
	runs  map[string]*runRecord
	agents *agent.Service
	bus   *events.Bus
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
	defer cancel()

	result, err := m.agents.Run(ctx, req, m.bus)
	if err != nil {
		record.set("failed", err.Error(), "", firstNonEmpty(req.Agent, "default"))
		return
	}

	record.set(result.Status, result.Message, result.Output, result.Agent)
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
