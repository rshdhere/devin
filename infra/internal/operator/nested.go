package operator

import (
	"context"
	"errors"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/rshdhere/devin/infra/internal/awsutil"
)

func NestedVirt(ctx context.Context, args []string) error {
	id, r, err := awsutil.ArgsIDRegion(args)
	if err != nil {
		return err
	}
	cfg, err := awsutil.Config(ctx, r)
	if err != nil {
		return err
	}
	c := ec2.NewFromConfig(cfg)
	out, err := c.DescribeInstances(ctx, &ec2.DescribeInstancesInput{InstanceIds: []string{id}})
	if err != nil {
		return err
	}
	if len(out.Reservations) == 0 || len(out.Reservations[0].Instances) == 0 {
		return errors.New("instance not found")
	}
	instance := out.Reservations[0].Instances[0]
	if instance.State.Name != ec2types.InstanceStateNameStopped {
		if _, err := c.StopInstances(ctx, &ec2.StopInstancesInput{InstanceIds: []string{id}}); err != nil {
			return err
		}
		if err := ec2.NewInstanceStoppedWaiter(c).Wait(ctx, &ec2.DescribeInstancesInput{InstanceIds: []string{id}}, 10*time.Minute); err != nil {
			return err
		}
	}
	_, err = c.ModifyInstanceCpuOptions(ctx, &ec2.ModifyInstanceCpuOptionsInput{
		InstanceId:           &id,
		CoreCount:            instance.CpuOptions.CoreCount,
		ThreadsPerCore:       instance.CpuOptions.ThreadsPerCore,
		NestedVirtualization: "enabled",
	})
	if err != nil {
		return err
	}
	if _, err = c.StartInstances(ctx, &ec2.StartInstancesInput{InstanceIds: []string{id}}); err != nil {
		return err
	}
	return ec2.NewInstanceRunningWaiter(c).Wait(ctx, &ec2.DescribeInstancesInput{InstanceIds: []string{id}}, 10*time.Minute)
}
