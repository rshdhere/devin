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

	target := s.resolveWorkspacePath(req.Path)
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
	target := s.resolveWorkspacePath(rel)
	entries, err := os.ReadDir(target)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	listRel := s.workspaceRelativePath(target)
		if rel == "." {
			listRel = "."
		}

		items := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			info, infoErr := entry.Info()
			size := int64(0)
			if infoErr == nil && info != nil {
				size = info.Size()
			}
			itemPath := entry.Name()
			if listRel != "." && listRel != "" {
				itemPath = filepath.Join(listRel, entry.Name())
			}
			items = append(items, map[string]any{
				"name":  entry.Name(),
				"path":  itemPath,
				"isDir": entry.IsDir(),
				"size":  size,
			})
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"path":  listRel,
			"items": items,
		})
}

func (s *Server) handleFilesRead(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimSpace(r.URL.Query().Get("path"))
	if rel == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	target := s.resolveWorkspacePath(rel)
	data, err := os.ReadFile(target)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	if len(data) > 512*1024 {
		writeError(w, http.StatusRequestEntityTooLarge, "file exceeds 512KiB preview limit")
		return
	}

	displayPath := s.workspaceRelativePath(target)

	writeJSON(w, http.StatusOK, map[string]any{
		"path":    displayPath,
		"content": string(data),
	})
}

// resolveWorkspacePath maps UI and agent paths onto a single absolute path under the
// workspace mount. Agents often emit paths like workspace/repo/foo or /workspace/repo/foo;
// joining those naively with /workspace produced /workspace/workspace/repo/foo on read.
func (s *Server) resolveWorkspacePath(rel string) string {
	rel = strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
	if rel == "" || rel == "." {
		return s.workspace
	}

	ws := filepath.Clean(s.workspace)
	cleaned := filepath.Clean(rel)
	if cleaned == ws || strings.HasPrefix(cleaned, ws+string(os.PathSeparator)) {
		return cleaned
	}
	if filepath.IsAbs(cleaned) {
		return cleaned
	}

	trimmed := strings.TrimPrefix(rel, "/")
	for strings.HasPrefix(trimmed, "workspace/") {
		trimmed = strings.TrimPrefix(trimmed, "workspace/")
	}
	return filepath.Join(ws, filepath.Clean("/"+trimmed))
}

func (s *Server) workspaceRelativePath(abs string) string {
	ws := filepath.Clean(s.workspace)
	abs = filepath.Clean(abs)
	if strings.HasPrefix(abs, ws+string(os.PathSeparator)) {
		return strings.TrimPrefix(abs, ws+string(os.PathSeparator))
	}
	return abs
}
