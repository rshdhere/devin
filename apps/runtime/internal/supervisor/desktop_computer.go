package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rshdhere/devin/apps/runtime/internal/executil"
	"github.com/rshdhere/devin/apps/runtime/internal/workspace"
)

const (
	desktopDisplayNum = 99
	desktopWidth      = 1024
	desktopHeight     = 768
	vncRFBPort        = 5900
	novncWebPort      = 6080
	cdpDebugPort      = 29229
)

var vncUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type desktopStatus struct {
	Xvfb      bool `json:"xvfb"`
	VNC       bool `json:"vnc"`
	NoVNC     bool `json:"novnc"`
	CDP       bool `json:"cdp"`
	Recording bool `json:"recording"`
	Display   int  `json:"display"`
	CDPPort   int  `json:"cdpPort"`
}

func desktopHome(workspaceRoot string) string {
	return workspace.WritableHome(workspaceRoot)
}

func desktopPIDPath(workspaceRoot, name string) string {
	return filepath.Join(desktopHome(workspaceRoot), "desktop-"+name+".pid")
}

func desktopLogPath(workspaceRoot, name string) string {
	return filepath.Join(desktopHome(workspaceRoot), "desktop-"+name+".log")
}

func recordingPath(workspaceRoot string) string {
	return filepath.Join(desktopHome(workspaceRoot), "session-recording.webm")
}

func displayEnv(workspaceRoot string) []string {
	env := workspace.DevinProcessEnv(workspaceRoot)
	return append(env, fmt.Sprintf("DISPLAY=:%d", desktopDisplayNum))
}

func pidAlive(pidPath string) bool {
	data, err := os.ReadFile(pidPath)
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return false
	}
	if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); err == nil {
		return true
	}
	return false
}

func portOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func (s *Server) desktopStatusLocked() desktopStatus {
	return desktopStatus{
		Xvfb:      pidAlive(desktopPIDPath(s.workspace, "xvfb")),
		VNC:       pidAlive(desktopPIDPath(s.workspace, "vnc")) || portOpen(vncRFBPort),
		NoVNC:     pidAlive(desktopPIDPath(s.workspace, "novnc")) || portOpen(novncWebPort),
		CDP:       pidAlive(desktopPIDPath(s.workspace, "cdp")) || portOpen(cdpDebugPort),
		Recording: pidAlive(desktopPIDPath(s.workspace, "recording")),
		Display:   desktopDisplayNum,
		CDPPort:   cdpDebugPort,
	}
}

func (s *Server) handleDesktopStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.desktopStatusLocked())
}

func (s *Server) navigateCDPBrowser(ctx context.Context, targetURL string) error {
	if !portOpen(cdpDebugPort) {
		if err := s.ensureDesktopComputer(ctx); err != nil {
			return err
		}
	}
	home := desktopHome(s.workspace)
	scriptPath := filepath.Join(home, "desktop-cdp-navigate.mjs")
	scriptBody := fmt.Sprintf(
		`import { chromium } from 'playwright-core';
const url = %s;
const cdp = 'http://127.0.0.1:%d';
const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0] ?? await browser.newContext({ viewport: { width: %d, height: %d } });
const page = context.pages()[0] ?? await context.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
await page.waitForTimeout(800);
`,
		jsonString(targetURL),
		cdpDebugPort,
		desktopWidth,
		desktopHeight,
	)
	if err := os.WriteFile(scriptPath, []byte(scriptBody), 0o644); err != nil {
		return err
	}
	env := displayEnv(s.workspace)
	env = append(env, "NODE_PATH=/usr/local/lib/node_modules")
	result, err := executil.RunGuest(
		ctx,
		s.workspace,
		fmt.Sprintf("node %s", shellQuote(scriptPath)),
		env,
		nil,
	)
	if err != nil {
		return err
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("%s", executil.CombinedOutput(result))
	}
	return nil
}

