package operator

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/rshdhere/devin/infra/internal/awsutil"
	"github.com/rshdhere/devin/infra/internal/envx"
	"github.com/rshdhere/devin/infra/internal/hostpayload"
)

func DeployImages(ctx context.Context, args []string) error {
	var ids []string
	discover := false
	for _, a := range args {
		if a == "--discover" {
			discover = true
		} else if strings.HasPrefix(a, "i-") {
			ids = append(ids, a)
		} else {
			return errors.New("usage: deploy-images [--discover] [i-xxx...]")
		}
	}
	r := envx.Region("")
	if discover {
		cfg, err := awsutil.Config(ctx, r)
		if err != nil {
			return err
		}
		out, err := ec2.NewFromConfig(cfg).DescribeInstances(ctx, &ec2.DescribeInstancesInput{
			Filters: []ec2types.Filter{
				{Name: aws.String("tag:Role"), Values: []string{"firecracker-execution-host"}},
				{Name: aws.String("instance-state-name"), Values: []string{"running"}},
			},
		})
		if err != nil {
			return err
		}
		for _, res := range out.Reservations {
			for _, in := range res.Instances {
				ids = append(ids, aws.ToString(in.InstanceId))
			}
		}
	}
	if len(ids) == 0 {
		return errors.New("provide instance IDs or --discover")
	}
	timeout, err := time.ParseDuration(envx.Env("SSM_TIMEOUT_SECONDS", "600") + "s")
	if err != nil {
		return err
	}
	payload := hostpayload.Deploy(
		envx.Env("DEVIN_CONTAINER_REGISTRY", "docker.io/rshdhere"),
		envx.Env("DEVIN_IMAGE_TAG", "latest"),
		r,
		envx.Prefix(),
	)
	var failed int
	for _, id := range ids {
		log.Printf("deploying to %s", id)
		if err := awsutil.SendAndWait(ctx, r, id, "Deploy devin execution host images", payload, timeout, 10*time.Second, true); err != nil {
			log.Print(err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d host(s) failed", failed)
	}
	return nil
}

func Bootstrap(ctx context.Context, args []string, agent bool) error {
	id, r, err := awsutil.ArgsIDRegion(args)
	if err != nil {
		return err
	}
	runtimes := envx.Env("DEVIN_RUNTIMES", "nextjs agent node go rust python")
	force := envx.Env("DEVIN_FORCE_SNAPSHOT_REBUILD", "false")
	if agent {
		runtimes = "agent"
		force = "true"
	}
	payload := hostpayload.BootstrapSnapshots(
		runtimes,
		force,
		envx.Env("DEVIN_REPO_REF", "main"),
		envx.Env("DEVIN_CONTAINER_IMAGE_TAG", envx.Env("DEVIN_IMAGE_TAG", "latest")),
	)
	return awsutil.SendAndWait(ctx, r, id, "Bootstrap devin Firecracker snapshots", payload, 2*time.Hour, 15*time.Second, true)
}

func SyncHost(ctx context.Context, args []string) error {
	if len(args) < 1 || len(args) > 3 {
		return errors.New("usage: sync-host-config <instance-id> [region] [ssm-prefix]")
	}
	r := ""
	if len(args) > 1 {
		r = args[1]
	}
	p := envx.Prefix()
	if len(args) > 2 {
		p = args[2]
	}
	return awsutil.SendAndWait(
		ctx,
		envx.Region(r),
		args[0],
		"Sync devin platform config",
		hostpayload.SyncPlatformConfig(envx.Region(r), p),
		10*time.Minute,
		10*time.Second,
		false,
	)
}

func Rebootstrap(ctx context.Context, args []string) error {
	id, r, err := awsutil.ArgsIDRegion(args)
	if err != nil {
		return err
	}
	payload := hostpayload.Rebootstrap(
		envx.Env("DEVIN_HOST_NAME", "devin-production-fc-01"),
		envx.Env("DEVIN_CONTAINER_REGISTRY", "docker.io/rshdhere"),
		envx.Env("DEVIN_IMAGE_TAG", "latest"),
		r,
		envx.Prefix(),
	)
	return awsutil.SendAndWait(ctx, r, id, "Rebootstrap devin execution host", payload, 15*time.Minute, 10*time.Second, true)
}
