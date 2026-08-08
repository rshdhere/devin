package supervisor

import "testing"

func TestResolveWorkspacePath(t *testing.T) {
	s := &Server{workspace: "/workspace"}

	cases := []struct {
		in  string
		out string
	}{
		{"repo/app.py", "/workspace/repo/app.py"},
		{"/workspace/repo/app.py", "/workspace/repo/app.py"},
		{"workspace/repo/app.py", "/workspace/repo/app.py"},
		{"workspace/workspace/repo/app.py", "/workspace/repo/app.py"},
		{"/workspace/workspace/repo/app.py", "/workspace/workspace/repo/app.py"},
	}

	for _, tc := range cases {
		got := s.resolveWorkspacePath(tc.in)
		if got != tc.out {
			t.Errorf("resolveWorkspacePath(%q) = %q, want %q", tc.in, got, tc.out)
		}
	}
}