func (s *Server) handleDesktopNavigate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.URL) == "" {
		writeError(w, http.StatusBadRequest, "url is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.navigateCDPBrowser(ctx, strings.TrimSpace(body.URL)); err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleDesktopEnsure(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	if err := s.ensureDesktopComputer(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.desktopStatusLocked())
}

func (s *Server) ensureDesktopComputer(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_ = os.MkdirAll(desktopHome(s.workspace), 0o755)

	if !pidAlive(desktopPIDPath(s.workspace, "xvfb")) {
		script := fmt.Sprintf(
			"set -e; nohup Xvfb :%d -screen 0 %dx%dx24 -ac +extension GLX +render -noreset >>%s 2>&1 & echo $! > %s",
			desktopDisplayNum,
			desktopWidth,
			desktopHeight,
			shellQuote(desktopLogPath(s.workspace, "xvfb")),
			shellQuote(desktopPIDPath(s.workspace, "xvfb")),
		)
		if _, err := executil.RunGuest(ctx, s.workspace, script, workspace.DevinProcessEnv(s.workspace), nil); err != nil {
			return fmt.Errorf("start Xvfb: %w", err)
		}
		time.Sleep(600 * time.Millisecond)
	}

	if !pidAlive(desktopPIDPath(s.workspace, "vnc")) && !portOpen(vncRFBPort) {
		script := fmt.Sprintf(
			"set -e; export DISPLAY=:%d; nohup x11vnc -display :%d -forever -shared -rfbport %d -nopw -noxdamage >>%s 2>&1 & echo $! > %s",
			desktopDisplayNum,
			desktopDisplayNum,
			vncRFBPort,
			shellQuote(desktopLogPath(s.workspace, "vnc")),
			shellQuote(desktopPIDPath(s.workspace, "vnc")),
		)
		if _, err := executil.RunGuest(ctx, s.workspace, script, displayEnv(s.workspace), nil); err != nil {
			return fmt.Errorf("start x11vnc: %w", err)
		}
		time.Sleep(400 * time.Millisecond)
	}

	if !pidAlive(desktopPIDPath(s.workspace, "novnc")) && !portOpen(novncWebPort) {
		script := fmt.Sprintf(
			"set -e; if command -v websockify >/dev/null 2>&1; then WS=websockify; elif command -v websockify.py >/dev/null 2>&1; then WS=websockify.py; else echo 'websockify missing' >&2; exit 1; fi; nohup $WS --web /usr/share/novnc %d 127.0.0.1:%d >>%s 2>&1 & echo $! > %s",
			novncWebPort,
			vncRFBPort,
			shellQuote(desktopLogPath(s.workspace, "novnc")),
			shellQuote(desktopPIDPath(s.workspace, "novnc")),
		)
		if _, err := executil.RunGuest(ctx, s.workspace, script, workspace.DevinProcessEnv(s.workspace), nil); err != nil {
			return fmt.Errorf("start websockify: %w", err)
		}
		time.Sleep(400 * time.Millisecond)
	}

	if !pidAlive(desktopPIDPath(s.workspace, "cdp")) && !portOpen(cdpDebugPort) {
		chrome := chromiumExecutable()
		script := fmt.Sprintf(
			"set -e; export DISPLAY=:%d; nohup %s --remote-debugging-port=%d --remote-debugging-address=127.0.0.1 --window-size=%d,%d --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage about:blank >>%s 2>&1 & echo $! > %s",
			desktopDisplayNum,
			shellQuote(chrome),
			cdpDebugPort,
			desktopWidth,
			desktopHeight,
			shellQuote(desktopLogPath(s.workspace, "cdp")),
			shellQuote(desktopPIDPath(s.workspace, "cdp")),
		)
		if _, err := executil.RunGuest(ctx, s.workspace, script, displayEnv(s.workspace), nil); err != nil {
			return fmt.Errorf("start CDP browser: %w", err)
		}
		time.Sleep(800 * time.Millisecond)
	}

	return nil
}

func (s *Server) handleDesktopVNCPage(w http.ResponseWriter, r *http.Request) {
	page := `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Devbox Desktop</title>
<style>html,body{margin:0;height:100%;background:#111;overflow:hidden}#screen{width:100%;height:100%}</style>
</head><body>
<div id="screen"></div>
<script type="module">
import RFB from 'https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/core/rfb.js';
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsPath = location.pathname.replace(/\/?$/, '/ws');
const url = proto + '//' + location.host + wsPath;
const rfb = new RFB(document.getElementById('screen'), url, { scaleViewport: true, resizeSession: false });
rfb.viewOnly = false;
rfb.focusOnClick = true;
rfb.clipViewport = false;
rfb.scaleViewport = true;
</script>
</body></html>`
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(page))
}

func (s *Server) handleDesktopVNCWebSocket(w http.ResponseWriter, r *http.Request) {
	clientConn, err := vncUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer clientConn.Close()

	backendURL := fmt.Sprintf("ws://127.0.0.1:%d/websockify", novncWebPort)
	backendConn, _, err := websocket.DefaultDialer.Dial(backendURL, nil)
	if err != nil {
		backendConn, _, err = websocket.DefaultDialer.Dial(
			fmt.Sprintf("ws://127.0.0.1:%d", novncWebPort),
			nil,
		)
	}
	if err != nil {
		_ = clientConn.WriteMessage(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "novnc not ready"),
		)
		return
	}
	defer backendConn.Close()
	bridgeWebSocketPair(clientConn, backendConn)
}

