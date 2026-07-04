package store

import (
	"context"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
)

type KubernetesStore struct {
	client    client.Client
	namespace string
}

func NewKubernetesStore(c client.Client, namespace string) *KubernetesStore {
	return &KubernetesStore{client: c, namespace: namespace}
}

func (s *KubernetesStore) Create(ctx context.Context, sandbox *devinv1.Sandbox) error {
	sandbox.Namespace = s.namespace

	err := s.client.Create(ctx, sandbox)
	if apierrors.IsAlreadyExists(err) {
		return ErrAlreadyExists
	}
	return err
}

func (s *KubernetesStore) Get(ctx context.Context, name string) (*devinv1.Sandbox, error) {
	sandbox := &devinv1.Sandbox{}
	err := s.client.Get(ctx, client.ObjectKey{Namespace: s.namespace, Name: name}, sandbox)
	if apierrors.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return sandbox, nil
}

func (s *KubernetesStore) List(ctx context.Context) ([]devinv1.Sandbox, error) {
	list := &devinv1.SandboxList{}
	if err := s.client.List(ctx, list, client.InNamespace(s.namespace)); err != nil {
		return nil, err
	}
	return list.Items, nil
}

func (s *KubernetesStore) Delete(ctx context.Context, name string) error {
	sandbox, err := s.Get(ctx, name)
	if err != nil {
		return err
	}

	if sandbox.DeletionTimestamp == nil {
		sandbox.Status.Phase = devinv1.SandboxPhaseTerminating
		sandbox.Status.Message = "deleting sandbox"
		_ = s.client.Status().Update(ctx, sandbox)
	}

	err = s.client.Delete(ctx, &devinv1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: s.namespace,
		},
	})
	if apierrors.IsNotFound(err) {
		return ErrNotFound
	}
	return err
}

func (s *KubernetesStore) UpdateStatus(ctx context.Context, sandbox *devinv1.Sandbox) error {
	sandbox.Namespace = s.namespace
	err := s.client.Status().Update(ctx, sandbox)
	if apierrors.IsNotFound(err) {
		return ErrNotFound
	}
	return err
}
