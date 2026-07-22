package reconcile

import (
	"context"
	"fmt"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/util/retry"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
	"github.com/rshdhere/devin/packages/orchestrator/config"
)

const sandboxFinalizer = "sandbox.devin.baby/finalizer"

type SandboxReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config config.Config
}

func (r *SandboxReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var sandbox devinv1.Sandbox
	if err := r.Get(ctx, req.NamespacedName, &sandbox); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !sandbox.DeletionTimestamp.IsZero() {
		return r.finalize(ctx, &sandbox)
	}

	if !controllerutil.ContainsFinalizer(&sandbox, sandboxFinalizer) {
		controllerutil.AddFinalizer(&sandbox, sandboxFinalizer)
		if err := r.Update(ctx, &sandbox); err != nil {
			if apierrors.IsConflict(err) {
				return ctrl.Result{Requeue: true}, nil
			}
			return ctrl.Result{}, err
		}
	}

	if sandbox.Spec.Runtime == "" {
		sandbox.Spec.Runtime = r.Config.DefaultRuntime
	}

	if err := r.ensureMachine(ctx, &sandbox); err != nil {
		// Concurrent status writers (machine ↔ sandbox) race often; never mark
		// the sandbox Failed for a conflict — just retry.
		if apierrors.IsConflict(err) {
			return ctrl.Result{Requeue: true}, nil
		}
		return r.fail(ctx, &sandbox, err)
	}

	if sandbox.Status.Phase == devinv1.SandboxPhaseRunning {
		return ctrl.Result{}, nil
	}

	if sandbox.Status.Phase == devinv1.SandboxPhaseFailed {
		return ctrl.Result{}, nil
	}

	message := firstNonEmpty(sandbox.Status.Message, "provisioning firecracker microVM")
	return r.writeStatus(ctx, &sandbox, devinv1.SandboxPhaseProvisioning, message)
}

func (r *SandboxReconciler) ensureMachine(ctx context.Context, sandbox *devinv1.Sandbox) error {
	machine := &devinv1.FirecrackerMachine{
		ObjectMeta: metav1.ObjectMeta{
			Name:      machineNameForSandbox(sandbox.Name),
			Namespace: sandbox.Namespace,
		},
	}

	op, err := controllerutil.CreateOrUpdate(ctx, r.Client, machine, func() error {
		if err := controllerutil.SetControllerReference(sandbox, machine, r.Scheme); err != nil {
			return err
		}
		machine.Spec = devinv1.FirecrackerMachineSpec{
			SandboxName:   sandbox.Name,
			TaskID:        sandbox.Spec.TaskID,
			Runtime:       sandbox.Spec.Runtime,
			CPU:           sandbox.Spec.CPU,
			Memory:        sandbox.Spec.Memory,
			PreferredHost: sandbox.Spec.PreferredHost,
		}
		return nil
	})
	if err != nil {
		return err
	}
	_ = op

	latestMachine := &devinv1.FirecrackerMachine{}
	if err := r.Get(ctx, client.ObjectKeyFromObject(machine), latestMachine); err != nil {
		return err
	}

	if latestMachine.Status.Phase == devinv1.MachinePhaseRunning {
		return r.patchSandboxFromMachine(ctx, sandbox.Name, sandbox.Namespace, latestMachine, devinv1.SandboxPhaseRunning)
	}

	if latestMachine.Status.Phase == devinv1.MachinePhaseFailed {
		return fmt.Errorf("%s", firstNonEmpty(latestMachine.Status.Message, "firecracker machine failed"))
	}

	return r.patchSandboxFromMachine(ctx, sandbox.Name, sandbox.Namespace, latestMachine, devinv1.SandboxPhaseProvisioning)
}

func (r *SandboxReconciler) patchSandboxFromMachine(
	ctx context.Context,
	name, namespace string,
	machine *devinv1.FirecrackerMachine,
	phase devinv1.SandboxPhase,
) error {
	return retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		latest := &devinv1.Sandbox{}
		if err := r.Get(ctx, client.ObjectKey{Namespace: namespace, Name: name}, latest); err != nil {
			return err
		}
		latest.Status.Phase = phase
		latest.Status.VMID = machine.Status.VMID
		latest.Status.Host = machine.Status.Host
		latest.Status.RuntimeURL = machine.Status.RuntimeURL
		latest.Status.MachineName = machine.Name
		latest.Status.Message = firstNonEmpty(machine.Status.Message, latest.Status.Message)
		if phase == devinv1.SandboxPhaseProvisioning && latest.Status.Message == "" {
			latest.Status.Message = "provisioning firecracker microVM"
		}
		return r.Status().Update(ctx, latest)
	})
}

func (r *SandboxReconciler) finalize(ctx context.Context, sandbox *devinv1.Sandbox) (ctrl.Result, error) {
	if controllerutil.ContainsFinalizer(sandbox, sandboxFinalizer) {
		machine := &devinv1.FirecrackerMachine{
			ObjectMeta: metav1.ObjectMeta{
				Name:      machineNameForSandbox(sandbox.Name),
				Namespace: sandbox.Namespace,
			},
		}
		if err := r.Delete(ctx, machine); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{RequeueAfter: 5 * time.Second}, err
		}

		controllerutil.RemoveFinalizer(sandbox, sandboxFinalizer)
		if err := r.Update(ctx, sandbox); err != nil {
			if apierrors.IsConflict(err) {
				return ctrl.Result{Requeue: true}, nil
			}
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{}, nil
}

func (r *SandboxReconciler) fail(ctx context.Context, sandbox *devinv1.Sandbox, err error) (ctrl.Result, error) {
	_, _ = r.writeStatus(ctx, sandbox, devinv1.SandboxPhaseFailed, err.Error())
	return ctrl.Result{RequeueAfter: 30 * time.Second}, err
}

func (r *SandboxReconciler) writeStatus(
	ctx context.Context,
	sandbox *devinv1.Sandbox,
	phase devinv1.SandboxPhase,
	message string,
) (ctrl.Result, error) {
	err := retry.RetryOnConflict(retry.DefaultBackoff, func() error {
		latest := &devinv1.Sandbox{}
		if err := r.Get(ctx, client.ObjectKeyFromObject(sandbox), latest); err != nil {
			return err
		}

		latest.Status.Phase = phase
		latest.Status.Message = message
		return r.Status().Update(ctx, latest)
	})
	if err != nil {
		return ctrl.Result{}, err
	}

	if phase == devinv1.SandboxPhasePending || phase == devinv1.SandboxPhaseProvisioning {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}

	return ctrl.Result{}, nil
}

func (r *SandboxReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&devinv1.Sandbox{}).
		Owns(&devinv1.FirecrackerMachine{}).
		Complete(r)
}