func bridgeWebSocketPair(a, b *websocket.Conn) {
	var wg sync.WaitGroup
	copyWS := func(dst, src *websocket.Conn) {
		defer wg.Done()
		for {
			msgType, msg, err := src.ReadMessage()
			if err != nil {
				return
			}
			if err := dst.WriteMessage(msgType, msg); err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go copyWS(a, b)
	go copyWS(b, a)
	wg.Wait()
}

func (s *Server) handleBrowserCDPJSON(w http.ResponseWriter, r *http.Request) {
	subpath := strings.TrimPrefix(r.URL.Path, "/browser/cdp/")
	if subpath == "" || subpath == "/" {
		subpath = "json"
	}
	target := fmt.Sprintf("http://127.0.0.1:%d/%s", cdpDebugPort, subpath)
	if raw := strings.TrimSpace(r.URL.RawQuery); raw != "" {
		target += "?" + raw
	}
	tmpDir := desktopHome(s.workspace)
	bodyPath := filepath.Join(tmpDir, "cdp-body.tmp")
	hdrPath := filepath.Join(tmpDir, "cdp-hdr.tmp")
	script := fmt.Sprintf(
		"curl -sS -D %s -o %s --max-time 8 %s",
		shellQuote(hdrPath),
		shellQuote(bodyPath),
		shellQuote(target),
	)
	result, err := executil.RunGuest(
		r.Context(),
		s.workspace,
		script,
		workspace.DevinProcessEnv(s.workspace),
		nil,
	)
	if err != nil || result.ExitCode != 0 {
		writeError(w, http.StatusBadGateway, "CDP browser not reachable on port 29229")
		return
	}
	bodyBytes, err := os.ReadFile(bodyPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(bodyBytes)
}

func (s *Server) handleRecordingStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.ensureDesktopComputer(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	if pidAlive(desktopPIDPath(s.workspace, "recording")) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "already_recording"})
		return
	}
	out := recordingPath(s.workspace)
	script := fmt.Sprintf(
		"set -e; export DISPLAY=:%d; rm -f %s; if command -v ffmpeg >/dev/null 2>&1; then nohup ffmpeg -y -f x11grab -video_size %dx%d -framerate 12 -i :%d.0 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 %s >>%s 2>&1 & echo $! > %s; else exit 1; fi",
		desktopDisplayNum,
		shellQuote(out),
		desktopWidth,
		desktopHeight,
		desktopDisplayNum,
		shellQuote(out),
		shellQuote(desktopLogPath(s.workspace, "recording")),
		shellQuote(desktopPIDPath(s.workspace, "recording")),
	)
	result, err := executil.RunGuest(ctx, s.workspace, script, displayEnv(s.workspace), nil)
	if err != nil || result.ExitCode != 0 {
		writeError(w, http.StatusServiceUnavailable, "ffmpeg recording unavailable in snapshot")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "recording"})
}

func (s *Server) handleRecordingStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	pidPath := desktopPIDPath(s.workspace, "recording")
	if pidAlive(pidPath) {
		data, _ := os.ReadFile(pidPath)
		pid := strings.TrimSpace(string(data))
		script := fmt.Sprintf(
			"kill -INT %s 2>/dev/null || true; for i in $(seq 1 20); do kill -0 %s 2>/dev/null || break; sleep 0.25; done; kill -TERM %s 2>/dev/null || true; rm -f %s",
			shellQuote(pid),
			shellQuote(pid),
			shellQuote(pid),
			shellQuote(pidPath),
		)
		_, _ = executil.RunGuest(r.Context(), s.workspace, script, workspace.DevinProcessEnv(s.workspace), nil)
		time.Sleep(750 * time.Millisecond)
	}
	out := recordingPath(s.workspace)
	var info os.FileInfo
	var err error
	for attempt := 0; attempt < 8; attempt++ {
		info, err = os.Stat(out)
		if err == nil && info.Size() >= 1024 {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if err != nil || info == nil || info.Size() < 1024 {
		writeError(w, http.StatusNotFound, "no session recording saved yet")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "stopped",
		"bytes":  info.Size(),
		"path":   out,
	})
}

func (s *Server) handleRecordingGet(w http.ResponseWriter, r *http.Request) {
	out := recordingPath(s.workspace)
	data, err := os.ReadFile(out)
	if err != nil || len(data) < 1024 {
		writeError(w, http.StatusNotFound, "no session recording saved yet")
		return
	}
	w.Header().Set("Content-Type", "video/webm")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
