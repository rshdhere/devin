package executil

import "strings"

// GuestCommandEnv merges base guest env with overrides without inheriting a broken
// host os.Environ (Firecracker guests often have HOME="" on a read-only rootfs).
func GuestCommandEnv(base []string, overrides []string) []string {
	envMap := make(map[string]string)
	order := make([]string, 0, 16)
	add := func(entry string) {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			return
		}
		if _, exists := envMap[key]; !exists {
			order = append(order, key)
		}
		envMap[key] = value
	}
	for _, entry := range base {
		add(entry)
	}
	for _, entry := range overrides {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		if key == "HOME" && strings.TrimSpace(value) == "" {
			continue
		}
		add(entry)
	}
	out := make([]string, 0, len(order))
	for _, key := range order {
		out = append(out, key+"="+envMap[key])
	}
	return out
}
