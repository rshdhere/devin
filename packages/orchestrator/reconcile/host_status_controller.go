package reconcile

import (
	"context"
	"time"

	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
	"github.com/rshdhere/devin/packages/orchestrator/config"
	"github.com/rshdhere/devin/packages/orchestrator/host"
)

type FirecrackerHostReconciler struct {
	client.Client
	Config config.Config
}

func (r *FirecrackerHostReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var hostCR devinv1.FirecrackerHost
	if err := r.Get(ctx, req.NamespacedName, &hostCR); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if hostCR.Spec.Address == "" {
		hostCR.Status.Message = "spec.address is required"
		if err := r.Status().Update(ctx, &hostCR); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}

	status, err := host.NewClient(hostCR.Spec.Address).Status(ctx)
	if err != nil {
		logger.Error(err, "failed to poll firecracker host", "address", hostCR.Spec.Address)
		hostCR.Status.Message = err.Error()
		if updateErr := r.Status().Update(ctx, &hostCR); updateErr != nil {
			return ctrl.Result{}, updateErr
		}
		return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
	}

	hostCR.Status.CapacityCPU = status.CapacityCPU
	hostCR.Status.UsedCPU = status.UsedCPU
	hostCR.Status.UsedMemory = status.UsedMemory
	hostCR.Status.ReadyVMs = int32(status.ReadyVMs)
	hostCR.Status.ActiveVMs = int32(status.ActiveVMs)
	hostCR.Status.Message = "host status synced"

	if err := r.Status().Update(ctx, &hostCR); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
}

func (r *FirecrackerHostReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&devinv1.FirecrackerHost{}).
		Complete(r)
}
