package operator

import (
	"context"
	"errors"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
	"github.com/rshdhere/devin/infra/internal/awsutil"
	"github.com/rshdhere/devin/infra/internal/envx"
)

func SetSecret(ctx context.Context, args []string) error {
	if len(args) < 1 || len(args) > 2 {
		return errors.New("usage: set-platform-secret <key> [value]")
	}
	keys := map[string]string{
		"cursor_api_key":    "CURSOR_API_KEY",
		"anthropic_api_key": "ANTHROPIC_API_KEY",
		"openai_api_key":    "OPENAI_API_KEY",
		"github_bot_token":  "GITHUB_BOT_TOKEN",
		"agent_model":       "AGENT_MODEL",
	}
	envKey, ok := keys[args[0]]
	if !ok {
		return errors.New("unknown secret")
	}
	value := os.Getenv(envKey)
	if len(args) == 2 {
		value = args[1]
	}
	if value == "" {
		return errors.New("secret value is empty; pass it as an argument or environment variable")
	}
	cfg, err := awsutil.Config(ctx, "")
	if err != nil {
		return err
	}
	_, err = ssm.NewFromConfig(cfg).PutParameter(ctx, &ssm.PutParameterInput{
		Name:      aws.String(envx.Prefix() + "/" + args[0]),
		Value:     &value,
		Type:      ssmtypes.ParameterTypeSecureString,
		Overwrite: aws.Bool(true),
	})
	return err
}
