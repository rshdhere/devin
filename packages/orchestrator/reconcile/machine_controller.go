package reconcile

import (
	"context"
	"fmt"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
	"github.com/rshdhere/devin/packages/orchestrator/config"
	"github.com/rshdhere/devin/packages/orchestrator/host"
)

const machineFinalizer = "firecracker.devin.baby/finalizer"

type FirecrackerMachineReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	Config config.Config
}

func (r *FirecrackerMachineReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var machine devinv1.FirecrackerMachine
	if err := r.Get(ctx, req.NamespacedName, &machine); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	if !machine.DeletionTimestamp.IsZero() {
		return r.finalize(ctx, &machine)
	}

	if !controllerutil.ContainsFinalizer(&machine, machineFinalizer) {
		controllerutil.AddFinalizer(&machine, machineFinalizer)
		if err := r.Update(ctx, &machine); err != nil {
			return ctrl.Result{}, err
		}
	}

	if machine.Status.Phase == devinv1.MachinePhaseRunning && machine.Status.RuntimeURL != "" {
		if err := r.syncSandboxStatus(ctx, &machine); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	if machine.Status.VMID != "" {
		return r.refreshVM(ctx, &machine)
	}

	return r.provisionVM(ctx, &machine)
}

func (r *FirecrackerMachineReconciler) provisionVM(ctx context.Context, machine *devinv1.FirecrackerMachine) (ctrl.Result, error) {
	selectedHost, err := selectFirecrackerHost(ctx, r.Client, r.Config.FirecrackerNamespace, machine.Spec.CPU, firstNonEmpty(machine.Spec.PreferredHost, machine.Spec.Host))
	if err != nil {
		if isRetryableProvisionError(err) {
			if syncErr := r.syncSandboxCapacityWait(ctx, machine, err.Error()); syncErr != nil {
				return ctrl.Result{}, syncErr
			}
			return ctrl.Result{RequeueAfter: 15 * time.Second}, nil
		}
		return r.fail(ctx, machine, err)
	}

	hostClient := host.NewClient(selectedHost.Spec.Address)
	vm, err := hostClient.CreateVM(ctx, host.CreateVMRequest{
		Name:    machine.Name,
		Runtime: machine.Spec.Runtime,
		CPU:     machine.Spec.CPU,
		Memory:  machine.Spec.Memory,
		TaskID:  machine.Spec.TaskID,
	})
	if err != nil {
		return r.fail(ctx, machine, err)
	}

	phase := devinv1.MachinePhaseProvisioning
	message := firstNonEmpty(vm.Message, "provisioning firecracker microVM")
	if vm.Phase == "Running" && vm.RuntimeURL != "" {
		phase = devinv1.MachinePhaseRunning
		message = "firecracker microVM ready"
	}
	if vm.Phase == "Failed" {
		return r.fail(ctx, machine, fmt.Errorf("%s", firstNonEmpty(vm.Message, "microVM provisioning failed")))
	}

	machine.Status = devinv1.FirecrackerMachineStatus{
		Phase:      phase,
		VMID:       vm.VMID,
		Host:       firstNonEmpty(vm.Host, selectedHost.Name),
		RuntimeURL: vm.RuntimeURL,
		Message:    message,
	}
	machine.Spec.Host = machine.Status.Host

	if err := r.Status().Update(ctx, machine); err != nil {
		return ctrl.Result{}, err
	}

	if phase == devinv1.MachinePhaseRunning {
		if err := r.syncSandboxStatus(ctx, machine); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	if err := r.syncSandboxProvisioning(ctx, machine); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{RequeueAfter: 3 * time.Second}, nil
}

func (r *FirecrackerMachineReconciler) refreshVM(ctx context.Context, machine *devinv1.FirecrackerMachine) (ctrl.Result, error) {
	hostCR, err := r.lookupHost(ctx, machine.Status.Host)
	if err != nil {
		return r.fail(ctx, machine, err)
	}

	hostClient := host.NewClient(hostCR.Spec.Address)
	vm, err := hostClient.GetVM(ctx, machine.Status.VMID)
	if err != nil {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, err
	}

	if vm.Phase == "Running" && vm.RuntimeURL != "" {
		machine.Status.Phase = devinv1.MachinePhaseRunning
		machine.Status.RuntimeURL = vm.RuntimeURL
		machine.Status.Message = "firecracker microVM running"
		if err := r.Status().Update(ctx, machine); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.syncSandboxStatus(ctx, machine); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}

	if vm.Phase == "Failed" {
		return r.fail(ctx, machine, fmt.Errorf("%s", firstNonEmpty(vm.Message, "microVM provisioning failed")))
	}

	return r.writeMachineStatus(ctx, machine, devinv1.MachinePhaseProvisioning, firstNonEmpty(vm.Message, "waiting for microVM health"))
}

func (r *FirecrackerMachineReconciler) finalize(ctx context.Context, machine *devinv1.FirecrackerMachine) (ctrl.Result, error) {
	if controllerutil.ContainsFinalizer(machine, machineFinalizer) {
		if machine.Status.VMID != "" {
			hostCR, err := r.lookupHost(ctx, machine.Status.Host)
			if err == nil {
				_ = host.NewClient(hostCR.Spec.Address).DeleteVM(ctx, machine.Status.VMID)
			}
		}

		controllerutil.RemoveFinalizer(machine, machineFinalizer)
		if err := r.Update(ctx, machine); err != nil {
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{}, nil
}

func (r *FirecrackerMachineReconciler) syncSandboxProvisioning(ctx context.Context, machine *devinv1.FirecrackerMachine) error {
	sandbox := &devinv1.Sandbox{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: machine.Namespace, Name: machine.Spec.SandboxName}, sandbox); err != nil {
		return client.IgnoreNotFound(err)
	}

	sandbox.Status.Phase = devinv1.SandboxPhaseProvisioning
	sandbox.Status.VMID = machine.Status.VMID
	sandbox.Status.Host = machine.Status.Host
	sandbox.Status.MachineName = machine.Name
	sandbox.Status.Message = machine.Status.Message

	return r.Status().Update(ctx, sandbox)
}

func (r *FirecrackerMachineReconciler) syncSandboxStatus(ctx context.Context, machine *devinv1.FirecrackerMachine) error {
	sandbox := &devinv1.Sandbox{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: machine.Namespace, Name: machine.Spec.SandboxName}, sandbox); err != nil {
		return client.IgnoreNotFound(err)
	}

	sandbox.Status.Phase = devinv1.SandboxPhaseRunning
	sandbox.Status.VMID = machine.Status.VMID
	sandbox.Status.Host = machine.Status.Host
	sandbox.Status.RuntimeURL = machine.Status.RuntimeURL
	sandbox.Status.MachineName = machine.Name
	sandbox.Status.Message = machine.Status.Message

	return r.Status().Update(ctx, sandbox)
}

func (r *FirecrackerMachineReconciler) lookupHost(ctx context.Context, hostName string) (*devinv1.FirecrackerHost, error) {
	hostCR := &devinv1.FirecrackerHost{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: r.Config.FirecrackerNamespace, Name: hostName}, hostCR); err != nil {
		return nil, err
	}
	return hostCR, nil
}

func (r *FirecrackerMachineReconciler) fail(ctx context.Context, machine *devinv1.FirecrackerMachine, err error) (ctrl.Result, error) {
	_, _ = r.writeMachineStatus(ctx, machine, devinv1.MachinePhaseFailed, err.Error())
	if syncErr := r.syncSandboxFailed(ctx, machine, err.Error()); syncErr != nil {
		return ctrl.Result{}, syncErr
	}
	return ctrl.Result{RequeueAfter: 30 * time.Second}, err
}

func (r *FirecrackerMachineReconciler) syncSandboxFailed(ctx context.Context, machine *devinv1.FirecrackerMachine, message string) error {
	sandbox := &devinv1.Sandbox{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: machine.Namespace, Name: machine.Spec.SandboxName}, sandbox); err != nil {
		return client.IgnoreNotFound(err)
	}
	sandbox.Status.Phase = devinv1.SandboxPhaseFailed
	sandbox.Status.Message = message
	return r.Status().Update(ctx, sandbox)
}

