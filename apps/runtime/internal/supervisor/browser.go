package supervisor

import (
	"encoding/json"
	"net/http"
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
