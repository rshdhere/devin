package supervisor

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
	"github.com/rshdhere/devin/apps/runtime/internal/workspace"
)

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

	workspace.EnsureDNS()
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

func (s *Server) handleTerminalStream(w http.ResponseWriter, r *http.Request) {
	var req terminalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if strings.TrimSpace(req.Command) == "" {
		writeError(w, http.StatusBadRequest, "command is required")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	workspace.EnsureDNS()
	cwd := s.resolveCWD(req.CWD)
	s.appendLog("terminal stream: " + req.Command)

	result, err := executil.RunStreaming(r.Context(), cwd, req.Command, parseRequestEnv(r), func(line executil.OutputLine) {
		payload, _ := json.Marshal(map[string]any{
			"stream": line.Stream,
			"line":   line.Line,
			"time":   line.Time.UTC().Format(time.RFC3339Nano),
		})
		_, _ = fmt.Fprintf(w, "event: terminal.output\ndata: %s\n\n", payload)
		flusher.Flush()
	})
	if err != nil {
		payload, _ := json.Marshal(map[string]any{"error": err.Error()})
		_, _ = fmt.Fprintf(w, "event: terminal.error\ndata: %s\n\n", payload)
		flusher.Flush()
		return
	}

	donePayload, _ := json.Marshal(map[string]any{
		"exitCode": result.ExitCode,
		"stdout":   result.Stdout,
		"stderr":   result.Stderr,
	})
	_, _ = fmt.Fprintf(w, "event: terminal.done\ndata: %s\n\n", donePayload)
	flusher.Flush()
}
