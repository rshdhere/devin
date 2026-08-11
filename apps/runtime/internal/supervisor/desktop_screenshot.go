package supervisor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/rshdhere/devin/apps/runtime/internal/executil"
	"github.com/rshdhere/devin/apps/runtime/internal/workspace"
)

func chromiumExecutable() string {
	for _, candidate := range []string{
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/google-chrome-stable",
	} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "chromium"
}

func jsonString(s string) string {
	return fmt.Sprintf("%q", s)
}

func (s *Server) runPlaywrightScreenshot(
	ctx context.Context,
	targetURL, outPath string,
) (*executil.Result, error) {
	home := workspace.WritableHome(s.workspace)
	scriptPath := filepath.Join(home, "desktop-screenshot.mjs")
	scriptBody := fmt.Sprintf(
		`import { chromium } from 'playwright-core';
const url = %s;
const out = %s;
const executablePath = process.env.CHROMIUM_PATH || %s;
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: out, fullPage: false, type: 'png' });
await browser.close();
`,
		jsonString(targetURL),
		jsonString(outPath),
		jsonString(chromiumExecutable()),
	)
	if err := os.WriteFile(scriptPath, []byte(scriptBody), 0o644); err != nil {
		return nil, err
	}

	env := workspace.DevinProcessEnv(s.workspace)
	env = append(env, "NODE_PATH=/usr/local/lib/node_modules")
	env = append(env, "CHROMIUM_PATH="+chromiumExecutable())

	return executil.RunGuest(
		ctx,
		s.workspace,
		fmt.Sprintf("node %s", shellQuote(scriptPath)),
		env,
		nil,
	)
}

func (s *Server) runChromiumCLIScreenshot(
	ctx context.Context,
	targetURL, outPath string,
) (*executil.Result, error) {
	chrome := chromiumExecutable()
	script := fmt.Sprintf(
		"set -e; %s --headless --disable-gpu --no-sandbox --window-size=1024,768 --hide-scrollbars --run-all-compositor-stages-before-draw --virtual-time-budget=10000 --screenshot=%s %s",
		shellQuote(chrome),
		shellQuote(outPath),
		shellQuote(targetURL),
	)
	return executil.RunGuest(
		ctx,
		s.workspace,
		script,
		workspace.DevinProcessEnv(s.workspace),
		nil,
	)
}

func (s *Server) captureDesktopScreenshotToFile(
	ctx context.Context,
	targetURL, outPath string,
) error {
	// Prefer Chromium CLI first — Playwright networkidle used to hang forever on
	// Next.js HMR websockets. CLI is bounded and good enough for sandbox previews.
	result, err := s.runChromiumCLIScreenshot(ctx, targetURL, outPath)
	if err == nil && result.ExitCode == 0 {
		if data, readErr := os.ReadFile(outPath); readErr == nil && len(data) > 128 {
			return nil
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	result, err = s.runPlaywrightScreenshot(ctx, targetURL, outPath)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("%s", executil.CombinedOutput(result))
	}
	if data, readErr := os.ReadFile(outPath); readErr != nil || len(data) < 128 {
		if readErr != nil {
			return readErr
		}
		return fmt.Errorf("screenshot file empty")
	}
	return nil
}
