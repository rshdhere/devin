package host

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/rshdhere/devin/infra/internal/awsutil"
	"github.com/rshdhere/devin/infra/internal/envx"
	"github.com/rshdhere/devin/infra/internal/sysutil"
)

func SyncPlatformConfig(ctx context.Context) error {
	if err := sysutil.MustRoot(); err != nil {
		return err
	}
	cfg, err := awsutil.Config(ctx, "")
	if err != nil {
		return err
	}
	client := ssm.NewFromConfig(cfg)
	read := func(key string) string {
		out, e := client.GetParameter(ctx, &ssm.GetParameterInput{
			Name:           aws.String(envx.Prefix() + "/" + key),
			WithDecryption: aws.Bool(true),
		})
		if e != nil {
			log.Printf("SSM %s: %v", key, e)
			return ""
		}
		return aws.ToString(out.Parameter.Value)
	}
	orchestrator, queue := read("orchestrator_url"), read("task_queue_url")
	hostName := read("scheduler_host_name")
	if hostName == "" {
		if b, e := os.ReadFile("/etc/devin/host-name"); e == nil {
			hostName = strings.TrimSpace(string(b))
		}
	}
	if hostName == "" {
		hostName = envx.Env("DEVIN_HOST_NAME", "")
	}
	if hostName != "" {
		if err := sysutil.WriteFile("/etc/devin/host-name", hostName+"\n", 0644); err != nil {
			return err
		}
		if err := sysutil.WriteFile("/etc/systemd/system/devin-scheduler.service.d/host.conf", fmt.Sprintf("[Service]\nEnvironment=SCHEDULER_HOST_NAME=%s\nEnvironment=FIRECRACKER_HOST_NAME=%s\n", hostName, hostName), 0644); err != nil {
			return err
		}
	}
	if orchestrator != "" && !strings.HasPrefix(orchestrator, "http://REPLACE_AFTER_ORCHESTRATOR_NLB:") {
		if err := sysutil.WriteFile("/etc/systemd/system/devin-scheduler.service.d/orchestrator.conf", "[Service]\nEnvironment=ORCHESTRATOR_URL="+orchestrator+"\n", 0644); err != nil {
			return err
		}
	}
	if queue != "" {
		if err := sysutil.WriteFile("/etc/systemd/system/devin-scheduler.service.d/queue.conf", fmt.Sprintf("[Service]\nEnvironment=QUEUE_DRIVER=sqs\nEnvironment=SQS_QUEUE_URL=%s\nEnvironment=AWS_REGION=%s\n", queue, envx.Region("")), 0644); err != nil {
			return err
		}
	} else {
		_ = os.Remove("/etc/systemd/system/devin-scheduler.service.d/queue.conf")
	}
	secrets := fmt.Sprintf("DEFAULT_AGENT=cursor\nSERVICE_MODE=worker\nCURSOR_API_KEY=%s\nANTHROPIC_API_KEY=%s\nOPENAI_API_KEY=%s\nGITHUB_BOT_TOKEN=%s\nGITHUB_BOT_NAME=baby-devin-bot\nGITHUB_BOT_EMAIL=baby-devin-bot@users.noreply.github.com\nAGENT_RUN_TIMEOUT_MIN=60\n", read("cursor_api_key"), read("anthropic_api_key"), read("openai_api_key"), read("github_bot_token"))
	if db := read("database_url"); db != "" {
		secrets += "DATABASE_URL=" + db + "\n"
	}
	if err := sysutil.WriteFile("/etc/devin/scheduler-secrets.env", secrets, 0600); err != nil {
		return err
	}
	if err := sysutil.WriteFile("/etc/systemd/system/devin-scheduler.service.d/secrets.conf", "[Service]\nEnvironmentFile=/etc/devin/scheduler-secrets.env\n", 0644); err != nil {
		return err
	}
	_ = sysutil.Systemctl(ctx, "daemon-reload")
	_ = sysutil.Systemctl(ctx, "enable", "--now", "devin-firecracker.service")
	_ = sysutil.Systemctl(ctx, "enable", "--now", "devin-scheduler.service")
	_ = sysutil.Systemctl(ctx, "restart", "devin-scheduler.service")
	if orchestrator != "" && hostName != "" {
		_ = registerHost(ctx, orchestrator, hostName)
	}
	return nil
}

func registerHost(ctx context.Context, url, hostName string) error {
	ip := envx.Env("EXECUTION_HOST_PRIVATE_IP", "")
	if ip == "" {
		out, err := exec.CommandContext(ctx, "hostname", "-I").Output()
		if err == nil {
			ip = strings.Fields(string(out))[0]
		}
	}
	if ip == "" {
		return fmt.Errorf("cannot determine host IP")
	}
	body, _ := json.Marshal(map[string]any{
		"spec": map[string]any{
			"address":          "http://" + ip + ":9092",
			"schedulerAddress": "http://" + ip + ":9091",
			"capacity":         map[string]string{"cpu": "8", "memory": "16Gi"},
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, strings.TrimSuffix(url, "/")+"/internal/v1/firecracker-hosts/"+hostName, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return fmt.Errorf("host registration returned %s", res.Status)
	}
	return nil
}
