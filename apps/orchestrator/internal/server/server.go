package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
	"github.com/rshdhere/devin/packages/orchestrator/store"
)

// InternalServer exposes sandbox lifecycle endpoints for the scheduler only.
type InternalServer struct {
	store     store.SandboxStore
	hostStore store.HostStore
	namespace string
}

func NewInternal(sandboxStore store.SandboxStore, hostStore store.HostStore, namespace string) *InternalServer {
	return &InternalServer{store: sandboxStore, hostStore: hostStore, namespace: namespace}
}

func (s *InternalServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /internal/v1/sandboxes", s.handleListSandboxes)
	mux.HandleFunc("POST /internal/v1/sandboxes", s.handleCreateSandbox)
	mux.HandleFunc("GET /internal/v1/sandboxes/{name}", s.handleGetSandbox)
	mux.HandleFunc("DELETE /internal/v1/sandboxes/{name}", s.handleDeleteSandbox)
	mux.HandleFunc("POST /internal/v1/sandboxes/{name}/suspend", s.handleSuspendSandbox)
	mux.HandleFunc("POST /internal/v1/sandboxes/{name}/wake", s.handleWakeSandbox)
	mux.HandleFunc("GET /internal/v1/firecracker-hosts", s.handleListFirecrackerHosts)
	mux.HandleFunc("GET /internal/v1/firecracker-hosts/{name}", s.handleGetFirecrackerHost)
	mux.HandleFunc("PUT /internal/v1/firecracker-hosts/{name}", s.handleUpsertFirecrackerHost)
	return mux
}

func (s *InternalServer) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

type createSandboxRequest struct {
	Name string              `json:"name"`
	Spec devinv1.SandboxSpec `json:"spec"`
}

func (s *InternalServer) handleCreateSandbox(w http.ResponseWriter, r *http.Request) {
	var req createSandboxRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Spec.TaskID == "" {
		writeError(w, http.StatusBadRequest, "spec.taskId is required")
		return
	}
	if req.Spec.Runtime == "" {
		if req.Spec.Image != "" {
			req.Spec.Runtime = req.Spec.Image
		} else {
			req.Spec.Runtime = "nextjs"
		}
	}
	if req.Spec.CPU == 0 {
		req.Spec.CPU = 1
	}
	if req.Spec.Memory == "" {
		req.Spec.Memory = "1Gi"
	}

	sandbox := &devinv1.Sandbox{
		TypeMeta: metav1.TypeMeta{
			APIVersion: devinv1.GroupVersion.String(),
			Kind:       "Sandbox",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      req.Name,
			Namespace: s.namespace,
			Labels: map[string]string{
				"devin.baby/task-id": req.Spec.TaskID,
			},
		},
		Spec: req.Spec,
	}

	if err := s.store.Create(r.Context(), sandbox); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			writeError(w, http.StatusConflict, "sandbox already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	created, _ := s.store.Get(r.Context(), req.Name)
	writeJSON(w, http.StatusAccepted, created)
}

func (s *InternalServer) handleGetSandbox(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	sandbox, err := s.store.Get(r.Context(), name)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "sandbox not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sandbox)
}

func (s *InternalServer) handleListSandboxes(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *InternalServer) handleDeleteSandbox(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.store.Delete(r.Context(), name); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "sandbox not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"name": name,
		"status": devinv1.SandboxStatus{
			Phase:   devinv1.SandboxPhaseTerminating,
			Message: "sandbox deleted",
		},
	})
}

func (s *InternalServer) handleSuspendSandbox(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	sandbox, err := s.store.Get(r.Context(), name)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "sandbox not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if sandbox.Status.Phase == devinv1.SandboxPhaseSuspended {
		writeJSON(w, http.StatusOK, sandbox)
		return
	}

	sandbox.Status.Phase = devinv1.SandboxPhaseSuspended
	sandbox.Status.Message = "sandbox suspended (idle sleep)"
	if err := s.store.UpdateStatus(r.Context(), sandbox); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, sandbox)
}

func (s *InternalServer) handleWakeSandbox(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	sandbox, err := s.store.Get(r.Context(), name)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "sandbox not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if sandbox.Status.Phase == devinv1.SandboxPhaseRunning {
		writeJSON(w, http.StatusOK, sandbox)
		return
	}

	sandbox.Status.Phase = devinv1.SandboxPhaseWaking
	sandbox.Status.Message = "waking sandbox from idle sleep"
	if err := s.store.UpdateStatus(r.Context(), sandbox); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	sandbox.Status.Phase = devinv1.SandboxPhaseRunning
	sandbox.Status.Message = "sandbox running"
	if err := s.store.UpdateStatus(r.Context(), sandbox); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, sandbox)
}

type upsertFirecrackerHostRequest struct {
	Spec devinv1.FirecrackerHostSpec `json:"spec"`
}

func (s *InternalServer) handleUpsertFirecrackerHost(w http.ResponseWriter, r *http.Request) {
	if s.hostStore == nil {
		writeError(w, http.StatusServiceUnavailable, "firecracker host registry is unavailable")
		return
	}

	name := strings.TrimSpace(r.PathValue("name"))
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	var req upsertFirecrackerHostRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if strings.TrimSpace(req.Spec.Address) == "" {
		writeError(w, http.StatusBadRequest, "spec.address is required")
		return
	}
	if req.Spec.Capacity.CPU <= 0 {
		req.Spec.Capacity.CPU = 8
	}
	if strings.TrimSpace(req.Spec.Capacity.Memory) == "" {
		req.Spec.Capacity.Memory = "16Gi"
	}

	host := &devinv1.FirecrackerHost{
		ObjectMeta: metav1.ObjectMeta{
			Name: name,
			Labels: map[string]string{
				"devin.baby/managed-by": "scheduler",
			},
		},
		Spec: req.Spec,
	}

	if err := s.hostStore.Upsert(r.Context(), host); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"name": name,
		"spec": host.Spec,
	})
}

func (s *InternalServer) handleGetFirecrackerHost(w http.ResponseWriter, r *http.Request) {
	if s.hostStore == nil {
		writeError(w, http.StatusServiceUnavailable, "firecracker host registry is unavailable")
		return
	}

	name := strings.TrimSpace(r.PathValue("name"))
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}

	host, err := s.hostStore.Get(r.Context(), name)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "firecracker host not found")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"name": host.Name,
		"spec": host.Spec,
		"status": host.Status,
	})
}

func (s *InternalServer) handleListFirecrackerHosts(w http.ResponseWriter, r *http.Request) {
	if s.hostStore == nil {
		writeError(w, http.StatusServiceUnavailable, "firecracker host registry is unavailable")
		return
	}

	hosts, err := s.hostStore.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	items := make([]map[string]any, 0, len(hosts))
	for _, host := range hosts {
		items = append(items, map[string]any{
			"name":   host.Name,
			"spec":   host.Spec,
			"status": host.Status,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"items": items,
	})
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
