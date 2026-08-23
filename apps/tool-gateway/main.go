package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	devboxv1 "github.com/rshdhere/devin/apps/tool-gateway/gen/devbox/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	defaultAddr     = ":9095"
	maxOutputBytes  = 8_000
	defaultHTTPWait = 120 * time.Second
)

type server struct {
	devboxv1.UnimplementedDevboxToolsServer
	http *http.Client
}

func main() {
	addr := strings.TrimSpace(os.Getenv("TOOL_GATEWAY_GRPC_ADDR"))
	if addr == "" {
		addr = defaultAddr
	}

	lis, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen %s: %v\n", addr, err)
		os.Exit(1)
	}

	grpcServer := grpc.NewServer()
	devboxv1.RegisterDevboxToolsServer(grpcServer, &server{
		http: &http.Client{Timeout: defaultHTTPWait},
	})

	fmt.Printf("tool-gateway listening on %s\n", addr)
	if err := grpcServer.Serve(lis); err != nil {
		fmt.Fprintf(os.Stderr, "serve: %v\n", err)
		os.Exit(1)
	}
}

func (s *server) Exec(ctx context.Context, req *devboxv1.ExecRequest) (*devboxv1.ExecResponse, error) {
	base, err := requireBase(req.GetRuntimeBaseUrl())
	if err != nil {
		return nil, err
	}
	timeout := time.Duration(req.GetTimeoutSec()) * time.Second
	if timeout <= 0 {
		timeout = defaultHTTPWait
	}
	body := map[string]any{
		"taskId":  req.GetTaskId(),
		"command": req.GetCommand(),
		"cwd":     req.GetCwd(),
	}
	raw, err := s.postJSON(ctx, base, "/terminal", body, timeout)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		ExitCode int    `json:"exitCode"`
		Stdout   string `json:"stdout"`
		Stderr   string `json:"stderr"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, status.Errorf(codes.Internal, "decode terminal: %v", err)
	}
	return &devboxv1.ExecResponse{
		ExitCode: int32(parsed.ExitCode),
		Stdout:   truncate(parsed.Stdout),
		Stderr:   truncate(parsed.Stderr),
	}, nil
}

func (s *server) ReadFile(ctx context.Context, req *devboxv1.ReadFileRequest) (*devboxv1.ReadFileResponse, error) {
	base, err := requireBase(req.GetRuntimeBaseUrl())
	if err != nil {
		return nil, err
	}
	u := fmt.Sprintf("%s/files/read?path=%s", strings.TrimRight(base, "/"), url.QueryEscape(req.GetPath()))
	raw, err := s.get(ctx, u)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Content string `json:"content"`
		Data    string `json:"data"`
		Text    string `json:"text"`
	}
	_ = json.Unmarshal(raw, &parsed)
	content := firstNonEmpty(parsed.Content, parsed.Data, parsed.Text, string(raw))
	return &devboxv1.ReadFileResponse{Content: truncate(content)}, nil
}

func (s *server) WriteFile(ctx context.Context, req *devboxv1.WriteFileRequest) (*devboxv1.WriteFileResponse, error) {
	base, err := requireBase(req.GetRuntimeBaseUrl())
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"path":    req.GetPath(),
		"content": req.GetContent(),
	}
	raw, err := s.postJSON(ctx, base, "/files/write", body, 60*time.Second)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Status string `json:"status"`
		Path   string `json:"path"`
	}
	_ = json.Unmarshal(raw, &parsed)
	return &devboxv1.WriteFileResponse{
		Status: firstNonEmpty(parsed.Status, "ok"),
		Path:   firstNonEmpty(parsed.Path, req.GetPath()),
	}, nil
}

func (s *server) ListDir(ctx context.Context, req *devboxv1.ListDirRequest) (*devboxv1.ListDirResponse, error) {
	base, err := requireBase(req.GetRuntimeBaseUrl())
	if err != nil {
		return nil, err
	}
	u := fmt.Sprintf("%s/files/list?path=%s", strings.TrimRight(base, "/"), url.QueryEscape(req.GetPath()))
	raw, err := s.get(ctx, u)
	if err != nil {
		return nil, err
	}
	var asObj struct {
		Entries []string `json:"entries"`
		Files   []string `json:"files"`
	}
	if json.Unmarshal(raw, &asObj) == nil {
		entries := asObj.Entries
		if len(entries) == 0 {
			entries = asObj.Files
		}
		return &devboxv1.ListDirResponse{Entries: entries}, nil
	}
	var asArr []string
	if json.Unmarshal(raw, &asArr) == nil {
		return &devboxv1.ListDirResponse{Entries: asArr}, nil
	}
	return &devboxv1.ListDirResponse{Entries: []string{truncate(string(raw))}}, nil
}

func (s *server) GitClone(ctx context.Context, req *devboxv1.GitCloneRequest) (*devboxv1.GitResponse, error) {
	base, err := requireBase(req.GetRuntimeBaseUrl())
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"taskId": req.GetTaskId(),
		"url":    req.GetUrl(),
		"path":   req.GetPath(),
	}
	raw, err := s.postJSON(ctx, base, "/git/clone", body, 5*time.Minute)
	if err != nil {
		return nil, err
	}
	return gitResult(raw), nil
}

func (s *server) GitCommit(ctx context.Context, req *devboxv1.GitCommitRequest) (*devboxv1.GitResponse, error) {
	base, err := requireBase(req.GetRuntimeBaseUrl())
	if err != nil {
		return nil, err
	}
	paths := req.GetPaths()
	if len(paths) == 0 {
		paths = []string{"."}
	}
	body := map[string]any{
		"taskId":  req.GetTaskId(),
		"message": req.GetMessage(),
		"cwd":     req.GetCwd(),
		"paths":   paths,
	}
	raw, err := s.postJSON(ctx, base, "/git/commit", body, 2*time.Minute)
	if err != nil {
		return nil, err
	}
	return gitResult(raw), nil
}

func (s *server) GitPush(ctx context.Context, req *devboxv1.GitPushRequest) (*devboxv1.GitResponse, error) {
	base, err := requireBase(req.GetRuntimeBaseUrl())
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"taskId": req.GetTaskId(),
		"branch": req.GetBranch(),
		"cwd":    req.GetCwd(),
	}
	raw, err := s.postJSON(ctx, base, "/git/push", body, 3*time.Minute)
	if err != nil {
		return nil, err
	}
	return gitResult(raw), nil
}

func (s *server) DesktopScreenshot(ctx context.Context, req *devboxv1.DesktopRequest) (*devboxv1.DesktopResponse, error) {
	base, err := requireBase(req.GetRuntimeBaseUrl())
	if err != nil {
		return nil, err
	}
	u := fmt.Sprintf("%s/desktop/screenshot", strings.TrimRight(base, "/"))
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "request: %v", err)
	}
	res, err := s.http.Do(httpReq)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "desktop: %v", err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "read screenshot: %v", err)
	}
	if res.StatusCode >= 300 {
		return nil, status.Errorf(codes.Internal, "desktop HTTP %d: %s", res.StatusCode, truncate(string(data)))
	}
	ct := res.Header.Get("Content-Type")
	if ct == "" {
		ct = "image/png"
	}
	return &devboxv1.DesktopResponse{Png: data, ContentType: ct}, nil
}

func (s *server) BrowserOpen(ctx context.Context, req *devboxv1.BrowserOpenRequest) (*devboxv1.BrowserOpenResponse, error) {
	base, err := requireBase(req.GetRuntimeBaseUrl())
	if err != nil {
		return nil, err
	}
	body := map[string]any{"url": req.GetUrl()}
	raw, err := s.postJSON(ctx, base, "/browser/open", body, 60*time.Second)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(raw, &parsed)
	return &devboxv1.BrowserOpenResponse{Status: firstNonEmpty(parsed.Status, "ok")}, nil
}

func (s *server) postJSON(ctx context.Context, base, path string, body map[string]any, timeout time.Duration) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "marshal: %v", err)
	}
	u := strings.TrimRight(base, "/") + path
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(reqCtx, http.MethodPost, u, bytes.NewReader(payload))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "request: %v", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	res, err := s.http.Do(httpReq)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "%s: %v", path, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "read body: %v", err)
	}
	if res.StatusCode >= 300 {
		return nil, status.Errorf(codes.Internal, "%s HTTP %d: %s", path, res.StatusCode, truncate(string(data)))
	}
	return data, nil
}

func (s *server) get(ctx context.Context, u string) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "request: %v", err)
	}
	res, err := s.http.Do(httpReq)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "get: %v", err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "read body: %v", err)
	}
	if res.StatusCode >= 300 {
		return nil, status.Errorf(codes.Internal, "HTTP %d: %s", res.StatusCode, truncate(string(data)))
	}
	return data, nil
}

func requireBase(base string) (string, error) {
	base = strings.TrimSpace(base)
	if base == "" {
		return "", status.Error(codes.InvalidArgument, "runtime_base_url is required")
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return "", status.Error(codes.InvalidArgument, "runtime_base_url must be http(s)")
	}
	return base, nil
}

func gitResult(raw []byte) *devboxv1.GitResponse {
	var parsed struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(raw, &parsed)
	return &devboxv1.GitResponse{
		Status:  firstNonEmpty(parsed.Status, "ok"),
		Message: firstNonEmpty(parsed.Message, truncate(string(raw))),
	}
}

func truncate(value string) string {
	if len(value) <= maxOutputBytes {
		return value
	}
	return value[:maxOutputBytes] + "\n… (truncated)"
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
