package awsutil

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
	"github.com/rshdhere/devin/infra/internal/envx"
)

func Config(ctx context.Context, r string) (aws.Config, error) {
	return config.LoadDefaultConfig(ctx, config.WithRegion(envx.Region(r)))
}

func ArgsIDRegion(args []string) (string, string, error) {
	if len(args) < 1 || len(args) > 2 {
		return "", "", errors.New("usage: <instance-id> [region]")
	}
	r := ""
	if len(args) == 2 {
		r = args[1]
	}
	return args[0], envx.Region(r), nil
}

func SendAndWait(ctx context.Context, r, id, comment, payload string, timeout, poll time.Duration, wait bool) error {
	cfg, err := Config(ctx, r)
	if err != nil {
		return err
	}
	client := ssm.NewFromConfig(cfg)
	seconds := int32(timeout.Seconds())
	out, err := client.SendCommand(ctx, &ssm.SendCommandInput{
		InstanceIds:    []string{id},
		DocumentName:   aws.String("AWS-RunShellScript"),
		Comment:        aws.String(comment),
		TimeoutSeconds: &seconds,
		Parameters:     map[string][]string{"commands": {payload}},
	})
	if err != nil {
		return err
	}
	commandID := aws.ToString(out.Command.CommandId)
	log.Printf("CommandId: %s", commandID)
	if !wait {
		return nil
	}
	if poll <= 0 {
		poll = 10 * time.Second
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(poll)
		inv, err := client.GetCommandInvocation(ctx, &ssm.GetCommandInvocationInput{
			CommandId:  &commandID,
			InstanceId: &id,
		})
		if err != nil {
			var doesNotExist *ssmtypes.InvocationDoesNotExist
			if errors.As(err, &doesNotExist) {
				continue
			}
			return err
		}
		switch inv.Status {
		case ssmtypes.CommandInvocationStatusSuccess:
			fmt.Print(aws.ToString(inv.StandardOutputContent))
			if s := aws.ToString(inv.StandardErrorContent); s != "" {
				fmt.Fprint(os.Stderr, s)
			}
			return nil
		case ssmtypes.CommandInvocationStatusFailed, ssmtypes.CommandInvocationStatusCancelled, ssmtypes.CommandInvocationStatusTimedOut:
			fmt.Fprint(os.Stderr, aws.ToString(inv.StandardOutputContent))
			fmt.Fprint(os.Stderr, aws.ToString(inv.StandardErrorContent))
			return fmt.Errorf("SSM command %s ended with %s", commandID, inv.Status)
		}
	}
	return fmt.Errorf("timed out waiting for SSM command %s", commandID)
}
