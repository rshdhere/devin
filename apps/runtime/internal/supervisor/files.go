package supervisor

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

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

func (s *Server) handleFilesList(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimSpace(r.URL.Query().Get("path"))
	if rel == "" {
		rel = "."
	}
	target := s.resolveCWD(rel)
	entries, err := os.ReadDir(target)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	items := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		info, infoErr := entry.Info()
		size := int64(0)
		if infoErr == nil && info != nil {
			size = info.Size()
		}
		items = append(items, map[string]any{
			"name":  entry.Name(),
			"path":  filepath.Join(rel, entry.Name()),
			"isDir": entry.IsDir(),
			"size":  size,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":  rel,
		"items": items,
	})
}

func (s *Server) handleFilesRead(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimSpace(r.URL.Query().Get("path"))
	if rel == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	target := filepath.Join(s.workspace, filepath.Clean("/"+rel))
	data, err := os.ReadFile(target)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if len(data) > 512*1024 {
		writeError(w, http.StatusRequestEntityTooLarge, "file exceeds 512KiB preview limit")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":    rel,
		"content": string(data),
	})
}
