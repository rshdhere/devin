package vm

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	firecracker "github.com/firecracker-microvm/firecracker-go-sdk"

	"github.com/rshdhere/devin/apps/firecracker/internal/cnihelper"
)

type Instance struct {
	ID         string
	Name       string
	Runtime    string
	IP         net.IP
	RuntimeURL string
	Phase      string
	Message    string

	machine   *firecracker.Machine
	cancel    context.CancelFunc
	cniConfig cnihelper.Config
}

func (i *Instance) HealthCheck(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, i.RuntimeURL+"/health", nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("runtime health returned %s", resp.Status)
	}
	return nil
}

func (i *Instance) Shutdown(ctx context.Context) error {
	if i.cancel != nil {
		i.cancel()
	}
	var stopErr error
	if i.machine != nil {
		stopErr = i.machine.StopVMM()
	}
	cniCfg := i.cniConfig
	if cniCfg.GuestIP == "" && i.IP != nil {
		cniCfg.GuestIP = i.IP.String()
	}
	if err := cnihelper.Delete(ctx, i.ID, cniCfg); err != nil {
		slog.Warn("failed to release cni network", "vmId", i.ID, "error", err)
		if stopErr == nil {
			stopErr = err
		}
	}
	_ = os.Remove(filepath.Join("/var/run/netns", i.ID))
	return stopErr
}
