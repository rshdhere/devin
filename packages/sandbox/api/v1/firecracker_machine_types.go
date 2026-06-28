package v1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

type FirecrackerMachinePhase string

const (
	MachinePhasePending      FirecrackerMachinePhase = "Pending"
	MachinePhaseProvisioning FirecrackerMachinePhase = "Provisioning"
	MachinePhaseRunning      FirecrackerMachinePhase = "Running"
	MachinePhaseFailed       FirecrackerMachinePhase = "Failed"
	MachinePhaseTerminating  FirecrackerMachinePhase = "Terminating"
	MachinePhaseTerminated   FirecrackerMachinePhase = "Terminated"
)

type FirecrackerMachineSpec struct {
	SandboxName    string `json:"sandboxName"`
	TaskID         string `json:"taskId,omitempty"`
	Runtime        string `json:"runtime"`
	CPU            int32  `json:"cpu"`
	Memory         string `json:"memory"`
	Host           string `json:"host,omitempty"`
	PreferredHost  string `json:"preferredHost,omitempty"`
}

type FirecrackerMachineStatus struct {
	Phase      FirecrackerMachinePhase `json:"phase,omitempty"`
	VMID       string                  `json:"vmId,omitempty"`
	Host       string                  `json:"host,omitempty"`
	RuntimeURL string                  `json:"runtimeURL,omitempty"`
	Message    string                  `json:"message,omitempty"`
}

type FirecrackerMachine struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   FirecrackerMachineSpec   `json:"spec,omitempty"`
	Status FirecrackerMachineStatus `json:"status,omitempty"`
}

type FirecrackerMachineList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []FirecrackerMachine `json:"items"`
}

func (in *FirecrackerMachine) DeepCopyInto(out *FirecrackerMachine) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	out.Spec = in.Spec
	out.Status = in.Status
}

func (in *FirecrackerMachine) DeepCopy() *FirecrackerMachine {
	if in == nil {
		return nil
	}
	out := new(FirecrackerMachine)
	in.DeepCopyInto(out)
	return out
}

func (in *FirecrackerMachine) DeepCopyObject() runtime.Object {
	return in.DeepCopy()
}

func (in *FirecrackerMachineList) DeepCopyInto(out *FirecrackerMachineList) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]FirecrackerMachine, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}

func (in *FirecrackerMachineList) DeepCopy() *FirecrackerMachineList {
	if in == nil {
		return nil
	}
	out := new(FirecrackerMachineList)
	in.DeepCopyInto(out)
	return out
}

func (in *FirecrackerMachineList) DeepCopyObject() runtime.Object {
	return in.DeepCopy()
}
