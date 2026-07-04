package v1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

type SandboxPhase string

const (
	SandboxPhasePending      SandboxPhase = "Pending"
	SandboxPhaseProvisioning SandboxPhase = "Provisioning"
	SandboxPhaseRunning      SandboxPhase = "Running"
	SandboxPhaseFailed       SandboxPhase = "Failed"
	SandboxPhaseTerminating  SandboxPhase = "Terminating"
	SandboxPhaseTerminated   SandboxPhase = "Terminated"
	SandboxPhaseSuspended    SandboxPhase = "Suspended"
	SandboxPhaseWaking       SandboxPhase = "Waking"
)

type SandboxSpec struct {
	TaskID         string `json:"taskId,omitempty"`
	Runtime        string `json:"runtime"`
	CPU            int32  `json:"cpu"`
	Memory         string `json:"memory"`
	PreferredHost  string `json:"preferredHost,omitempty"`
	// Image is deprecated; use Runtime to select a snapshot-backed runtime image.
	Image string `json:"image,omitempty"`
}

type SandboxStatus struct {
	Phase       SandboxPhase `json:"phase,omitempty"`
	VMID        string       `json:"vmId,omitempty"`
	Host        string       `json:"host,omitempty"`
	RuntimeURL  string       `json:"runtimeURL,omitempty"`
	MachineName string       `json:"machineName,omitempty"`
	Message     string       `json:"message,omitempty"`
}

type Sandbox struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   SandboxSpec   `json:"spec,omitempty"`
	Status SandboxStatus `json:"status,omitempty"`
}

type SandboxList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Sandbox `json:"items"`
}

func (in *Sandbox) DeepCopyInto(out *Sandbox) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	out.Spec = in.Spec
	out.Status = in.Status
}

func (in *Sandbox) DeepCopy() *Sandbox {
	if in == nil {
		return nil
	}
	out := new(Sandbox)
	in.DeepCopyInto(out)
	return out
}

func (in *Sandbox) DeepCopyObject() runtime.Object {
	return in.DeepCopy()
}

func (in *SandboxList) DeepCopyInto(out *SandboxList) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]Sandbox, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}

func (in *SandboxList) DeepCopy() *SandboxList {
	if in == nil {
		return nil
	}
	out := new(SandboxList)
	in.DeepCopyInto(out)
	return out
}

func (in *SandboxList) DeepCopyObject() runtime.Object {
	return in.DeepCopy()
}
