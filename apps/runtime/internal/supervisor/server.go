package supervisor

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/rshdhere/devin/apps/runtime/internal/agent"
	"github.com/rshdhere/devin/apps/runtime/internal/events"
	"github.com/rshdhere/devin/apps/runtime/internal/executil"
)

type Server struct {
	workspace string
	logs      []string
	mu        sync.RWMutex
	agents    *agent.Service
	eventBus  *events.Bus
}

func New(workspace string) *Server {
	return &Server{
		workspace: workspace,
		logs:      []string{},
		agents:    agent.NewService(agent.LoadConfig(workspace)),
		eventBus:  events.NewBus(),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /logs", s.handleLogs)
	mux.HandleFunc("POST /run", s.handleRun)
	mux.HandleFunc("POST /terminal", s.handleTerminal)
	mux.HandleFunc("POST /git/clone", s.handleGitClone)
	mux.HandleFunc("POST /git/commit", s.handleGitCommit)
	mux.HandleFunc("POST /files/write", s.handleFilesWrite)
	mux.HandleFunc("POST /browser/open", s.handleBrowserOpen)
	mux.HandleFunc("GET /events", s.handleEvents)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleLogs(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"logs": s.logs})
}

type runRequest struct {
	TaskID string `json:"taskId"`
	Prompt string `json:"prompt"`
	Agent  string `json:"agent,omitempty"`
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

	result, err := s.agents.Run(r.Context(), agent.RunRequest{
		TaskID: req.TaskID,
		Prompt: req.Prompt,
		Agent:  req.Agent,
	}, s.eventBus)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	status := http.StatusOK
	if result.Status == "failed" {
		status = http.StatusUnprocessableEntity
	}

	writeJSON(w, status, map[string]any{
		"taskId":  req.TaskID,
		"status":  result.Status,
		"message": result.Message,
		"output":  result.Output,
		"agent":   result.Agent,
	})
}

type terminalRequest struct {
	TaskID  string `json:"taskId,omitempty"`
	Command string `json:"command"`
	CWD     string `json:"cwd"`
}

func (s *Server) handleTerminal(w http.ResponseWriter, r *http.Request) {
	var req terminalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	cwd := s.resolveCWD(req.CWD)
	s.appendLog("terminal: " + req.Command)

	result, err := executil.Run(r.Context(), cwd, req.Command, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if req.TaskID != "" {
		s.eventBus.Publish(req.TaskID, "agent.tool", "terminal command finished", map[string]any{
			"command":  req.Command,
			"exitCode": result.ExitCode,
			"stdout":   result.Stdout,
			"stderr":   result.Stderr,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "completed",
		"exitCode": result.ExitCode,
		"stdout":   result.Stdout,
		"stderr":   result.Stderr,
	})
}

type gitCloneRequest struct {
	TaskID string `json:"taskId,omitempty"`
	URL    string `json:"url"`
	Path   string `json:"path"`
}

func (s *Server) handleGitClone(w http.ResponseWriter, r *http.Request) {
	var req gitCloneRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	target := req.Path
	if target == "" {
		target = "repo"
	}
	targetPath := filepath.Join(s.workspace, filepath.Clean("/"+target))
	command := fmt.Sprintf("git clone %s %s", shellQuote(req.URL), shellQuote(targetPath))
	s.appendLog("git clone " + req.URL)

	result, err := executil.Run(r.Context(), s.workspace, command, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if result.ExitCode != 0 {
		writeError(w, http.StatusUnprocessableEntity, executil.CombinedOutput(result))
		return
	}

	if req.TaskID != "" {
		s.eventBus.Publish(req.TaskID, "git.clone", "repository cloned", map[string]any{
			"url":  req.URL,
			"path": target,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status": "completed",
		"path":   target,
	})
}

type gitCommitRequest struct {
	TaskID  string   `json:"taskId,omitempty"`
	Message string   `json:"message"`
	Paths   []string `json:"paths"`
}

func (s *Server) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	var req gitCommitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	addPaths := "."
	if len(req.Paths) > 0 {
		addPaths = strings.Join(req.Paths, " ")
	}
	command := fmt.Sprintf(
		"git add %s && git commit -m %s",
		addPaths,
		shellQuote(req.Message),
	)
	s.appendLog("git commit: " + req.Message)

	result, err := executil.Run(r.Context(), s.workspace, command, []string{
		"GIT_AUTHOR_NAME=devin-agent",
		"GIT_AUTHOR_EMAIL=agent@devin.baby",
		"GIT_COMMITTER_NAME=devin-agent",
		"GIT_COMMITTER_EMAIL=agent@devin.baby",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if result.ExitCode != 0 {
		writeError(w, http.StatusUnprocessableEntity, executil.CombinedOutput(result))
		return
	}

	if req.TaskID != "" {
		s.eventBus.Publish(req.TaskID, "git.commit", "changes committed", map[string]any{
			"message": req.Message,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "completed",
		"message": req.Message,
		"output":  executil.CombinedOutput(result),
	})
}

type fileWriteRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (s *Server) handleFilesWrite(w http.ResponseWriter, r *http.Request) {
	var req fileWriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	target := filepath.Join(s.workspace, filepath.Clean("/"+req.Path))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := os.WriteFile(target, []byte(req.Content), 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	s.appendLog("file write " + req.Path)
	writeJSON(w, http.StatusOK, map[string]string{"status": "written", "path": req.Path})
}

type browserOpenRequest struct {
	URL string `json:"url"`
}

func (s *Server) handleBrowserOpen(w http.ResponseWriter, r *http.Request) {
	var req browserOpenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	s.appendLog("browser open " + req.URL)
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "accepted",
		"url":     req.URL,
		"message": "browser automation is not configured in this runtime image",
	})
}

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

	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-updates:
			if !ok {
				return
			}
			_, _ = w.Write(events.FormatSSE(event))
			flusher.Flush()
		}
	}
}

func (s *Server) resolveCWD(path string) string {
	if path == "" {
		return s.workspace
	}
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(s.workspace, filepath.Clean("/"+path))
}

func (s *Server) appendLog(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs = append(s.logs, time.Now().UTC().Format(time.RFC3339)+" "+line)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
