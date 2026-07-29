package hostpayload

import "fmt"

// EnsureCLI emits bash that installs or refreshes /usr/local/bin/devin-infra.
//
// SSM payloads run on hosts whose userdata predates the Go CLI, and on hosts
// that already have a stale binary from an earlier deploy. Always prefer the
// published image for the requested tag so host-deploy picks up payload fixes.
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
  primary=%q
  fallback=%q
  for image in "$primary" "$fallback"; do
    [ -n "$image" ] || continue
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
      echo "installed/refreshed devin-infra from $image" >&2
      return 0
    fi
    docker rm -f devin-infra-extract >/dev/null 2>&1 || true
  done
  if [ -x /usr/local/bin/devin-infra ]; then
    echo "warning: could not refresh devin-infra from image; using existing binary" >&2
    return 0
  fi
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
