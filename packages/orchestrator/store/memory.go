package store

import (
	"context"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
	"github.com/rshdhere/devin/packages/orchestrator/config"
	"github.com/rshdhere/devin/packages/orchestrator/host"
)

type MemoryStore struct {
	mu        sync.RWMutex
	cfg       config.Config
	items     map[string]*devinv1.Sandbox
}

func NewMemoryStore(cfg config.Config) *MemoryStore {
	return &MemoryStore{
		cfg:   cfg,
		items: make(map[string]*devinv1.Sandbox),
	}
}

func (s *MemoryStore) Create(ctx context.Context, sandbox *devinv1.Sandbox) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.items[sandbox.Name]; exists {
		return ErrAlreadyExists
	}

	now := metav1.Now()
	copy := sandbox.DeepCopy()
	copy.Namespace = s.cfg.SandboxNamespace
	copy.CreationTimestamp = now
	copy.Status = devinv1.SandboxStatus{
		Phase:   devinv1.SandboxPhasePending,
		Message: "queued for firecracker provisioning",
	}
	s.items[sandbox.Name] = copy

	go s.simulateProvision(context.Background(), sandbox.Name, copy.Spec)
	return nil
}

func (s *MemoryStore) Get(_ context.Context, name string) (*devinv1.Sandbox, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	item, ok := s.items[name]
	if !ok {
		return nil, ErrNotFound
	}
	return item.DeepCopy(), nil
}

func (s *MemoryStore) List(_ context.Context) ([]devinv1.Sandbox, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	items := make([]devinv1.Sandbox, 0, len(s.items))
	for _, item := range s.items {
		items = append(items, *item.DeepCopy())
	}
	return items, nil
}

func (s *MemoryStore) Delete(_ context.Context, name string) error {
	s.mu.Lock()
	item, ok := s.items[name]
	if !ok {
		s.mu.Unlock()
		return ErrNotFound
	}

	vmID := item.Status.VMID
	delete(s.items, name)
	s.mu.Unlock()

	if vmID != "" {
		_ = host.NewClient(s.cfg.FirecrackerHostURL).DeleteVM(context.Background(), vmID)
	}
	return nil
}

func (s *MemoryStore) UpdateStatus(_ context.Context, sandbox *devinv1.Sandbox) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	item, ok := s.items[sandbox.Name]
	if !ok {
		return ErrNotFound
	}
	item.Status = sandbox.Status
	return nil
}

func (s *MemoryStore) simulateProvision(ctx context.Context, name string, spec devinv1.SandboxSpec) {
	s.setStatus(name, devinv1.SandboxStatus{
		Phase:   devinv1.SandboxPhaseProvisioning,
		Message: "assigning firecracker microVM from warm pool",
	})

	runtime := spec.Runtime
	if runtime == "" {
		runtime = s.cfg.DefaultRuntime
	}

	vm, err := host.NewClient(s.cfg.FirecrackerHostURL).CreateVM(ctx, host.CreateVMRequest{
		Name:    name,
		Runtime: runtime,
		CPU:     spec.CPU,
		Memory:  spec.Memory,
		TaskID:  spec.TaskID,
	})
	if err != nil {
		s.setStatus(name, devinv1.SandboxStatus{
			Phase:   devinv1.SandboxPhaseFailed,
			Message: err.Error(),
		})
		return
	}

	runtimeURL := vm.RuntimeURL
	if runtimeURL == "" {
		runtimeURL = s.cfg.RuntimeFallbackURL
	}

	s.setStatus(name, devinv1.SandboxStatus{
		Phase:       devinv1.SandboxPhaseRunning,
		VMID:        vm.VMID,
		Host:        vm.Host,
		RuntimeURL:  runtimeURL,
		MachineName: name + "-machine",
		Message:     "firecracker microVM ready (dry-run)",
	})
}

func (s *MemoryStore) setStatus(name string, status devinv1.SandboxStatus) {
	time.Sleep(200 * time.Millisecond)

	s.mu.Lock()
	defer s.mu.Unlock()

	item, ok := s.items[name]
	if !ok {
		return
	}
	item.Status = status
}
