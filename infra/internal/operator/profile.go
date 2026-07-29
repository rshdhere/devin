package operator

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/rshdhere/devin/infra/internal/envx"
	"github.com/rshdhere/devin/infra/internal/sysutil"
)

func ConfigureProfile(ctx context.Context) error {
	const profile = "devin-infra"
	id, secret := os.Getenv("DEVIN_INFRA_AWS_ACCESS_KEY_ID"), os.Getenv("DEVIN_INFRA_AWS_SECRET_ACCESS_KEY")
	if id == "" || secret == "" {
		for _, path := range credentialPaths() {
			raw, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			for _, line := range strings.Split(string(raw), "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				p := strings.SplitN(line, "=", 2)
				if len(p) != 2 {
					continue
				}
				switch strings.TrimSpace(p[0]) {
				case "DEVIN_INFRA_AWS_ACCESS_KEY_ID":
					id = strings.TrimSpace(p[1])
				case "DEVIN_INFRA_AWS_SECRET_ACCESS_KEY":
					secret = strings.TrimSpace(p[1])
				}
			}
			if id != "" && secret != "" {
				break
			}
		}
	}
	if id == "" || secret == "" {
		return errors.New("set DEVIN_INFRA_AWS_ACCESS_KEY_ID and DEVIN_INFRA_AWS_SECRET_ACCESS_KEY or create infra/devin-infra.credentials")
	}
	if _, err := exec.LookPath("aws"); err == nil {
		for _, args := range [][]string{
			{"configure", "set", "aws_access_key_id", id, "--profile", profile},
			{"configure", "set", "aws_secret_access_key", secret, "--profile", profile},
			{"configure", "set", "region", envx.Region(""), "--profile", profile},
			{"configure", "set", "output", "json", "--profile", profile},
		} {
			if err := sysutil.Command(ctx, "aws", args...); err != nil {
				return err
			}
		}
	} else if err := upsertAWSProfile(profile, id, secret, envx.Region("")); err != nil {
		return err
	}
	cfg, err := config.LoadDefaultConfig(ctx, config.WithSharedConfigProfile(profile), config.WithRegion(envx.Region("")))
	if err != nil {
		return err
	}
	out, err := sts.NewFromConfig(cfg).GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err == nil {
		log.Printf("configured %s for %s", profile, aws.ToString(out.Arn))
	}
	return err
}

func credentialPaths() []string {
	var paths []string
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		paths = append(paths, filepath.Join(dir, "devin-infra.credentials"), filepath.Join(dir, "..", "devin-infra.credentials"))
	}
	if wd, err := os.Getwd(); err == nil {
		paths = append(paths,
			filepath.Join(wd, "devin-infra.credentials"),
			filepath.Join(wd, "infra", "devin-infra.credentials"),
			filepath.Join(wd, "..", "devin-infra.credentials"),
		)
	}
	return paths
}

func upsertAWSProfile(profile, id, secret, r string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(home, ".aws"), 0700); err != nil {
		return err
	}
	if err := upsertINI(filepath.Join(home, ".aws", "credentials"), "["+profile+"]", fmt.Sprintf("aws_access_key_id = %s\naws_secret_access_key = %s\n", id, secret)); err != nil {
		return err
	}
	return upsertINI(filepath.Join(home, ".aws", "config"), "[profile "+profile+"]", fmt.Sprintf("region = %s\noutput = json\n", r))
}

func upsertINI(path, header, body string) error {
	raw, _ := os.ReadFile(path)
	text := string(raw)
	block := header + "\n" + body
	if !strings.HasSuffix(block, "\n") {
		block += "\n"
	}
	if idx := strings.Index(text, header); idx >= 0 {
		rest := text[idx+len(header):]
		end := len(text)
		if next := strings.Index(rest, "\n["); next >= 0 {
			end = idx + len(header) + next + 1
		}
		text = text[:idx] + block + text[end:]
	} else {
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		text += block
	}
	return os.WriteFile(path, []byte(text), 0600)
}
