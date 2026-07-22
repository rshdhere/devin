package main

import (
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/rshdhere/devin/apps/runtime/internal/supervisor"
	"github.com/rshdhere/devin/apps/runtime/internal/workspace"
)

func main() {
	port := envInt("RUNTIME_PORT", 8081)
	workspacePath := envString("RUNTIME_WORKSPACE", workspace.DefaultPath())

	if err := workspace.Prepare(workspacePath); err != nil {
		slog.Error("failed to prepare workspace", "error", err)
		os.Exit(1)
	}
	workspace.EnsureEntropy()
	workspace.EnsureDNS()

	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(port),
		Handler:           supervisor.New(workspacePath).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	slog.Info("runtime supervisor listening", "addr", srv.Addr, "workspace", workspacePath)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("runtime supervisor failed", "error", err)
		os.Exit(1)
	}
}

func envInt(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func envString(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
