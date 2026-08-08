package supervisor

import (
	"encoding/json"
	"net/http"
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
	mux.HandleFunc("GET /files/list", s.handleFilesList)
	mux.HandleFunc("GET /files/read", s.handleFilesRead)
	mux.HandleFunc("POST /terminal/stream", s.handleTerminalStream)
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

func (s *Server) resolveCWD(path string) string {
	return s.resolveWorkspacePath(path)
}

func (s *Server) appendLog(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs = append(s.logs, time.Now().UTC().Format(time.RFC3339)+" "+line)
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

func (s *Server) guestEnv(headerEnv []string) []string {
	return executil.GuestCommandEnv(workspace.DevinProcessEnv(s.workspace), headerEnv)
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
