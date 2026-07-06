package store

import (
	"context"
	"errors"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
)

var (
	ErrNotFound      = errors.New("sandbox not found")
	ErrAlreadyExists = errors.New("sandbox already exists")
	ErrInvalidHost   = errors.New("invalid firecracker host")
)

type SandboxStore interface {
	Create(ctx context.Context, sandbox *devinv1.Sandbox) error
	Get(ctx context.Context, name string) (*devinv1.Sandbox, error)
	List(ctx context.Context) ([]devinv1.Sandbox, error)
	Delete(ctx context.Context, name string) error
	UpdateStatus(ctx context.Context, sandbox *devinv1.Sandbox) error
}
