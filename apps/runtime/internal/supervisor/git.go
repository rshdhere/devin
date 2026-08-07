package supervisor

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
	"github.com/rshdhere/devin/apps/runtime/internal/workspace"
)

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
		"timeout 120 git clone --depth 1 %s %s",
		shellQuote(req.URL),
		shellQuote(targetPath),
	)
	s.appendLog("git clone " + req.URL)

	result, err := executil.RunGuest(r.Context(), s.workspace, command, workspace.DevinProcessEnv(s.workspace), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if result.ExitCode != 0 {
		msg := executil.CombinedOutput(result)
		if result.ExitCode == 124 {
			msg = "git clone timed out (sandbox may have no outbound network): " + msg
		}
		writeError(w, http.StatusUnprocessableEntity, msg)
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

	result, err := executil.RunGuest(r.Context(), cwd, command, workspace.DevinProcessEnv(s.workspace), parseRequestEnv(r))
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

	result, err := executil.RunGuest(r.Context(), cwd, command, workspace.DevinProcessEnv(s.workspace), parseRequestEnv(r))
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
