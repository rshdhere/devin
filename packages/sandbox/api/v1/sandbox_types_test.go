package v1

import (
	"encoding/json"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestSandboxJSONEncodesMetadataName(t *testing.T) {
	t.Parallel()

	sandbox := Sandbox{
		TypeMeta: metav1.TypeMeta{
			APIVersion: GroupVersion.String(),
			Kind:       "Sandbox",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      "sbx-test",
			Namespace: "devin-staging",
		},
		Spec: SandboxSpec{
			TaskID:  "task-1",
			Runtime: "nextjs",
			CPU:     2,
			Memory:  "4Gi",
		},
	}

	raw, err := json.Marshal(sandbox)
	if err != nil {
		t.Fatalf("marshal sandbox: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal sandbox json: %v", err)
	}

	metadata, ok := decoded["metadata"].(map[string]any)
	if !ok {
		t.Fatalf("expected metadata object in json, got %#v", decoded)
	}
	if metadata["name"] != "sbx-test" {
		t.Fatalf("expected metadata.name=sbx-test, got %#v", metadata["name"])
	}
	if metadata["namespace"] != "devin-staging" {
		t.Fatalf("expected metadata.namespace=devin-staging, got %#v", metadata["namespace"])
	}
}
