package supervisor

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/rshdhere/devin/apps/runtime/internal/agent"
)

type runRequest struct {
	TaskID  string            `json:"taskId"`
	Prompt  string            `json:"prompt"`
	Agent   string            `json:"agent,omitempty"`
	WorkDir string            `json:"workDir,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	var req runRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if strings.TrimSpace(req.TaskID) == "" || strings.TrimSpace(req.Prompt) == "" {
		writeError(w, http.StatusBadRequest, "taskId and prompt are required")
		return
	}

	s.appendLog("agent running task " + req.TaskID + " via " + firstNonEmpty(req.Agent, "default"))

	snapshot, _ := s.runs.start(agent.RunRequest{
		TaskID:  req.TaskID,
		Prompt:  req.Prompt,
		Agent:   req.Agent,
		WorkDir: req.WorkDir,
		Env:     req.Env,
	})

	writeJSON(w, http.StatusAccepted, map[string]any{
		"taskId":  req.TaskID,
		"status":  snapshot["status"],
		"message": snapshot["message"],
		"output":  snapshot["output"],
		"agent":   snapshot["agent"],
	})
}

func (s *Server) handleRunStatus(w http.ResponseWriter, r *http.Request) {
	taskID := strings.TrimSpace(r.URL.Query().Get("taskId"))
	if taskID == "" {
		writeError(w, http.StatusBadRequest, "taskId is required")
		return
	}

	snapshot, ok := s.runs.status(taskID)
	if !ok {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}

	status := runSnapshotString(snapshot, "status")
	if status == "" {
		status = "unknown"
	}
	code := http.StatusOK
	if status == "accepted" || status == "running" {
		code = http.StatusAccepted
	}

	writeJSON(w, code, map[string]any{
		"taskId":  taskID,
		"status":  status,
		"message": runSnapshotString(snapshot, "message"),
		"output":  runSnapshotString(snapshot, "output"),
		"agent":   runSnapshotString(snapshot, "agent"),
	})
}

type runCancelRequest struct {
	TaskID string `json:"taskId"`
	Reason string `json:"reason,omitempty"`
}

func (s *Server) handleRunCancel(w http.ResponseWriter, r *http.Request) {
	var req runCancelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	taskID := strings.TrimSpace(req.TaskID)
	if taskID == "" {
		taskID = strings.TrimSpace(r.URL.Query().Get("taskId"))
	}
	if taskID == "" {
		writeError(w, http.StatusBadRequest, "taskId is required")
		return
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "agent run cancelled by control plane"
	}

	snapshot, ok := s.runs.cancel(taskID, reason)
	if !ok {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"taskId":  taskID,
		"status":  runSnapshotString(snapshot, "status"),
		"message": runSnapshotString(snapshot, "message"),
		"output":  runSnapshotString(snapshot, "output"),
		"agent":   runSnapshotString(snapshot, "agent"),
	})
}

func runSnapshotString(snapshot map[string]any, key string) string {
	if value, ok := snapshot[key].(string); ok {
		return value
	}
	return ""
}
