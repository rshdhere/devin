package supervisor

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

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

func (s *Server) handleDesktopScreenshot(w http.ResponseWriter, r *http.Request) {
	targetURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if targetURL == "" {
		targetURL = "http://127.0.0.1:3000/"
	}
	outPath := filepath.Join(workspace.WritableHome(s.workspace), "desktop-preview.png")
	script := fmt.Sprintf(
		"set -e; if command -v chromium >/dev/null 2>&1; then B=chromium; elif command -v chromium-browser >/dev/null 2>&1; then B=chromium-browser; else exit 127; fi; "+
			"$B --headless --disable-gpu --no-sandbox --window-size=1280,720 --screenshot=%s %s",
		shellQuote(outPath),
		shellQuote(targetURL),
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
			msg = "chromium not available in sandbox image"
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
}
