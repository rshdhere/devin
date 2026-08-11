package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
	"github.com/rshdhere/devin/apps/runtime/internal/workspace"
)

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
		"message": "open this URL in the embedded browser panel or a new tab",
	})
}

const desktopSnapshotRel = ".home/last-desktop-snapshot.png"

func desktopSnapshotPaths(workspaceRoot string) []string {
	home := workspace.WritableHome(workspaceRoot)
	return []string{
		filepath.Join(home, "last-desktop-snapshot.png"),
		filepath.Join(home, "desktop-preview.png"),
	}
}

func (s *Server) handleLastDesktopScreenshot(w http.ResponseWriter, r *http.Request) {
	for _, path := range desktopSnapshotPaths(s.workspace) {
		data, err := os.ReadFile(path)
		if err != nil || len(data) < 128 {
			continue
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
		return
	}
	writeError(w, http.StatusNotFound, "no desktop snapshot saved yet")
}

func (s *Server) persistDesktopSnapshot(workspaceRoot, sourcePath string) {
	for _, dest := range desktopSnapshotPaths(workspaceRoot) {
		if dest == sourcePath {
			continue
		}
		data, err := os.ReadFile(sourcePath)
		if err != nil {
			continue
		}
		_ = os.WriteFile(dest, data, 0o644)
	}
}

func (s *Server) handleBrowserProxy(w http.ResponseWriter, r *http.Request) {
	port := strings.TrimSpace(r.URL.Query().Get("port"))
	if port == "" {
		port = "3000"
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	target := fmt.Sprintf("http://127.0.0.1:%s%s", port, path)
	tmpDir := workspace.WritableHome(s.workspace)
	bodyPath := filepath.Join(tmpDir, "preview-body.tmp")
	hdrPath := filepath.Join(tmpDir, "preview-hdr.tmp")
	script := fmt.Sprintf(
		"curl -sS -H 'Accept-Encoding: identity' -D %s -o %s --max-time 20 %s",
		shellQuote(hdrPath),
		shellQuote(bodyPath),
		shellQuote(target),
	)
	result, err := executil.RunGuest(
		r.Context(),
		s.workspace,
		script,
		workspace.DevinProcessEnv(s.workspace),
		nil,
	)
	if err != nil || result.ExitCode != 0 {
		msg := executil.CombinedOutput(result)
		if msg == "" {
			msg = "localhost dev server not reachable from sandbox"
		}
		writeError(w, http.StatusBadGateway, msg)
		return
	}
	hdrBytes, err := os.ReadFile(hdrPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	bodyBytes, err := os.ReadFile(bodyPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	status := http.StatusOK
	contentType := "text/html; charset=utf-8"
	for _, line := range strings.Split(string(hdrBytes), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "HTTP/") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				if code, parseErr := strconv.Atoi(parts[1]); parseErr == nil && code >= 100 {
					status = code
				}
			}
			continue
		}
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "content-type:") {
			contentType = strings.TrimSpace(line[len("content-type:"):])
		}
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(bodyBytes)
}

func (s *Server) handleDesktopScreenshot(w http.ResponseWriter, r *http.Request) {
	targetURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if targetURL == "" {
		targetURL = "http://127.0.0.1:8000/"
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	outPath := filepath.Join(workspace.WritableHome(s.workspace), "desktop-preview.png")
	if err := s.captureDesktopScreenshotToFile(ctx, targetURL, outPath); err != nil {
		msg := err.Error()
		if msg == "" {
			msg = "playwright/chromium screenshot failed in sandbox"
		}
		writeError(w, http.StatusServiceUnavailable, msg)
		return
	}
	data, err := os.ReadFile(outPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
	s.persistDesktopSnapshot(s.workspace, outPath)
}
