package store

import (
	"context"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
)

const externalHostFinalizer = "firecracker.devin.baby/external-host"

type HostStore interface {
	Upsert(ctx context.Context, host *devinv1.FirecrackerHost) error
}

type KubernetesHostStore struct {
	client    client.Client
	namespace string
}

func NewKubernetesHostStore(c client.Client, namespace string) *KubernetesHostStore {
	return &KubernetesHostStore{client: c, namespace: namespace}
}

func (s *KubernetesHostStore) Upsert(ctx context.Context, host *devinv1.FirecrackerHost) error {
	if host == nil {
		return ErrInvalidHost
	}
	name := host.Name
	if name == "" {
		return ErrInvalidHost
	}

	hostCR := &devinv1.FirecrackerHost{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: s.namespace,
		},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, s.client, hostCR, func() error {
		if !controllerutil.ContainsFinalizer(hostCR, externalHostFinalizer) {
			controllerutil.AddFinalizer(hostCR, externalHostFinalizer)
		}
		hostCR.Labels = mergeStringMaps(hostCR.Labels, host.Labels, map[string]string{
			"devin.baby/managed-by": "orchestrator",
		})
		hostCR.Spec = host.Spec
		return nil
	})
	if apierrors.IsNotFound(err) {
		return err
	}
	return err
}

func mergeStringMaps(base map[string]string, layers ...map[string]string) map[string]string {
	out := make(map[string]string)
	for key, value := range base {
		out[key] = value
	}
	for _, layer := range layers {
		for key, value := range layer {
			if value == "" {
				continue
			}
			out[key] = value
		}
	}
	return out
}