func (r *FirecrackerMachineReconciler) syncSandboxCapacityWait(ctx context.Context, machine *devinv1.FirecrackerMachine, message string) error {
	sandbox := &devinv1.Sandbox{}
	if err := r.Get(ctx, client.ObjectKey{Namespace: machine.Namespace, Name: machine.Spec.SandboxName}, sandbox); err != nil {
		return client.IgnoreNotFound(err)
	}
	sandbox.Status.Phase = devinv1.SandboxPhaseProvisioning
	sandbox.Status.MachineName = machine.Name
	sandbox.Status.Message = message
	return r.Status().Update(ctx, sandbox)
}

func isRetryableProvisionError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "lacks capacity") ||
		strings.Contains(message, "not found") && strings.Contains(message, "firecracker host")
}

func (r *FirecrackerMachineReconciler) writeMachineStatus(
	ctx context.Context,
	machine *devinv1.FirecrackerMachine,
	phase devinv1.FirecrackerMachinePhase,
	message string,
) (ctrl.Result, error) {
	machine.Status.Phase = phase
	machine.Status.Message = message
	if err := r.Status().Update(ctx, machine); err != nil {
		return ctrl.Result{}, err
	}
	if phase == devinv1.MachinePhaseProvisioning || phase == devinv1.MachinePhasePending {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}
	return ctrl.Result{}, nil
}

func (r *FirecrackerMachineReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&devinv1.FirecrackerMachine{}).
		Complete(r)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func machineNameForSandbox(sandboxName string) string {
	return fmt.Sprintf("%s-machine", sandboxName)
}
