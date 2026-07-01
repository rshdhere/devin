package agent

import (
	"context"
	"time"

	"github.com/rshdhere/devin/apps/runtime/internal/events"
)

type RunRequest struct {
	TaskID  string
	Prompt  string
	Agent   string
	WorkDir string
	Env     map[string]string
}

type RunResult struct {
	Status  string
	Message string
	Output  string
	Agent   string
}

type Runner interface {
	Name() string
	Run(ctx context.Context, req RunRequest, publish func(eventType, message string, data map[string]any)) (*RunResult, error)
}

type Service struct {
	cfg     Config
	runners map[string]Runner
}

func NewService(cfg Config) *Service {
	s := &Service{
		cfg:     cfg,
		runners: make(map[string]Runner),
	}
	s.runners["cursor"] = &CursorRunner{cfg: cfg}
	s.runners["claude"] = &ClaudeRunner{cfg: cfg}
	s.runners["mock"] = &MockRunner{cfg: cfg}
	return s
}

func (s *Service) Run(ctx context.Context, req RunRequest, bus *events.Bus) (*RunResult, error) {
	provider := req.Agent
	if provider == "" {
		provider = s.cfg.Provider
	}
	if provider == "" {
		provider = "mock"
	}

	runner, ok := s.runners[provider]
	if !ok {
		return &RunResult{
			Status:  "failed",
			Message: "unknown agent provider: " + provider,
			Agent:   provider,
		}, nil
	}

	publish := func(eventType, message string, data map[string]any) {
		bus.Publish(req.TaskID, eventType, message, data)
	}

	publish("agent.started", runner.Name()+" agent started", map[string]any{
		"agent": runner.Name(),
	})

	runCtx, cancel := context.WithTimeout(ctx, s.runTimeoutFor(req))
	defer cancel()

	result, err := runner.Run(runCtx, req, publish)
	if err != nil {
		publish("agent.failed", err.Error(), nil)
		return &RunResult{
			Status:  "failed",
			Message: err.Error(),
			Agent:   runner.Name(),
		}, nil
	}

	if result.Status == "failed" {
		publish("agent.failed", result.Message, map[string]any{"output": result.Output})
	} else {
		publish("agent.completed", result.Message, map[string]any{"output": result.Output})
	}

	return result, nil
}

func (s *Service) runTimeoutFor(req RunRequest) time.Duration {
	timeout := s.cfg.RunTimeoutMin
	if raw := envValue(req, "AGENT_RUN_TIMEOUT_MIN"); raw != "" {
		if value, err := parseInt(raw); err == nil && value > 0 {
			timeout = value
		}
	}
	return time.Duration(timeout) * time.Minute
}

func (s *Service) RunTimeout(req RunRequest) time.Duration {
	return s.runTimeoutFor(req)
}
