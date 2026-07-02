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
	"github.com/rshdhere/devin/apps/runtime/internal/workspace"
)

type Server struct {
	workspace string
	logs      []string
	mu        sync.RWMutex
	agents    *agent.Service
	eventBus  *events.Bus
	runs      *runManager
}

func New(workspace string) *Server {
	agents := agent.NewService(agent.LoadConfig(workspace))
	bus := events.NewBus()
	return &Server{
		workspace: workspace,
		logs:      []string{},
		agents:    agents,
		eventBus:  bus,
		runs:      newRunManager(agents, bus),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /dns/ensure", s.handleEnsureDNS)
	mux.HandleFunc("GET /logs", s.handleLogs)
	mux.HandleFunc("POST /run", s.handleRun)
	mux.HandleFunc("GET /run/status", s.handleRunStatus)
	mux.HandleFunc("POST /terminal", s.handleTerminal)
	mux.HandleFunc("POST /git/clone", s.handleGitClone)
	mux.HandleFunc("POST /git/commit", s.handleGitCommit)
	mux.HandleFunc("POST /git/push", s.handleGitPush)
	mux.HandleFunc("POST /files/write", s.handleFilesWrite)
	mux.HandleFunc("POST /browser/open", s.handleBrowserOpen)
	mux.HandleFunc("GET /events", s.handleEvents)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleEnsureDNS(w http.ResponseWriter, _ *http.Request) {
	workspace.EnsureDNS()
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleLogs(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, map[string]any{"logs": s.logs})
}

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

func runSnapshotString(snapshot map[string]any, key string) string {
	if value, ok := snapshot[key].(string); ok {
		return value
	}
	return ""
}

func parseRequestEnv(r *http.Request) []string {
	raw := strings.TrimSpace(r.Header.Get("X-Runtime-Env"))
	if raw == "" {
		return nil
	}

	var envMap map[string]string
	if err := json.Unmarshal([]byte(raw), &envMap); err != nil {
		return nil
	}

	env := make([]string, 0, len(envMap))
	for key, value := range envMap {
		env = append(env, key+"="+value)
	}
	return env
}

func gitCommitCommand(message string) string {
	parts := strings.SplitN(message, "\n\n", 2)
	subject := strings.TrimSpace(parts[0])
	if len(parts) == 1 || strings.TrimSpace(parts[1]) == "" {
		return fmt.Sprintf("git commit -m %s", shellQuote(subject))
	}
	body := strings.TrimSpace(parts[1])
	return fmt.Sprintf(
		"git commit -m %s -m %s",
		shellQuote(subject),
		shellQuote(body),
	)
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

	result, err := executil.Run(r.Context(), cwd, req.Command, parseRequestEnv(r))
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
	workspace.EnsureDNS()
	command := fmt.Sprintf(
		"timeout 45 git clone --depth 1 %s %s",
		shellQuote(req.URL),
		shellQuote(targetPath),
	)
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
	CWD     string   `json:"cwd,omitempty"`
}

func (s *Server) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	var req gitCommitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	cwd := s.resolveCWD(req.CWD)
	addPaths := "."
	if len(req.Paths) > 0 {
		addPaths = strings.Join(req.Paths, " ")
	}
	command := fmt.Sprintf(
		"git add %s && %s",
		addPaths,
		gitCommitCommand(req.Message),
	)
	s.appendLog("git commit: " + req.Message)

	result, err := executil.Run(r.Context(), cwd, command, parseRequestEnv(r))
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

type gitPushRequest struct {
	TaskID string `json:"taskId,omitempty"`
	Remote string `json:"remote,omitempty"`
	Branch string `json:"branch,omitempty"`
	CWD    string `json:"cwd,omitempty"`
}

func (s *Server) handleGitPush(w http.ResponseWriter, r *http.Request) {
	var req gitPushRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	cwd := s.resolveCWD(req.CWD)
	workspace.EnsureDNS()
	remote := firstNonEmpty(req.Remote, "origin")
	branch := strings.TrimSpace(req.Branch)
	command := fmt.Sprintf("git push -u %s HEAD", shellQuote(remote))
	if branch != "" {
		command = fmt.Sprintf("git push -u %s %s", shellQuote(remote), shellQuote(branch))
	}
	s.appendLog("git push: " + command)

	result, err := executil.Run(r.Context(), cwd, command, parseRequestEnv(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if result.ExitCode != 0 {
		writeError(w, http.StatusUnprocessableEntity, executil.CombinedOutput(result))
		return
	}

	if req.TaskID != "" {
		s.eventBus.Publish(req.TaskID, "git.push", "changes pushed", map[string]any{
			"remote": remote,
			"branch": branch,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status": "completed",
		"branch": branch,
		"output": executil.CombinedOutput(result),
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
