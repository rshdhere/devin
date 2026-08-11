package awsutil

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/rshdhere/devin/infra/internal/envx"
)

// DiscoverExecutionHosts returns running EC2 instance IDs tagged Role=firecracker-execution-host.
func DiscoverExecutionHosts(ctx context.Context, r string) ([]string, error) {
	cfg, err := Config(ctx, envx.Region(r))
	if err != nil {
		return nil, err
	}
	out, err := ec2.NewFromConfig(cfg).DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		Filters: []ec2types.Filter{
			{Name: aws.String("tag:Role"), Values: []string{"firecracker-execution-host"}},
			{Name: aws.String("instance-state-name"), Values: []string{"running"}},
		},
	})
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, res := range out.Reservations {
		for _, in := range res.Instances {
			ids = append(ids, aws.ToString(in.InstanceId))
		}
	}
	return ids, nil
}
