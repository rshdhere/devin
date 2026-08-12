package operator

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/rshdhere/devin/infra/internal/awsutil"
	"github.com/rshdhere/devin/infra/internal/envx"
	"github.com/rshdhere/devin/infra/internal/hostpayload"
)

func parseDiscoverAndIDs(args []string) ([]string, error) {
	var ids []string
	discover := false
	for _, a := range args {
		if a == "--discover" {
			discover = true
		} else if strings.HasPrefix(a, "i-") {
			ids = append(ids, a)
		} else {
			return nil, errors.New("usage: [--discover] [i-xxx...]")
		}
	}
	if discover {
		found, err := awsutil.DiscoverExecutionHosts(context.Background(), "")
		if err != nil {
			return nil, err
		}
		ids = append(ids, found...)
	}
	if len(ids) == 0 {
		return nil, errors.New("provide instance IDs or --discover")
	}
	return ids, nil
}

func DiagnoseHost(ctx context.Context, args []string) error {
	ids, err := parseDiscoverAndIDs(args)
	if err != nil {
		return err
	}
	payload := hostpayload.Diagnose()
	var failed int
	for _, id := range ids {
		log.Printf("diagnosing %s", id)
		if err := awsutil.SendAndWait(ctx, envx.Region(""), id, "Diagnose devin execution host", payload, 5*time.Minute, 5*time.Second, true); err != nil {
			log.Print(err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d host(s) failed", failed)
	}
	return nil
}

func FreeHostDisk(ctx context.Context, args []string) error {
	ids, err := parseDiscoverAndIDs(args)
	if err != nil {
		return err
	}
	payload := hostpayload.FreeDisk()
	var failed int
	for _, id := range ids {
		log.Printf("freeing disk on %s", id)
		if err := awsutil.SendAndWait(ctx, envx.Region(""), id, "Free devin execution host disk", payload, 10*time.Minute, 5*time.Second, true); err != nil {
			log.Print(err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d host(s) failed", failed)
	}
	return nil
}

func FixGuestFS(ctx context.Context, args []string) error {
	ids, err := parseDiscoverAndIDs(args)
	if err != nil {
		return err
	}
	runtimes := envx.Env("DEVIN_RUNTIMES", "agent nextjs")
	payload := hostpayload.FixGuestFilesystem(
		runtimes,
		envx.Env("DEVIN_REPO_REF", "main"),
		envx.Env("DEVIN_CONTAINER_IMAGE_TAG", envx.Env("DEVIN_IMAGE_TAG", "latest")),
		envx.Env("DEVIN_CONTAINER_REGISTRY", "docker.io/rshdhere"),
	)
	var failed int
	for _, id := range ids {
		log.Printf("fixing guest filesystem on %s (rebuild runtimes: %s)", id, runtimes)
		if err := awsutil.SendAndWait(ctx, envx.Region(""), id, "Fix devin guest filesystem (rebuild snapshots)", payload, 2*time.Hour, 15*time.Second, true); err != nil {
			log.Print(err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d host(s) failed", failed)
	}
	return nil
}
