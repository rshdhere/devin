package server

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/rshdhere/devin/apps/firecracker/internal/pool"
)

type Server struct {
	pool *pool.Manager
}

func New(poolManager *pool.Manager) *Server {
	return &Server{pool: poolManager}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /v1/pool", s.handlePool)
	mux.HandleFunc("GET /v1/status", s.handleStatus)
	mux.HandleFunc("GET /v1/vms", s.handleListVMs)
	mux.HandleFunc("POST /v1/vms", s.handleCreateVM)
	mux.HandleFunc("GET /v1/vms/{id}", s.handleGetVM)
	mux.HandleFunc("DELETE /v1/vms/{id}", s.handleDeleteVM)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "ok",
		"readyVMs": s.pool.ReadyVMs(),
	})
}

func (s *Server) handlePool(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"readyVMs": s.pool.ReadyVMs(),
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.pool.Status())
}

func (s *Server) handleListVMs(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"items": s.pool.List(),
	})
}

type createVMRequest struct {
	Name     string `json:"name"`
	Runtime  string `json:"runtime"`
	CPU      int32  `json:"cpu"`
	Memory   string `json:"memory"`
	TaskID   string `json:"taskId"`
	Snapshot string `json:"snapshot"`
}

func (s *Server) handleCreateVM(w http.ResponseWriter, r *http.Request) {
	var req createVMRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	vm, err := s.pool.Create(req.Name, req.Runtime, req.TaskID, req.CPU, req.Memory)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusAccepted, vm)
}

func (s *Server) handleGetVM(w http.ResponseWriter, r *http.Request) {
	vm, err := s.pool.Get(r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, vm)
}

func (s *Server) handleDeleteVM(w http.ResponseWriter, r *http.Request) {
	if err := s.pool.Delete(r.PathValue("id")); err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "deleted"})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{
		"error":     message,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func PortFromEnv(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}
