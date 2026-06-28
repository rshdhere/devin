package v1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

type HostCapacity struct {
	CPU    int32  `json:"cpu"`
	Memory string `json:"memory"`
}

type FirecrackerHostSpec struct {
	Address           string       `json:"address"`
	Capacity          HostCapacity `json:"capacity"`
	NodeName          string       `json:"nodeName,omitempty"`
	SchedulerAddress  string       `json:"schedulerAddress,omitempty"`
}

type FirecrackerHostStatus struct {
	UsedCPU    int32  `json:"usedCPU,omitempty"`
	UsedMemory string `json:"usedMemory,omitempty"`
	ReadyVMs   int32  `json:"readyVMs,omitempty"`
	Message    string `json:"message,omitempty"`
}

type FirecrackerHost struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   FirecrackerHostSpec   `json:"spec,omitempty"`
	Status FirecrackerHostStatus `json:"status,omitempty"`
}

type FirecrackerHostList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []FirecrackerHost `json:"items"`
}

func (in *FirecrackerHost) DeepCopyInto(out *FirecrackerHost) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	out.Spec = in.Spec
	out.Status = in.Status
}

func (in *FirecrackerHost) DeepCopy() *FirecrackerHost {
	if in == nil {
		return nil
	}
	out := new(FirecrackerHost)
	in.DeepCopyInto(out)
	return out
}

func (in *FirecrackerHost) DeepCopyObject() runtime.Object {
	return in.DeepCopy()
}

func (in *FirecrackerHostList) DeepCopyInto(out *FirecrackerHostList) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]FirecrackerHost, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}

func (in *FirecrackerHostList) DeepCopy() *FirecrackerHostList {
	if in == nil {
		return nil
	}
	out := new(FirecrackerHostList)
	in.DeepCopyInto(out)
	return out
}

func (in *FirecrackerHostList) DeepCopyObject() runtime.Object {
	return in.DeepCopy()
}
