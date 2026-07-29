package hostpayload

import "fmt"

// EnsureCLI emits bash that guarantees /usr/local/bin/devin-infra exists.
//
// SSM payloads run on hosts whose userdata predates the Go CLI, so payloads that
// merely check for the binary fail permanently and silently block every deploy.
// Prefer the published devin-infra image, then fall back to building from git.
func EnsureCLI(registry, tag, repoRef string) string {
	if registry == "" {
		registry = "docker.io/rshdhere"
	}
	if tag == "" {
		tag = "latest"
	}
	if repoRef == "" {
		repoRef = "main"
	}
	return fmt.Sprintf(`install_devin_infra() {
  if [ -x /usr/local/bin/devin-infra ]; then
    return 0
  fi
  echo "devin-infra is not installed on this host — installing now" >&2
  for image in %q %q; do
    if ! docker pull "$image" >/dev/null 2>&1; then
      continue
    fi
    docker rm -f devin-infra-extract >/dev/null 2>&1 || true
    if ! docker create --name devin-infra-extract "$image" >/dev/null 2>&1; then
      continue
    fi
    if docker cp devin-infra-extract:/usr/local/bin/devin-infra /usr/local/bin/devin-infra; then
      docker rm -f devin-infra-extract >/dev/null 2>&1 || true
      chmod 755 /usr/local/bin/devin-infra
      echo "installed devin-infra from $image" >&2
      return 0
    fi
    docker rm -f devin-infra-extract >/dev/null 2>&1 || true
  done
  echo "devin-infra image unavailable — building CLI from source" >&2
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y git golang-go
  build=/opt/devin-build
  if [ -d "$build/.git" ]; then
    if ! git -C "$build" fetch --depth 1 origin %q; then
      rm -rf "$build"
    fi
  fi
  if [ -d "$build/.git" ]; then
    git -C "$build" reset --hard FETCH_HEAD
  else
    rm -rf "$build"
    git clone --depth 1 --branch %q https://github.com/rshdhere/devin.git "$build"
  fi
  ( cd "$build/infra" && go build -o /usr/local/bin/devin-infra ./cmd/devin-infra )
  chmod 755 /usr/local/bin/devin-infra
}
install_devin_infra
if [ ! -x /usr/local/bin/devin-infra ]; then
  echo "failed to install devin-infra on this host" >&2
  exit 1
fi
`,
		registry+"/devin-infra:"+tag,
		registry+"/devin-infra:latest",
		repoRef,
		repoRef,
	)
}
